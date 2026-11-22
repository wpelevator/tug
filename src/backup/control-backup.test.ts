import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  controlRepository,
  controlRepositoryPassword,
  checkControlRepository,
  checkRepository,
  unlockControlRepository,
  fetchControlArchive,
  listControlSnapshots,
  pushControlArchive,
} from './control-backup.ts';
import { repositoryPassword } from './destination.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AttachedProcess } from '../docker-api.ts';

const S3 = {
  url: 's3:https://s3.example.com/bucket/tug/',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
  password: controlRepositoryPassword('master-key-1'),
  resticImage: 'restic/restic:0.17.3',
};
const dockerWith = (responder: FakeDocker['execResponder']): FakeDocker => {
  const docker = new FakeDocker();
  docker.addImage(S3.resticImage);
  docker.execResponder = responder;
  return docker;
};
const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), 'tug-ctl-bak-'));
const execs = (docker: FakeDocker) =>
  docker.calls
    .filter((call) => call.startsWith('exec-start'))
    .map((call) => call.split(' ').slice(2).join(' '));

test('the control repository sits beside the project repositories under a name no project can have', () => {
  assert.equal(controlRepository(S3.url), 's3:https://s3.example.com/bucket/tug/_control');
});

test('the control password follows the master key, so nodes that hold the destination login cannot derive it', () => {
  const base = controlRepositoryPassword('master-key-1');
  assert.equal(
    base,
    controlRepositoryPassword('master-key-1'),
    'the same master key gives the same password',
  );
  assert.notEqual(
    base,
    controlRepositoryPassword('master-key-2'),
    'another installation derives another password',
  );
  assert.match(
    base,
    /^[0-9a-f]{64}$/,
    'the password is a hex string restic accepts from an environment variable',
  );
  assert.notEqual(
    base,
    repositoryPassword('master-key-1', '_control'),
    'it differs from any project repository password derived from the same key',
  );
});

