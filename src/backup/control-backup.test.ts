import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  controlRepository,
  controlRepositoryPassword,
  fetchControlArchive,
  pushControlArchive,
} from './control-backup.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';

const S3 = {
  url: 's3:https://s3.example.com/bucket/tug/',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
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

test('the control password follows the destination secret and nothing the archive contains', () => {
  const base = controlRepositoryPassword(S3.env);
  assert.equal(
    base,
    controlRepositoryPassword({ ...S3.env }),
    'the same login gives the same password',
  );
  assert.equal(
    base,
    controlRepositoryPassword({ ...S3.env, AWS_ACCESS_KEY_ID: 'OTHER' }),
    'for S3 only the secret key matters, so the access key id may change',
  );
  assert.notEqual(
    base,
    controlRepositoryPassword({ ...S3.env, AWS_SECRET_ACCESS_KEY: 'rotated-secret' }),
    'a rotated secret starts a new repository',
  );
  assert.match(
    base,
    /^[0-9a-f]{64}$/,
    'the password is a hex string restic accepts from an environment variable',
  );
  assert.notEqual(
    controlRepositoryPassword({ SFTP_PASSWORD: 'a', SFTP_USER: 'b' }),
    controlRepositoryPassword({ SFTP_PASSWORD: 'a' }),
    'other backends derive from every credential variable',
  );
});

test('a push creates a missing repository, streams the archive into restic and removes its helper', async () => {
  const dir = await scratch();
  const archive = path.join(dir, 'a.tar.gz');
  await fs.writeFile(archive, 'archive-bytes');
  const docker = dockerWith((cmd) => {
    const line = cmd.join(' ');
    if (line === 'restic cat config')
      return { code: 1, err: 'Is there a repository at the following location?' };
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
      cmd[1] === 'cat'
        ? { code: 1, err: 'Is there a repository at the following location?' }
        : { code: 0 },
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
