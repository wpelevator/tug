import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { json, testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const op: Record<string, string> = {
  'x-tug-test-operator': 'operator',
  'content-type': 'application/json',
};
const call = (base: string, method: string, route: string, body?: unknown) =>
  fetch(`${base}${route}`, {
    method,
    headers: op,
    body: body ? JSON.stringify(body) : undefined,
  });
const DESTINATION = {
  url: 's3:https://s3.example.com/bucket/tug',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
};

async function server(docker: FakeDocker, env: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-ctlbak-'));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TUG_DATA_DIR: dir,
    TUG_CONTROL_BACKUP_DIR: path.join(dir, 'control-backups'),
    TUG_CONTROL_RESTORE_DIR: path.join(dir, 'control-restore'),
    TUG_BACKUP_TICK_MS: '20',
    ...env,
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
    docker,
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    dir,
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
const resticDocker = (responder?: FakeDocker['execResponder']): FakeDocker => {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.17.3');
  docker.execResponder =
    responder ??
    ((cmd) =>
      cmd[1] === 'backup'
        ? { code: 0, out: '{"message_type":"summary","snapshot_id":"snap1234"}\n' }
        : { code: 0 });
  return docker;
};
async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const listing = async (base: string) => json(await call(base, 'GET', '/api/v1/backups'));

test('control backup archives can be downloaded byte for byte, and only the ones control made', async () => {
  const s = await server(resticDocker());
  try {
    const backup = await json(await call(s.base, 'POST', '/api/v1/control/backups/run', {}));
    const res = await call(s.base, 'GET', `/api/v1/control/backups/${backup.backupId}/download`);
    assert.equal(res.status, 200, 'an existing control backup downloads');
    assert.match(
      res.headers.get('content-disposition') ?? '',
      new RegExp(`${backup.backupId}\\.tar\\.gz`),
      'the download is named after the backup',
    );
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      await fs.readFile(backup.artifactRef),
      'the downloaded bytes are the archive on disk',
    );
    const missing = await call(s.base, 'GET', '/api/v1/control/backups/cbak_nope/download');
    assert.equal(missing.status, 404, 'an unknown backup id is not found');
  } finally {
    await s.close();
  }
});

test('with a destination control backs itself up off-host without images and keeps no archive behind', async () => {
  const docker = resticDocker();
  const s = await server(docker);
  try {
    assert.equal(
      (await listing(s.base)).control,
      null,
      'control reports no control backup while there is no destination',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.lastSuccessAt ? control : undefined;
    }, 'the first control backup');
    assert.equal(control.problem, null, 'a healthy control backup reports no problem');
    const sent = Buffer.concat(docker.execStdinData);
    assert.deepEqual(
      [...sent.subarray(0, 2)],
      [0x1f, 0x8b],
      'a gzip archive is streamed into restic',
    );
    const create = docker.calls.filter((c) => c.startsWith('create tug-control-backup'));
    assert.equal(create.length, 1, 'one helper container runs the backup');
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'control-backups')),
      [],
      'the local archive is removed once it is off the host',
    );
    const events = await json(await call(s.base, 'GET', '/api/v1/events?project=_control'));
    assert.ok(
      JSON.stringify(events).includes('backup.completed'),
      'a completed control backup is recorded as an event',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      docker.calls.filter((c) => c.startsWith('create tug-control-backup')).length,
      1,
      'a fresh success is not repeated before the next interval',
    );
  } finally {
    await s.close();
  }
});

test('a failing control backup is reported and retried only after the retry delay', async () => {
  const docker = resticDocker((cmd) =>
    cmd[1] === 'cat' ? { code: 1, err: 'wrong password for sekret-value-1' } : { code: 0 },
  );
  const s = await server(docker, { TUG_CONTROL_BACKUP_RETRY_MS: '3600000' });
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.problem ? control : undefined;
    }, 'the failure to be reported');
    assert.match(control.problem, /control backup failed/, 'the problem says what failed');
    assert.ok(
      !JSON.stringify(control).includes('sekret-value-1'),
      'the destination secret never appears in the report',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      docker.calls.filter((c) => c.startsWith('create tug-control-backup')).length,
      1,
      'a failed backup waits for the retry delay',
    );
  } finally {
    await s.close();
  }
});

test('restore from the destination reads the newest control snapshot with the supplied login', async () => {
  const source = await server(resticDocker());
  let archive: Buffer;
  try {
    const backup = await json(await call(source.base, 'POST', '/api/v1/control/backups/run', {}));
    archive = await fs.readFile(backup.artifactRef);
  } finally {
    await source.close();
  }
  const docker = resticDocker((cmd) =>
    cmd[1] === 'dump' ? { code: 0, out: archive } : { code: 0 },
  );
  const target = await server(docker);
  try {
    const refused = await call(target.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: { url: 'ftp://nope' },
    });
    assert.equal(
      refused.status,
      400,
      'an invalid destination is refused before anything is fetched',
    );
    const neither = await call(target.base, 'POST', '/api/v1/control/restore', { confirm: true });
    assert.equal(neither.status, 400, 'a restore must name an archive or a destination');

    const res = await call(target.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: DESTINATION,
    });
    assert.equal(
      res.status,
      200,
      `the restore succeeds: ${JSON.stringify(await res.clone().json())}`,
    );
    assert.equal((await json(res)).restartRequired, true, 'a restart is required afterwards');
    assert.ok(
      docker.calls.some((c) => c.includes('restic dump latest /control.tar.gz')),
      'the newest snapshot of the control repository is read',
    );
    await assert.rejects(
      () => fs.stat(path.join(target.dir, 'control-restore-download.tar.gz')),
      'the fetched archive is removed after the restore',
    );
  } finally {
    await target.close();
  }
});

test('restore from the destination reports an empty destination without touching control', async () => {
  const docker = resticDocker((cmd) =>
    cmd[1] === 'cat'
      ? { code: 1, err: 'Is there a repository at the following location?' }
      : { code: 0 },
  );
  const s = await server(docker);
  try {
    const res = await call(s.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: DESTINATION,
    });
    assert.equal(res.status, 400, 'a destination without a control backup is refused');
    assert.match((await json(res)).error, /no control backup was found/, 'the reason is stated');
    const still = await call(s.base, 'GET', '/api/v1/backups');
    assert.equal(still.status, 200, 'control keeps serving, so nothing was restored');
  } finally {
    await s.close();
  }
});