test('a push creates a missing repository, streams the archive into restic and removes its helper', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'archive-bytes');
  const docker = dockerWith((cmd) => {
    const line = cmd.join(' ');
    if (line === 'restic cat config --no-lock') return { code: 10, err: NEVER_CREATED };
    if (line.startsWith('restic backup'))
      return { code: 0, out: '{"message_type":"summary","snapshot_id":"abc123def456"}\n' };
    return { code: 0 };
  });
  try {
    const result = await pushControlArchive(docker, S3, archive);
    assert.equal(result.repository, 'initialized', 'a missing repository is created');
    assert.equal(result.snapshotId, 'abc123def456', 'the snapshot id is reported');
    assert.deepEqual(
      execs(docker).map((line) => line.split(' ').slice(0, 2).join(' ')),
      ['restic cat', 'restic init', 'restic backup', 'restic forget'],
      'the repository is probed, created, written and pruned in order',
    );
    assert.equal(
      Buffer.concat(docker.execStdinData).toString(),
      'archive-bytes',
      'the archive reaches restic on stdin',
    );
    const create = docker.calls.find((call) => call.startsWith('create '));
    assert.ok(create, 'a helper container was created');
    assert.equal(
      docker.calls.filter((call) => call.startsWith('rm ')).length,
      1,
      'the helper container is removed afterwards',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a push fails and never initializes when the credentials or the store are wrong', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock'
      ? { code: 1, err: 'wrong password or no key found for sekret-value-1' }
      : { code: 0 },
  );
  try {
    await assert.rejects(
      () => pushControlArchive(docker, S3, archive),
      (error: Error) =>
        /repository check failed/.test(error.message) && !error.message.includes('sekret-value-1'),
      'the failure names the check and does not echo the secret',
    );
    assert.ok(
      !execs(docker).some((line) => line.startsWith('restic init')),
      'a repository that cannot be read is never re-initialized',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a retention failure is a warning, not a failed backup', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) =>
    cmd[1] === 'forget' ? { code: 1, err: 'prune failed' } : { code: 0 },
  );
  try {
    const result = await pushControlArchive(docker, S3, archive);
    assert.match(result.warning ?? '', /retention failed/, 'the warning says retention failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a fetch writes the newest control snapshot to a private file and reports a missing repository', async () => {
  const dir = await scratch();
  const target = path.join(dir, 'out.tar.gz');
  const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x10]);
  const docker = dockerWith((cmd) => (cmd[1] === 'dump' ? { code: 0, out: bytes } : { code: 0 }));
  try {
    await fetchControlArchive(docker, S3, target);
    assert.deepEqual(await fs.readFile(target), bytes, 'the snapshot bytes are written unchanged');
    assert.equal(
      (await fs.stat(target)).mode & 0o777,
      0o600,
      'the archive is private to its owner',
    );
    assert.ok(
      execs(docker).some((line) => line.startsWith('restic dump latest /control.tar.gz')),
      'the newest snapshot is dumped by the name it was stored under',
    );

    const empty = dockerWith((cmd) =>
      cmd[1] === 'cat' ? { code: 10, err: NEVER_CREATED } : { code: 0 },
    );
    await assert.rejects(
      () => fetchControlArchive(empty, S3, path.join(dir, 'none.tar.gz')),
      /no control backup was found/,
      'an empty destination says there is no control backup',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('restic that exits early is reported with its own message, not the broken pipe', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x'.repeat(64 * 1024));
  const docker = dockerWith((cmd) =>
    cmd[1] === 'backup'
      ? { code: 1, err: 'unable to create lock in backend: repository is already locked' }
      : { code: 0 },
  );
  docker.execStdinError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  try {
    await assert.rejects(
      () => pushControlArchive(docker, S3, archive),
      (error: Error) => /already locked/.test(error.message) && !/EPIPE/.test(error.message),
      "the failure carries restic's stderr instead of the pipe error",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed dump leaves no partial archive behind, and the password never reaches an error', async () => {
  const dir = await scratch();
  const target = path.join(dir, 'out.tar.gz');
  const docker = dockerWith((cmd) =>
    cmd[1] === 'dump'
      ? { code: 1, out: Buffer.from('partial'), err: `ciphertext error with ${S3.password}` }
      : { code: 0 },
  );
  try {
    await assert.rejects(
      () => fetchControlArchive(docker, S3, target),
      (error: Error) =>
        /could not read the latest control backup/.test(error.message) &&
        !error.message.includes(S3.password),
      'the failure is reported with the control password redacted',
    );
    await assert.rejects(() => fs.stat(target), 'the partial file is removed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a hung restic fails at the time limit and its helper is removed', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith(() => undefined); // never answers
  try {
    await assert.rejects(
      () => pushControlArchive(docker, { ...S3, limitMs: 50 }, archive),
      /did not finish within/,
      'a stuck helper cannot hold the backup forever',
    );
    assert.equal(
      docker.calls.filter((call) => call.startsWith('rm ')).length,
      1,
      'the helper container is removed after the timeout',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const BUCKET_MISSING =
  'Fatal: unable to open config file: Stat: The specified bucket does not exist.\nIs there a repository at the following location?';
/** restic 0.19.1 against an S3 bucket that exists but holds no repository: exit code 10. */
const NEVER_CREATED =
  'Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.\nIs there a repository at the following location?\ns3:http://s3.example.com/bucket/tug';
/** restic 0.19.1 against a rest-server without the repository: exit code 10. */
const REST_MISSING =
  'Fatal: repository does not exist: unable to open config file: <config/> does not exist\nIs there a repository at the following location?\nrest:http://backup.internal:8030/tug/_control/';
const WRONG_PASSWORD = 'Fatal: wrong password or no key found';

test('a wrong bucket fails a push and a fetch instead of creating or reporting an empty repository', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) =>
    cmd[1] === 'cat' ? { code: 1, err: BUCKET_MISSING } : { code: 0 },
  );
  try {
    await assert.rejects(
      () => pushControlArchive(docker, S3, archive),
      /repository check failed/,
      'a bucket that does not exist fails the backup',
    );
    assert.ok(
      !execs(docker).some((line) => line.startsWith('restic init')),
      'a bucket typo never triggers an init attempt',
    );
    await assert.rejects(
      () => fetchControlArchive(docker, S3, path.join(dir, 'out.tar.gz')),
      /cannot read the control repository/,
      'a restore from a wrong bucket does not claim there is no control backup',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('restic output is redacted on the push path too', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) =>
    cmd[1] === 'backup'
      ? { code: 1, err: `failed with ${S3.password} and ${S3.env.AWS_SECRET_ACCESS_KEY}` }
      : { code: 0 },
  );
  try {
    await assert.rejects(
      () => pushControlArchive(docker, S3, archive),
      (error: Error) =>
        /backup failed/.test(error.message) &&
        !error.message.includes(S3.password) &&
        !error.message.includes(S3.env.AWS_SECRET_ACCESS_KEY),
      'neither the control password nor the destination secret reaches the error',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a local write failure is reported as such, not as restic breaking its pipe', async () => {
  const dir = await scratch();
  const docker = dockerWith((cmd) =>
    cmd[1] === 'dump' ? { code: 1, err: 'broken pipe' } : { code: 0 },
  );
  try {
    await assert.rejects(
      () => fetchControlArchive(docker, S3, path.join(dir, 'missing-dir', 'out.tar.gz')),
      (error: Error) => /ENOENT/.test(error.message),
      'an unwritable destination file is the cause, whatever restic said afterwards',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a cancelled job stops and removes its helper, and a hung container create hits the limit', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  try {
    const docker = dockerWith(() => undefined); // never answers
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => pushControlArchive(docker, { ...S3, signal: controller.signal }, archive),
      /cancelled/,
      'a client that went away cancels the job',
    );
    assert.equal(
      docker.calls.filter((call) => call.startsWith('rm ')).length,
      1,
      'the helper is removed after a cancel',
    );

    const stuck = dockerWith(() => ({ code: 0 }));
    stuck.createContainer = () => new Promise(() => undefined);
    await assert.rejects(
      () => pushControlArchive(stuck, { ...S3, limitMs: 50 }, archive),
      /did not finish within/,
      'a Docker daemon that hangs on create cannot wedge the job',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const SNAP = (id: string, time: string, tags: string[], bytes?: number) => ({
  id: id.padEnd(64, '0'),
  short_id: id.slice(0, 8),
  time,
  tags,
  ...(bytes === undefined ? {} : { summary: { total_bytes_processed: bytes } }),
});

test('snapshot tags are stored with the backup so a listing can say what each one holds', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith(() => ({ code: 0 }));
  try {
    await pushControlArchive(docker, S3, archive, { tags: ['images:none', 'tug:1.2.3'] });
    const backup = execs(docker).find((line) => line.startsWith('restic backup'));
    assert.match(
      backup ?? '',
      /--tag control --tag images:none --tag tug:1.2.3/,
      'the extra tags follow the control tag',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('listing reads the snapshots from the destination, newest first, flat or grouped', async () => {
  const flat = JSON.stringify([
    SNAP('aaaa1111', '2026-01-01T00:00:00Z', ['control'], 10),
    SNAP('bbbb2222', '2026-01-03T00:00:00Z', ['control', 'images:none']),
  ]);
  const grouped = JSON.stringify([{ group_key: {}, snapshots: JSON.parse(flat) }]);
  for (const [what, out] of [
    ['flat', flat],
    ['grouped', grouped],
  ] as const) {
    const docker = dockerWith((cmd) => (cmd[1] === 'snapshots' ? { code: 0, out } : { code: 0 }));
    const listing = await listControlSnapshots(docker, S3);
    assert.equal(listing.state, 'ok', `${what}: a readable repository is ok`);
    assert.deepEqual(
      listing.snapshots.map((snapshot) => snapshot.shortId),
      ['bbbb2222', 'aaaa1111'],
      `${what}: the newest snapshot comes first`,
    );
    assert.equal(
      listing.snapshots[1].sizeBytes,
      10,
      `${what}: the size is kept when restic reports it`,
    );
    assert.deepEqual(
      listing.snapshots[0].tags,
      ['control', 'images:none'],
      `${what}: tags are kept`,
    );
  }
  const filtered = dockerWith(() => ({ code: 0, out: '[]' }));
  await listControlSnapshots(filtered, S3);
  assert.ok(
    execs(filtered).some(
      (line) => line === 'restic snapshots --json --host control --tag control --retry-lock 10m',
    ),
    'only control snapshots are listed, whatever else the repository holds',
  );
});

test('listing reports an empty destination as missing and an unreadable one as an error', async () => {
  const empty = dockerWith((cmd) =>
    cmd[1] === 'cat' ? { code: 10, err: NEVER_CREATED } : { code: 0 },
  );
  assert.deepEqual(
    await listControlSnapshots(empty, S3),
    { state: 'missing', snapshots: [] },
    'a repository that was never created is empty, not an error',
  );
  const wrong = dockerWith((cmd) =>
    cmd[1] === 'cat' ? { code: 1, err: BUCKET_MISSING } : { code: 0 },
  );
  await assert.rejects(
    () => listControlSnapshots(wrong, S3),
    /cannot read the control repository/,
    'a wrong bucket is an error',
  );
  const garbled = dockerWith((cmd) =>
    cmd[1] === 'snapshots' ? { code: 0, out: 'not json' } : { code: 0 },
  );
  await assert.rejects(
    () => listControlSnapshots(garbled, S3),
    /unexpected format/,
    'output that is not JSON is an error',
  );
});

test('a named snapshot is restored only when control stored it, and the id is validated first', async () => {
  const dir = await scratch();
  const target = path.join(dir, 'out.tar.gz');
  const id = 'abcd1234';
  const docker = dockerWith((cmd) => {
    if (cmd[1] === 'snapshots')
      return { code: 0, out: JSON.stringify([SNAP(id, '2026-01-01T00:00:00Z', ['control'])]) };
    if (cmd[1] === 'dump') return { code: 0, out: Buffer.from('archive') };
    return { code: 0 };
  });
  try {
    await fetchControlArchive(docker, S3, target, id);
    assert.ok(
      execs(docker).some((line) => line.startsWith(`restic dump ${id} /control.tar.gz`)),
      'the named snapshot, not the latest, is dumped',
    );
    assert.ok(
      execs(docker).some(
        (line) =>
          line === `restic snapshots ${id} --json --host control --tag control --retry-lock 10m`,
      ),
      'the snapshot is first checked to be a control backup',
    );
    const stranger = dockerWith((cmd) =>
      cmd[1] === 'snapshots' ? { code: 0, out: '[]' } : { code: 0 },
    );
    await assert.rejects(
      () => fetchControlArchive(stranger, S3, path.join(dir, 'other.tar.gz'), id),
      /is not a control backup/,
      'a snapshot of anything else in the repository is refused',
    );
    assert.ok(
      !execs(stranger).some((line) => line.startsWith('restic dump')),
      'a refused snapshot is never dumped',
    );
    const untouched = dockerWith(() => ({ code: 0 }));
    for (const bad of ['--all', '../x', 'ABCD1234', 'short', 'latest; rm']) {
      await assert.rejects(
        () => fetchControlArchive(untouched, S3, target, bad),
        /snapshot must be an id/,
        `${bad} is not accepted as a snapshot id`,
      );
    }
    assert.deepEqual(untouched.calls, [], 'an invalid id is refused before any container starts');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const REST_401 =
  'Fatal: unable to open config file: Stat: unexpected HTTP response (401): 401 Unauthorized\nIs there a repository at the following location?';

test('a refused REST login fails the push and the fetch instead of initializing or reporting nothing', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) => (cmd[1] === 'cat' ? { code: 1, err: REST_401 } : { code: 0 }));
  try {
    await assert.rejects(
      () => pushControlArchive(docker, S3, archive),
      /repository check failed/,
      'a refused login fails the backup',
    );
    assert.ok(
      !execs(docker).some((line) => line.startsWith('restic init')),
      'it is never initialized over',
    );
    await assert.rejects(
      () => fetchControlArchive(docker, S3, path.join(dir, 'o.tar.gz')),
      /cannot read the control repository/,
      'a refused login is not reported as "no control backup"',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a stalled exec handshake hits the deadline and the cancel, and a late container is removed', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  try {
    const stalled = dockerWith(() => ({ code: 0 }));
    const execStart = stalled.execStart.bind(stalled);
    stalled.execStart = (id, options) =>
      options.stdin ? new Promise(() => undefined) : execStart(id, options);
    await assert.rejects(
      () => pushControlArchive(stalled, { ...S3, limitMs: 50 }, archive),
      /did not finish within/,
      'a streaming exec that never starts cannot hold the backup past its limit',
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => pushControlArchive(stalled, { ...S3, signal: controller.signal }, archive),
      /cancelled/,
      'a cancel reaches a stalled handshake too',
    );

    const late = dockerWith(() => ({ code: 0 }));
    const createContainer = late.createContainer.bind(late);
    late.createContainer = async (name, body) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return createContainer(name, body);
    };
    await assert.rejects(
      () => pushControlArchive(late, { ...S3, limitMs: 30 }, archive),
      /did not finish within/,
      'a create that is slower than the limit fails the job',
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(
      await late.listContainers(),
      [],
      'a container that was created after the job gave up is removed, not left running',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const retryNotice = (seconds: number, cause: string) =>
  `Stat(<config/>) returned error, retrying after ${seconds}s: Stat: ${cause}`;
/** What real restic printed when the bucket was created while it was still retrying (seen on a QEMU VM). */
const BUCKET_APPEARED = [
  retryNotice(8.2, 'The specified bucket does not exist'),
  retryNotice(20.8, 'The specified bucket does not exist'),
  retryNotice(70.9, 'The specified bucket does not exist'),
  'Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.',
  'Is there a repository at the following location?',
  's3:http://10.0.2.2:9000/tug-backups/_control',
].join('\n');

test('a bucket created while restic was retrying lets the first backup initialize the repository', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) =>
    cmd[1] === 'cat' ? { code: 10, err: BUCKET_APPEARED } : { code: 0 },
  );
  try {
    const result = await pushControlArchive(docker, S3, archive);
    assert.equal(result.repository, 'initialized', 'the repository is created, not refused');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failure reports restic's final message and a count of retries, not the whole retry log", async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const log = [
    retryNotice(8, 'The specified bucket does not exist'),
    retryNotice(21, 'The specified bucket does not exist'),
    retryNotice(71, 'The specified bucket does not exist'),
    'Fatal: unable to open config file: Stat: The specified bucket does not exist',
  ].join('\n');
  const docker = dockerWith((cmd) => (cmd[1] === 'cat' ? { code: 1, err: log } : { code: 0 }));
  try {
    await assert.rejects(
      () => pushControlArchive(docker, S3, archive),
      (error: Error) =>
        /Fatal: unable to open config file/.test(error.message) &&
        /restic retried 3 times; last error: Stat: The specified bucket does not exist/.test(
          error.message,
        ) &&
        !/returned error, retrying/.test(error.message),
      'the message names the final failure and the last cause once, without three notices',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A restic process that prints `lines` over time and then, when `exits`, finishes with code 0. */
function chattyExec(docker: FakeDocker, match: string, lines: string[], exits: boolean): void {
  const original = docker.execStart.bind(docker);
  docker.execStart = async (id, options) => {
    if (options.cmd[1] !== match) return original(id, options);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin: null,
      stdout,
      stderr,
      kill: () => true,
    }) as unknown as AttachedProcess;
    lines.forEach((line, index) => setTimeout(() => stderr.write(line + '\n'), 10 + index * 25));
    if (exits)
      setTimeout(
        () => {
          stdout.end();
          stderr.end();
          proc.emit('close', 0, null);
        },
        10 + lines.length * 25 + 30,
      );
    return proc;
  };
}

test('restic that only retries a failing backend is failed with the cause instead of running to the limit', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith(() => ({ code: 0 }));
  chattyExec(
    docker,
    'cat',
    [
      retryNotice(8, 'The specified bucket does not exist'),
      retryNotice(20, 'The specified bucket does not exist'),
    ],
    false,
  );
  try {
    const started = Date.now();
    await assert.rejects(
      () => pushControlArchive(docker, { ...S3, stallMs: 150 }, archive),
      /restic made no progress for 0s: restic retried 2 times; last error: Stat: The specified bucket does not exist/,
      'the stall names what restic kept failing with',
    );
    assert.ok(
      Date.now() - started < 5000,
      'it fails at the stall limit, not at the 30 minute job limit',
    );
    assert.equal(
      docker.calls.filter((call) => call.startsWith('rm ')).length,
      1,
      'the helper, and restic with it, is removed',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a slow store that retries and then makes progress is not failed as stalled', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith(() => ({ code: 0 }));
  chattyExec(
    docker,
    'cat',
    [
      retryNotice(8, 'timeout'),
      'repository abc123 opened (version 2, compression level auto)',
      retryNotice(8, 'timeout'),
    ],
    true,
  );
  try {
    const result = await pushControlArchive(docker, { ...S3, stallMs: 400 }, archive);
    assert.equal(
      result.repository,
      'ok',
      'output that is not a retry notice counts as progress, so the job completes',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a push initializes a repository that restic reports as missing with exit code 10, whatever the backend says', async () => {
  for (const [what, err] of [
    ['a REST server', REST_MISSING],
    ['an S3 key that does not exist', NEVER_CREATED],
  ] as const) {
    const dir = await scratch();
    const archive = path.join(dir, 'a.tar.gz');
    await fs.writeFile(archive, 'x');
    const docker = dockerWith((cmd) => (cmd[1] === 'cat' ? { code: 10, err } : { code: 0 }));
    try {
      const result = await pushControlArchive(docker, S3, archive);
      assert.equal(result.repository, 'initialized', `${what} without a repository is created`);
      assert.ok(
        execs(docker).some((line) => line.startsWith('restic init')),
        `${what}: restic init runs`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

test('a wrong password (exit 12) and a missing bucket (exit 1) fail a push without init and explain the cause', async () => {
  for (const [what, code, err, expected] of [
    ['a wrong password', 12, WRONG_PASSWORD, /wrong repository password/],
    ['a missing bucket', 1, BUCKET_MISSING, /bucket does not exist/],
  ] as const) {
    const dir = await scratch();
    const archive = path.join(dir, 'a.tar.gz');
    await fs.writeFile(archive, 'x');
    const docker = dockerWith((cmd) => (cmd[1] === 'cat' ? { code, err } : { code: 0 }));
    try {
      await assert.rejects(
        () => pushControlArchive(docker, S3, archive),
        expected,
        `${what} fails the backup with its cause`,
      );
      assert.ok(
        !execs(docker).some((line) => line.startsWith('restic init')),
        `${what} never triggers restic init`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

test('the old-restic hint appears only for a known restic older than 0.17, never for a 0.19 missing bucket', async () => {
  for (const [version, hinted] of [
    ['0.19.1', false],
    ['0.16.4', true],
  ] as const) {
    const dir = await scratch();
    const archive = path.join(dir, 'a.tar.gz');
    await fs.writeFile(archive, 'x');
    const docker = dockerWith((cmd) =>
      cmd[1] === 'cat'
        ? { code: 1, err: `${BUCKET_MISSING}\ns3:http://s3.example.com/nope/tug` }
        : cmd[1] === 'version'
          ? { code: 0, out: `restic ${version} compiled with go1.22\n` }
          : { code: 0 },
    );
    try {
      await assert.rejects(
        () => pushControlArchive(docker, S3, archive),
        (error: Error) =>
          /bucket does not exist/.test(error.message) &&
          /TUG_RESTIC_IMAGE must be 0\.17 or newer/.test(error.message) === hinted,
        `restic ${version}: the hint is ${hinted ? 'present' : 'absent'}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

test('checkRepository redacts credentials from errors the helper itself throws', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  docker.failCreate = () =>
    new Error(`docker said no for ${S3.env.AWS_SECRET_ACCESS_KEY} and repo-password-1`);
  const checked = await checkRepository(docker, {
    repository: 's3:https://s3.example.com/bucket/tug/shop',
    env: S3.env,
    password: 'repo-password-1',
    resticImage: S3.resticImage,
  });
  assert.equal(checked.state, 'error', 'a Docker failure is an error state');
  assert.ok(
    !JSON.stringify(checked).includes('sekret-value-1') &&
      !JSON.stringify(checked).includes('repo-password-1'),
    'neither the access secret nor the repository password appears in the error',
  );
});

test('checkRepository reports ok, initialized and error states and never throws for a backend failure', async () => {
  const access = {
    repository: 's3:https://s3.example.com/bucket/tug/shop',
    env: S3.env,
    password: 'repo-password-1',
    resticImage: S3.resticImage,
  };
  const run = (code: number, err: string, initCode = 0) =>
    checkRepository(
      dockerWith((cmd) =>
        cmd[1] === 'cat'
          ? { code, err }
          : cmd[1] === 'init'
            ? { code: initCode, err: 'init boom' }
            : { code: 0 },
      ),
      access,
    );
  assert.deepEqual(await run(0, ''), { state: 'ok' }, 'an existing repository is ok');
  assert.deepEqual(
    await run(10, REST_MISSING),
    { state: 'initialized' },
    'a missing repository is created',
  );
  const bucket = await run(1, BUCKET_MISSING);
  assert.equal(bucket.state, 'error', 'a missing bucket is an error');
  assert.match(bucket.error ?? '', /bucket does not exist/, 'the error carries restic message');
  const wrong = await run(12, WRONG_PASSWORD);
  assert.match(wrong.error ?? '', /wrong repository password/, 'exit 12 explains the password');
  const noInit = await run(10, REST_MISSING, 1);
  assert.equal(noInit.state, 'error', 'a failed init is an error');
  assert.match(noInit.error ?? '', /repository init failed/, 'the init failure is named');
});

test('a cancelled control backup interrupts restic before its helper is removed, and a finished one sends no signal', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  try {
    const stopsRestic = (call: string) => call.includes('pkill -INT -x restic');
    const docker = dockerWith((cmd) => (cmd[1] === 'backup' ? undefined : { code: 0 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () =>
        pushControlArchive(
          docker,
          { ...S3, signal: controller.signal, stopGraceMs: 1000 },
          archive,
        ),
      /cancelled/,
      'the cancel ends the backup',
    );
    const stop = docker.calls.findIndex(stopsRestic);
    assert.ok(stop >= 0, 'the running restic gets SIGINT so it releases the repository lock');
    assert.ok(
      docker.calls.findIndex((call) => call.startsWith('rm ')) > stop,
      'the helper is removed only after restic was told to stop',
    );

    const clean = dockerWith(() => ({ code: 0 }));
    await pushControlArchive(clean, S3, archive);
    assert.ok(
      !clean.calls.some(stopsRestic),
      'a backup whose restic commands finished sends no signal',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a push reports retention as data: ok, failed with restic's lock exit marked locked, or external without running forget", async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  try {
    const ok = await pushControlArchive(
      dockerWith(() => ({ code: 0 })),
      S3,
      archive,
    );
    assert.deepEqual(ok.retention, { state: 'ok' }, 'a prune that works is ok');
    const locked = await pushControlArchive(
      dockerWith((cmd) => (cmd[1] === 'forget' ? { code: 11, err: 'any wording' } : { code: 0 })),
      S3,
      archive,
    );
    assert.equal(locked.retention.state, 'failed', 'a failed prune is reported as failed');
    assert.equal(locked.retention.locked, true, 'restic exit 11 marks it locked, not its wording');
    assert.match(locked.warning ?? '', /retention failed/, 'the existing warning stays');
    const plain = await pushControlArchive(
      dockerWith((cmd) =>
        cmd[1] === 'forget' ? { code: 1, err: 'repository is already locked' } : { code: 0 },
      ),
      S3,
      archive,
    );
    assert.equal(plain.retention.locked, undefined, 'lock-like wording without exit 11 is no lock');
    const external = dockerWith(() => ({ code: 1, err: 'append-only' }));
    external.execResponder = (cmd) =>
      cmd[1] === 'backup'
        ? { code: 0, out: '{"message_type":"summary","snapshot_id":"abc123def456"}\n' }
        : { code: 0 };
    const skipped = await pushControlArchive(external, S3, archive, { retentionMode: 'external' });
    assert.deepEqual(skipped.retention, { state: 'external' }, 'external retention is reported');
    assert.ok(
      !execs(external).some((line) => line.startsWith('restic forget')),
      'forget --prune is not run against an append-only destination',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a control retention failure keeps the 403 line without the stack and names external retention', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  try {
    const result = await pushControlArchive(
      dockerWith((cmd) =>
        cmd[1] === 'forget'
          ? {
              code: 1,
              err: [
                'Remove(<snapshot/202d03c576>) failed: unexpected HTTP response (403): 403 Forbidden',
                'failed to remove one or more snapshots',
                'main.init',
                '\t/restic/cmd/restic/cmd_forget.go:67',
                'runtime.main',
                '\t/usr/local/go/src/runtime/proc.go:258',
                'runtime.goexit',
                '\t/usr/local/go/src/runtime/asm_arm64.s:1447',
              ].join('\n'),
            }
          : { code: 0 },
      ),
      S3,
      archive,
    );
    const message = result.retention.message ?? '';
    assert.match(message, /403 Forbidden/, 'the line that explains the refusal is kept');
    assert.ok(!/runtime\.|main\.init/.test(message), 'the stack frames are dropped');
    assert.match(
      message,
      /tug backup destination set --retention external/,
      'the message says what to do about an append-only destination',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('every control operation that fails on a lock at the repository probe throws an error with cause locked', async () => {
  const locked = dockerWith;
  const refused = () =>
    locked((cmd) =>
      cmd[1] === 'cat' ? { code: 11, err: 'unable to create lock in backend' } : { code: 0 },
    );
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const isLocked = (error: Error & { jobCause?: string }) => error.jobCause === 'locked';
  try {
    await assert.rejects(
      () => pushControlArchive(refused(), S3, archive),
      isLocked,
      'a push refused at the probe is classified locked, not left without a cause',
    );
    await assert.rejects(
      () => unlockControlRepository(refused(), S3),
      isLocked,
      'an unlock refused at the probe is classified locked',
    );
    await assert.rejects(
      () => checkControlRepository(refused(), S3),
      isLocked,
      'a check refused at the probe is classified locked',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the control unlock probes without a lock, so an exclusive stale lock cannot block the unlock', async () => {
  let listed = 0;
  const docker = dockerWith((cmd) => {
    const line = cmd.join(' ');
    if (line === 'restic list locks --no-lock')
      return { code: 0, out: ++listed === 1 ? 'aaaaaaaa11\n' : '' };
    // restic refuses every command that takes a lock while an exclusive lock exists.
    if (cmd[0] === 'restic' && !cmd.includes('--no-lock') && cmd[1] !== 'unlock')
      return { code: 11, err: 'repository is already locked exclusively' };
    return { code: 0 };
  });
  const result = await unlockControlRepository(docker, S3);
  assert.deepEqual(result, { before: 1, after: 0 }, 'the stale exclusive lock is removed');
  assert.ok(execs(docker).includes('restic unlock'), 'plain restic unlock ran');
  assert.ok(
    !execs(docker).some((line) => line.includes('--remove-all')),
    'unlock never removes a live lock',
  );
});

test("a push that fails on restic's lock exit throws an error with cause locked", async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  try {
    await assert.rejects(
      () =>
        pushControlArchive(
          dockerWith((cmd) => (cmd[1] === 'backup' ? { code: 11, err: 'locked' } : { code: 0 })),
          S3,
          archive,
        ),
      (error: Error & { jobCause?: string }) => error.jobCause === 'locked',
      'a backup that exits 11 is classified locked',
    );
    await assert.rejects(
      () =>
        pushControlArchive(
          dockerWith((cmd) =>
            cmd[1] === 'backup' ? { code: 1, err: 'repository is locked' } : { code: 0 },
          ),
          S3,
          archive,
        ),
      (error: Error & { jobCause?: string }) => error.jobCause === undefined,
      'the same wording with another exit code is not',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
