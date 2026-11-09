import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  controlRepository,
  controlRepositoryPassword,
  fetchControlArchive,
  isMissingRepository,
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
    if (line === 'restic cat config') return { code: 1, err: NEVER_CREATED };
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
    cmd.join(' ') === 'restic cat config'
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
      cmd[1] === 'cat' ? { code: 1, err: NEVER_CREATED } : { code: 0 },
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
const NEVER_CREATED =
  'Fatal: unable to open config file: Stat: The specified key does not exist.\nIs there a repository at the following location?';

test('only a repository that was never created counts as missing', () => {
  assert.equal(
    isMissingRepository(NEVER_CREATED),
    true,
    'a missing config file is a repository to create',
  );
  for (const [what, text] of [
    ['a wrong bucket', BUCKET_MISSING],
    [
      'a refused login',
      'Stat: AccessDenied: Access Denied.\nIs there a repository at the following location?',
    ],
    [
      'an unreachable store',
      'dial tcp: lookup s3.example.com: no such host\nIs there a repository at the following location?',
    ],
    ['a wrong password', 'wrong password or no key found'],
  ] as const)
    assert.equal(isMissingRepository(text), false, `${what} is not a missing repository`);
});

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
    execs(filtered).some((line) => line === 'restic snapshots --json --host control --tag control'),
    'only control snapshots are listed, whatever else the repository holds',
  );
});

test('listing reports an empty destination as missing and an unreadable one as an error', async () => {
  const empty = dockerWith((cmd) =>
    cmd[1] === 'cat' ? { code: 1, err: NEVER_CREATED } : { code: 0 },
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
        (line) => line === `restic snapshots ${id} --json --host control --tag control`,
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

const REST_404 =
  'Fatal: unable to open config file: Stat: unexpected HTTP response (404): 404 page not found\nIs there a repository at the following location?';
const REST_401 =
  'Fatal: unable to open config file: Stat: unexpected HTTP response (401): 401 Unauthorized\nIs there a repository at the following location?';
const LOCAL_MISSING =
  'Fatal: unable to open config file: stat /srv/backups/_control/config: no such file or directory\nIs there a repository at the following location?';
const HINT_ONLY =
  'Fatal: something nobody has seen\nIs there a repository at the following location?';

test('a repository is missing only on positive evidence that its config is absent', () => {
  for (const [what, text] of [
    ['an S3 key that does not exist', NEVER_CREATED],
    ['a local path that does not exist', LOCAL_MISSING],
    ['a REST server answering 404', REST_404],
  ] as const)
    assert.equal(isMissingRepository(text), true, `${what} is a repository to create`);
  for (const [what, text] of [
    ['a REST server refusing the login', REST_401],
    ['an answer with only the hint', HINT_ONLY],
  ] as const)
    assert.equal(
      isMissingRepository(text),
      false,
      `${what} is a backend error, not an empty repository`,
    );
});

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

test('only the final failure decides whether a repository is missing, not the retries before it', () => {
  assert.equal(
    isMissingRepository(BUCKET_APPEARED),
    true,
    'a bucket that did not exist during earlier attempts and was created since leaves a repository to create',
  );
  assert.equal(
    isMissingRepository(
      [
        retryNotice(8, 'The specified key does not exist'),
        'Fatal: unable to open config file: Stat: The specified bucket does not exist',
      ].join('\n'),
    ),
    false,
    'a final failure about the bucket is a backend error whatever the retries said',
  );
  assert.equal(
    isMissingRepository(retryNotice(8, 'The specified key does not exist')),
    false,
    'retry notices alone are not evidence of anything',
  );
});

test('a bucket created while restic was retrying lets the first backup initialize the repository', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'x');
  const docker = dockerWith((cmd) =>
    cmd[1] === 'cat' ? { code: 1, err: BUCKET_APPEARED } : { code: 0 },
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
