import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
import { backupCheckProblems } from '../backup/check.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { json, testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const op: Record<string, string> = {
  'x-tug-test-operator': 'operator',
  'content-type': 'application/json',
};
const call = (
  base: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = op,
) => fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
const DESTINATION = {
  url: 's3:https://s3.example.com/bucket/tug',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
};
const SUMMARY = '{"message_type":"summary","snapshot_id":"snap1234"}\n';

async function server(docker: FakeDocker) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-retention-'));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TUG_DATA_DIR: dir,
    TUG_CONTROL_BACKUP_DIR: path.join(dir, 'control-backups'),
    TUG_RESTIC_IMAGE: 'restic/restic:0.17.3',
    // The scheduler never ticks, so only the pushes a test asks for run.
    TUG_BACKUP_TICK_MS: '3600000',
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
    dbFile: path.join(dir, 'tug.db'),
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
const resticDocker = (forget: () => { code: number; err?: string }): FakeDocker => {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.17.3');
  docker.execResponder = (cmd) =>
    cmd[1] === 'backup' ? { code: 0, out: SUMMARY } : cmd[1] === 'forget' ? forget() : { code: 0 };
  return docker;
};
const pushControl = (base: string) =>
  call(base, 'POST', '/api/v1/control/backups/run', { toDestination: true });
const listing = async (base: string) => json(await call(base, 'GET', '/api/v1/backups'));
const events = (dbFile: string, type: string) =>
  openDb(dbFile).then((db) =>
    db.all<{ message: string; metadata_json: string }>(
      'SELECT message,metadata_json FROM events WHERE type=?',
      type,
    ),
  );

test('the retention mode is stored with the destination, shown, kept for the same url and reset for another', async () => {
  const s = await server(resticDocker(() => ({ code: 0 })));
  try {
    const set = await json(
      await call(s.base, 'POST', '/api/v1/backup/destination', {
        ...DESTINATION,
        retention: 'external',
      }),
    );
    assert.equal(set.retention, 'external', 'the answer to set reports the mode');
    const shown = async () => json(await call(s.base, 'GET', '/api/v1/backup/destination'));
    assert.equal((await shown()).retention, 'external', 'show reports the mode');

    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    assert.equal(
      (await shown()).retention,
      'external',
      'rotating credentials for the same destination keeps pruning off instead of silently turning it back on',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 's3:https://other.example.com/bucket/tug',
      env: DESTINATION.env,
    });
    assert.equal((await shown()).retention, 'managed', 'a different destination starts managed');
    const bad = await call(s.base, 'POST', '/api/v1/backup/destination', {
      ...DESTINATION,
      retention: 'sometimes',
    });
    assert.equal(bad.status, 400, 'an unknown mode is rejected');
    assert.match((await json(bad)).error, /managed.*external/, 'the error names the choices');
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      ...DESTINATION,
      retention: 'external',
    });
    await call(s.base, 'DELETE', '/api/v1/backup/destination');
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    assert.equal((await shown()).retention, 'managed', 'removing the destination forgets the mode');
  } finally {
    await s.close();
  }
});

test('setting only the retention on the destination in use keeps its credentials and its check result', async () => {
  const s = await server(resticDocker(() => ({ code: 0 })));
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const db = await openDb(s.dbFile);
    const before = db.get<{ updated_at: string }>('SELECT updated_at FROM backup_destination')!;
    const mode = await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: DESTINATION.url,
      retention: 'external',
    });
    assert.equal(mode.status, 200, 'the mode changes without credentials in the request');
    const shown = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
    assert.deepEqual(
      shown.envNames,
      ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      'the stored credentials are untouched',
    );
    assert.equal(shown.retention, 'external', 'the mode is set');
    assert.equal(
      db.get<{ updated_at: string }>('SELECT updated_at FROM backup_destination')!.updated_at,
      before.updated_at,
      'the destination is not treated as replaced, so a stored check result stays valid',
    );
    const other = await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 's3:https://other.example.com/bucket/tug',
      retention: 'external',
    });
    assert.equal(
      other.status,
      400,
      'another url without credentials is a new destination and needs them',
    );
  } finally {
    await s.close();
  }
});

test('destination set and the backup listing keep their roles: set is admin, the listing is readable', async () => {
  const s = await server(resticDocker(() => ({ code: 0 })));
  try {
    const created = await json(
      await call(s.base, 'POST', '/api/v1/credentials', { name: 'ci', role: 'deploy' }),
    );
    const ci = { 'x-tug-test-credential': created.credential, 'content-type': 'application/json' };
    assert.equal(
      (
        await call(
          s.base,
          'POST',
          '/api/v1/backup/destination',
          { ...DESTINATION, retention: 'external' },
          ci,
        )
      ).status,
      403,
      'a deploy credential cannot change who prunes the destination',
    );
    assert.equal(
      (await call(s.base, 'GET', '/api/v1/backups', undefined, ci)).status,
      200,
      'a deploy credential can read the listing that carries the retention fields',
    );
  } finally {
    await s.close();
  }
});

test("control's own backup reports retention, alerts once on a failing prune and once on recovery", async () => {
  let forget = { code: 1, err: 'Fatal: unlock: access denied' };
  const s = await server(resticDocker(() => forget));
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    assert.equal((await pushControl(s.base)).status, 200, 'the backup itself succeeds');
    let control = (await listing(s.base)).control;
    assert.equal(control.retention.state, 'failed', 'the prune failure is reported as data');
    assert.equal(control.retention.failures, 1, 'one failure so far');
    assert.deepEqual(
      backupCheckProblems({ destinationConfigured: true, targets: [], control }),
      [],
      'one failed prune does not fail a monitor',
    );
    await pushControl(s.base);
    control = (await listing(s.base)).control;
    assert.equal(control.retention.failures, 2, 'two in a row');
    assert.match(
      backupCheckProblems({ destinationConfigured: true, targets: [], control })[0],
      /^control: retention is failing/,
      'two consecutive failures fail a monitor',
    );
    assert.equal(
      (await events(s.dbFile, 'backup.retention_failed')).length,
      1,
      'a second failure is not another alert',
    );
    forget = { code: 0, err: '' };
    await pushControl(s.base);
    control = (await listing(s.base)).control;
    assert.deepEqual(control.retention, { state: 'ok', failures: 0 }, 'a working prune clears it');
    assert.equal(
      (await events(s.dbFile, 'backup.retention_recovered')).length,
      1,
      'recovery is announced once',
    );
  } finally {
    await s.close();
  }
});

test("a prune that fails on restic's lock exit is a lock and fails a monitor at once", async () => {
  const s = await server(resticDocker(() => ({ code: 11, err: 'repository is already locked' })));
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    await pushControl(s.base);
    const control = (await listing(s.base)).control;
    assert.equal(control.retention.locked, true, 'exit 11 marks the retention failure as locked');
    assert.notEqual(control.lock, null, 'the listing says the repository is locked');
    assert.match(
      backupCheckProblems({ destinationConfigured: true, targets: [], control })[0],
      /repository is locked/,
      'one lock failure is enough to fail a monitor',
    );
  } finally {
    await s.close();
  }
});

test('an external destination skips the prune for control and reports retention external without events', async () => {
  const docker = resticDocker(() => ({ code: 1, err: 'append-only' }));
  const s = await server(docker);
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      ...DESTINATION,
      retention: 'external',
    });
    assert.equal((await pushControl(s.base)).status, 200, 'the backup succeeds');
    assert.ok(
      !docker.execLog.some((exec) => exec.cmd[1] === 'forget'),
      'forget --prune is never run against an append-only destination',
    );
    const control = (await listing(s.base)).control;
    assert.deepEqual(
      control.retention,
      { state: 'external', failures: 0 },
      'retention is reported as external',
    );
    assert.deepEqual(
      backupCheckProblems({ destinationConfigured: true, targets: [], control }),
      [],
      'an append-only destination is healthy for a monitor',
    );
    assert.equal((await events(s.dbFile, 'backup.retention_failed')).length, 0, 'no alert');
  } finally {
    await s.close();
  }
});

test("a control backup that fails on restic's lock exit records cause locked", async () => {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.17.3');
  docker.execResponder = (cmd) =>
    cmd[1] === 'backup' ? { code: 11, err: 'unable to create lock in backend' } : { code: 0 };
  const s = await server(docker);
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    assert.equal((await pushControl(s.base)).status, 502, 'the backup fails');
    const control = (await listing(s.base)).control;
    assert.equal(control.cause, 'locked', 'the failure is classified by restic exit code');
    assert.notEqual(control.lock, null, 'the repository is reported locked');
    const [failed] = await events(s.dbFile, 'backup.failed');
    assert.equal(
      JSON.parse(failed.metadata_json).cause,
      'locked',
      'the existing backup.failed event carries cause locked',
    );
  } finally {
    await s.close();
  }
});
