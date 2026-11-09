import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { json, testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { DatabaseSync } from 'node:sqlite';
import type { ActivationStep } from './restore-activation.ts';
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

async function server(
  docker: FakeDocker,
  env: Record<string, string> = {},
  extra: { dir?: string; restoreAfterStep?: (step: ActivationStep) => void } = {},
) {
  const dir = extra.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'tug-ctlbak-')));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TUG_DATA_DIR: dir,
    TUG_CONTROL_BACKUP_DIR: path.join(dir, 'control-backups'),
    TUG_CONTROL_RESTORE_DIR: path.join(dir, 'control-restore'),
    TUG_BACKUP_TICK_MS: '20',
    ...env,
  })) {
    saved[key] = process.env[key];
    // '@data' points a setting at the data directory itself, the misconfiguration some tests need.
    process.env[key] = value === '@data' ? dir : value;
  }
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
    docker,
    restoreAfterStep: extra.restoreAfterStep,
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    dir,
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    /** `keepDir` leaves the data directory for a second control to start on, as after a crash or a restore. */
    close: async (keepDir = false) => {
      await new Promise((resolve) => srv.close(resolve));
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      // A nightly push still staging when the test ends can add files mid-removal.
      if (!keepDir)
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
const controlPassword = async (base: string): Promise<string> =>
  (await json(await call(base, 'GET', '/api/v1/backup/repository-password?control=1'))).password;
const listing = async (base: string) => json(await call(base, 'GET', '/api/v1/backups'));

test('control backup archives can be downloaded byte for byte, and only the ones control made', async () => {
  const s = await server(resticDocker());
  try {
    const backup = await json(await call(s.base, 'POST', '/api/v1/control/backups/run', {}));
    assert.equal(backup.stored, 'control-host', 'an archive says it is on the control host');
    const res = await call(s.base, 'GET', `/api/v1/control/backups/${backup.backupId}/download`);
    assert.equal(res.status, 200, 'an existing control backup downloads');
    assert.equal(
      res.headers.get('cache-control'),
      'no-store',
      'an archive full of keys must not be cached by anything on the way',
    );
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
    const audit = JSON.stringify(await json(await call(s.base, 'GET', '/api/v1/events')));
    assert.ok(
      audit.includes('control.backup_download') && audit.includes('control.backup'),
      'creating and downloading a control backup are both audited',
    );
    const db = new DatabaseSync(path.join(s.dir, 'tug.db'));
    db.prepare(
      "INSERT INTO backups(id,project_id,target,state,artifact_ref,metadata_json,created_at) VALUES('cbak_destination','_control','control-destination','completed',?,'{}','2026-01-01T00:00:00.000Z')",
    ).run(backup.artifactRef);
    db.close();
    const stored = await call(s.base, 'GET', '/api/v1/control/backups/cbak_destination/download');
    assert.equal(
      stored.status,
      404,
      'a row that is not a control-plane archive made by control backup is never served, even when it names a real file',
    );
    const missing = await call(s.base, 'GET', '/api/v1/control/backups/cbak_nope/download');
    assert.equal(missing.status, 404, 'an unknown backup id is not found');
  } finally {
    await s.close();
  }
});

test('with a destination control backs itself up into it without images and keeps no archive behind', async () => {
  const docker = resticDocker();
  const s = await server(docker);
  try {
    assert.equal(
      (await listing(s.base)).control,
      null,
      'control reports no control backup while there is no destination',
    );
    const created: { Env?: string[] }[] = [];
    const createContainer = docker.createContainer.bind(docker);
    docker.createContainer = async (name, body) => {
      created.push(body);
      return createContainer(name, body);
    };
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.lastSuccessAt ? control : undefined;
    }, 'the first control backup');
    const password = await controlPassword(s.base);
    assert.ok(
      created[0].Env?.includes(`RESTIC_PASSWORD=${password}`),
      'the helper opens the control repository with the password derived from the master key',
    );
    assert.ok(
      !created[0].Env?.some(
        (entry) =>
          entry.includes(DESTINATION.env.AWS_SECRET_ACCESS_KEY) &&
          entry.startsWith('RESTIC_PASSWORD'),
      ),
      'the destination secret plays no part in the repository password',
    );
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
  let password: string;
  try {
    password = await controlPassword(source.base);
    const backup = await json(await call(source.base, 'POST', '/api/v1/control/backups/run', {}));
    archive = await fs.readFile(backup.artifactRef);
  } finally {
    await source.close();
  }
  const docker = resticDocker((cmd) =>
    cmd[1] === 'dump' ? { code: 0, out: archive } : { code: 0 },
  );
  const created: { Env?: string[] }[] = [];
  const createContainer = docker.createContainer.bind(docker);
  docker.createContainer = async (name, body) => {
    created.push(body);
    return createContainer(name, body);
  };
  const target = await server(docker);
  try {
    const refused = await call(target.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: { url: 'ftp://nope', password },
    });
    assert.equal(
      refused.status,
      400,
      'an invalid destination is refused before anything is fetched',
    );
    const neither = await call(target.base, 'POST', '/api/v1/control/restore', { confirm: true });
    assert.equal(neither.status, 400, 'a restore must name an archive or a destination');

    for (const bad of [undefined, 'short', 'z'.repeat(64)]) {
      const noPassword = await call(target.base, 'POST', '/api/v1/control/restore', {
        confirm: true,
        fromDestination: { ...DESTINATION, password: bad },
      });
      assert.equal(
        noPassword.status,
        400,
        'a restore from the destination needs the control password from backup password --control',
      );
      assert.match((await json(noPassword)).error, /control password is required/);
    }
    const local = await call(target.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: { url: '/srv/backups', env: {}, password },
    });
    assert.equal(local.status, 400, 'a restore does not bind-mount a host path into a helper');
    const res = await call(target.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: { ...DESTINATION, password },
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
    assert.equal(created.length, 1, 'one helper reads the repository');
    assert.ok(
      created[0].Env?.includes(`RESTIC_PASSWORD=${password}`),
      "the helper opens the repository with the operator's escrowed password, not one derived on the new control",
    );
    assert.ok(
      created[0].Env?.includes('AWS_SECRET_ACCESS_KEY=sekret-value-1') &&
        created[0].Env?.includes('AWS_ACCESS_KEY_ID=AKIAEXAMPLE'),
      'the helper uses the credentials supplied with the restore',
    );
    assert.deepEqual(
      await fs.readdir(path.join(target.dir, 'control-restore')),
      [],
      'the extracted keys are not left on disk after a restore',
    );
    assert.deepEqual(
      (await fs.readdir(target.dir)).filter((name) => name.startsWith('control-restore-download')),
      [],
      'the fetched archive is removed after the restore',
    );
  } finally {
    await target.close();
  }
});

test('restore from the destination reports an empty destination without touching control', async () => {
  const docker = resticDocker((cmd) =>
    cmd[1] === 'cat'
      ? {
          code: 1,
          err: 'Fatal: unable to open config file: Stat: The specified key does not exist.\nIs there a repository at the following location?',
        }
      : { code: 0 },
  );
  const s = await server(docker);
  try {
    const res = await call(s.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: { ...DESTINATION, password: await controlPassword(s.base) },
    });
    assert.equal(res.status, 400, 'a destination without a control backup is refused');
    assert.match((await json(res)).error, /no control backup was found/, 'the reason is stated');
    const key = await fs.readFile(path.join(s.dir, 'master.key'), 'utf8');
    const again = await call(s.base, 'POST', '/api/v1/control/backups/run', {});
    assert.equal(
      again.status,
      200,
      'control is not waiting for a restart, so a refused restore changed nothing',
    );
    assert.equal(
      await fs.readFile(path.join(s.dir, 'master.key'), 'utf8'),
      key,
      'the master key is untouched by a refused restore',
    );
  } finally {
    await s.close();
  }
});

test('the control password route names the repository only once a destination exists', async () => {
  const s = await server(resticDocker());
  try {
    const before = await json(
      await call(s.base, 'GET', '/api/v1/backup/repository-password?control=1'),
    );
    assert.equal(before.repository, null, 'there is no repository before a destination is set');
    assert.match(
      before.password,
      /^[0-9a-f]{64}$/,
      'the password can be escrowed before a destination exists',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const after = await json(
      await call(s.base, 'GET', '/api/v1/backup/repository-password?control=1'),
    );
    assert.equal(
      after.repository,
      'https://s3.example.com/bucket/tug/_control'.replace('https://', 's3:https://'),
      'the control repository sits beside the project repositories',
    );
    assert.equal(after.password, before.password, 'the password is stable');
    assert.ok(
      JSON.stringify(await json(await call(s.base, 'GET', '/api/v1/events'))).includes(
        'backup.key_read',
      ),
      'reading the control password is audited',
    );
  } finally {
    await s.close();
  }
});

test('a restore that cannot read the repository reports it and keeps no download', async () => {
  const docker = resticDocker((cmd) =>
    cmd[1] === 'cat' ? { code: 1, err: 'wrong password or no key found' } : { code: 0 },
  );
  const s = await server(docker);
  try {
    const res = await call(s.base, 'POST', '/api/v1/control/restore', {
      confirm: true,
      fromDestination: { ...DESTINATION, password: 'a'.repeat(64) },
    });
    assert.equal(res.status, 400, 'a wrong password is refused');
    assert.match(
      (await json(res)).error,
      /wrong control password or credentials/,
      'the error names the likely cause',
    );
    assert.deepEqual(
      (await fs.readdir(s.dir)).filter((name) => name.startsWith('control-restore-download')),
      [],
      'no fetched file stays behind',
    );
  } finally {
    await s.close();
  }
});

test('archives a crash left behind are swept at startup, recent ones are kept', async () => {
  const docker = resticDocker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-ctlbak-sweep-'));
  const backups = path.join(dir, 'control-backups');
  await fs.mkdir(backups, { recursive: true });
  const orphan = path.join(backups, 'cbak_orphan.tar.gz');
  const fresh = path.join(backups, 'cbak_fresh.tar.gz');
  await fs.writeFile(orphan, 'old');
  await fs.writeFile(fresh, 'new');
  const old = new Date(Date.now() - 2 * 3600_000);
  await fs.utimes(orphan, old, old);
  const saved = { dir: process.env.TUG_DATA_DIR, backups: process.env.TUG_CONTROL_BACKUP_DIR };
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_CONTROL_BACKUP_DIR = backups;
  try {
    const app = await createApp({
      identity: testIdentity,
      controlUrl: testControlUrl,
      images: { resolve: testImageResolver },
      docker,
    });
    const srv = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x));
    });
    try {
      await until(
        async () => ((await fs.stat(orphan).catch(() => null)) ? undefined : true),
        'the orphan to be swept',
      );
      assert.ok(await fs.stat(fresh), 'a recent archive may still be being written, so it is kept');
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  } finally {
    for (const [key, value] of [
      ['TUG_DATA_DIR', saved.dir],
      ['TUG_CONTROL_BACKUP_DIR', saved.backups],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed control backup is retried after the retry delay and then reports success', async () => {
  let attempts = 0;
  const docker = resticDocker((cmd) => {
    if (cmd[1] === 'backup') {
      attempts++;
      return attempts === 1
        ? { code: 1, err: 'temporary store error' }
        : { code: 0, out: '{"message_type":"summary","snapshot_id":"snap2"}\n' };
    }
    return { code: 0 };
  });
  const s = await server(docker, { TUG_CONTROL_BACKUP_RETRY_MS: '100' });
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.lastSuccessAt ? control : undefined;
    }, 'the retry to succeed');
    assert.equal(attempts, 2, 'the failed backup is retried once the delay has passed');
    assert.equal(control.problem, null, 'a success after a failure clears the problem');
  } finally {
    await s.close();
  }
});

test('a control backup that never finishes shows as stale instead of silently doing nothing', async () => {
  let attempts = 0;
  const docker = resticDocker((cmd) => {
    if (cmd[1] !== 'backup') return { code: 0 };
    attempts++;
    return attempts === 1
      ? { code: 0, out: '{"message_type":"summary","snapshot_id":"snap1"}\n' }
      : undefined; // the second push hangs
  });
  const s = await server(docker, {
    TUG_CONTROL_BACKUP_INTERVAL_MS: '80',
    TUG_CONTROL_BACKUP_LIMIT_MS: '1500',
  });
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.problem ? control : undefined;
    }, 'the stale control backup to be reported');
    assert.match(
      control.problem,
      /no successful control backup since/,
      'a push that is stuck is reported once two intervals pass without a success',
    );
    assert.equal(attempts, 2, 'a stuck push is not started a second time');
  } finally {
    await s.close();
  }
});

test('startup removes what a crash left behind and leaves recent files alone', async () => {
  const docker = resticDocker();
  await docker.createContainer('tug-control-backup-dead', {
    Image: 'restic/restic:0.17.3',
    Labels: { 'tug.job': 'control-backup' },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-ctlbak-sweep2-'));
  const backups = path.join(dir, 'control-backups');
  await fs.mkdir(path.join(backups, 'cbak_old-staging'), { recursive: true });
  await fs.mkdir(path.join(backups, 'cbak_new-staging'), { recursive: true });
  await fs.writeFile(path.join(dir, 'control-restore-download-old.tar.gz'), 'x');
  await fs.mkdir(path.join(dir, 'control-restore', 'r_old'), { recursive: true });
  await fs.writeFile(path.join(dir, 'control-restore', 'r_old', '.tug-control-restore'), '');
  await fs.writeFile(path.join(dir, 'control-restore', 'r_old', 'master.key'), 'key');
  await fs.mkdir(path.join(dir, 'control-restore', 'someone-elses'), { recursive: true });
  const old = new Date(Date.now() - 2 * 3600_000);
  await fs.utimes(path.join(backups, 'cbak_old-staging'), old, old);
  await fs.utimes(path.join(dir, 'control-restore-download-old.tar.gz'), old, old);
  const keys = ['TUG_DATA_DIR', 'TUG_CONTROL_BACKUP_DIR', 'TUG_CONTROL_RESTORE_DIR'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_CONTROL_BACKUP_DIR = backups;
  delete process.env.TUG_CONTROL_RESTORE_DIR;
  try {
    const app = await createApp({
      identity: testIdentity,
      controlUrl: testControlUrl,
      images: { resolve: testImageResolver },
      docker,
    });
    const srv = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x));
    });
    try {
      await until(
        async () =>
          docker.calls.some((c) => c.startsWith('rm tug-control-backup-dead')) ? true : undefined,
        'the orphaned helper container to be removed',
      );
      await until(
        async () =>
          (await fs.stat(path.join(dir, 'control-restore', 'r_old')).catch(() => null))
            ? undefined
            : true,
        'the marked restore scratch directory to be removed',
      );
      assert.ok(
        await fs.stat(path.join(dir, 'control-restore', 'someone-elses')),
        'a directory Tug did not mark as its own is left alone, and so is the configured parent',
      );
      await assert.rejects(
        () => fs.stat(path.join(backups, 'cbak_old-staging')),
        'an old staging copy of the keys is removed',
      );
      await assert.rejects(
        () => fs.stat(path.join(dir, 'control-restore-download-old.tar.gz')),
        'an old fetched download is removed',
      );
      assert.ok(
        await fs.stat(path.join(backups, 'cbak_new-staging')),
        'a recent staging copy may still be in use, so it is kept',
      );
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  } finally {
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const archiveOf = async (base: string, images = true): Promise<string> =>
  (await json(await call(base, 'POST', '/api/v1/control/backups/run', { images }))).artifactRef;
const NOTHING_NIGHTLY = { TUG_BACKUP_TICK_MS: '3600000' };

test('a restore directory that points at the data directory costs nothing at startup', async () => {
  const s = await server(resticDocker(), { TUG_CONTROL_RESTORE_DIR: '@data' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const name of ['tug.db', 'master.key', 'pki'])
      assert.ok(
        await fs.stat(path.join(s.dir, name)),
        `${name} survives startup even when the restore directory is misconfigured to be the data directory`,
      );
    assert.equal(
      (await call(s.base, 'GET', '/api/v1/backups')).status,
      200,
      'control keeps serving',
    );
  } finally {
    await s.close();
  }
});

test('switching destination starts a backup there and reports the new one on its own record', async () => {
  const created: { Env?: string[] }[] = [];
  const docker = resticDocker();
  const createContainer = docker.createContainer.bind(docker);
  docker.createContainer = async (name, body) => {
    created.push(body);
    return createContainer(name, body);
  };
  const s = await server(docker);
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const first = await until(async () => {
      const { control } = await listing(s.base);
      return control?.lastSuccessAt ? control : undefined;
    }, 'the first destination to be backed up');
    assert.match(
      first.repository,
      /bucket\/tug\/_control$/,
      'the status names the destination in use',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 's3:https://s3.example.com/other/prefix',
      env: { AWS_ACCESS_KEY_ID: 'AKIAOTHER', AWS_SECRET_ACCESS_KEY: 'other-secret-2' },
    });
    const second = await until(async () => {
      const { control } = await listing(s.base);
      return control?.repository?.includes('other/prefix') && control.lastSuccessAt
        ? control
        : undefined;
    }, 'the new destination to be backed up');
    assert.ok(
      second.lastSuccessAt >= first.lastSuccessAt,
      'the new destination has a success of its own, not the old one inherited',
    );
    assert.equal(created.length, 2, 'a success in the old destination does not skip the new one');
    const pairs = created.map((body) => [
      body.Env?.find((entry) => entry.startsWith('RESTIC_REPOSITORY=')),
      body.Env?.find((entry) => entry.startsWith('AWS_SECRET_ACCESS_KEY=')),
    ]);
    assert.deepEqual(
      pairs,
      [
        [
          'RESTIC_REPOSITORY=s3:https://s3.example.com/bucket/tug/_control',
          'AWS_SECRET_ACCESS_KEY=sekret-value-1',
        ],
        [
          'RESTIC_REPOSITORY=s3:https://s3.example.com/other/prefix/_control',
          'AWS_SECRET_ACCESS_KEY=other-secret-2',
        ],
      ],
      'each push pairs one destination with its own credentials',
    );
  } finally {
    await s.close();
  }
});

test('a destination with no completed backup is reported as unprotected, not as the previous one was', async () => {
  const docker = resticDocker((cmd) => (cmd[1] === 'backup' ? undefined : { code: 0 }));
  const s = await server(docker, {
    TUG_CONTROL_BACKUP_RETRY_MS: '60',
    TUG_CONTROL_BACKUP_LIMIT_MS: '1500',
  });
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.problem ? control : undefined;
    }, 'the unprotected destination to be reported');
    assert.equal(control.lastSuccessAt, null, 'nothing has completed in this destination');
    assert.match(
      control.problem,
      /no control backup has completed in this destination since it was set/,
      'the report says the destination is unprotected',
    );
  } finally {
    await s.close();
  }
});

test('a local-path destination is labelled local, never off-host', async () => {
  const s = await server(resticDocker());
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', { url: '/srv/backups', env: {} });
    const control = await until(async () => {
      const { control } = await listing(s.base);
      return control?.lastSuccessAt ? control : undefined;
    }, 'the local backup');
    assert.equal(
      control.scope,
      'local',
      'a backup that lives on the same host is labelled local so it is not mistaken for protection',
    );
    assert.match(
      control.repository,
      /^\/srv\/backups\/_control$/,
      'the repository is the local path',
    );
  } finally {
    await s.close();
  }
});

test('a backup can be stored in the destination on demand and says where it went', async () => {
  const docker = resticDocker();
  const s = await server(docker, NOTHING_NIGHTLY);
  try {
    const none = await call(s.base, 'POST', '/api/v1/control/backups/run', { toDestination: true });
    assert.equal(none.status, 409, 'without a destination there is nowhere to store it');
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const res = await call(s.base, 'POST', '/api/v1/control/backups/run', { toDestination: true });
    assert.equal(res.status, 200, 'the backup is stored');
    const result = await json(res);
    assert.equal(result.snapshotId, 'snap1234', 'the snapshot id is returned');
    assert.equal(result.stored, 'destination', 'the result says it is in the destination');
    assert.equal(
      result.repository,
      's3:https://s3.example.com/bucket/tug/_control',
      'the repository it went to is returned',
    );
    const backup = docker.calls.find((c) => c.includes('restic backup'));
    assert.match(
      backup ?? '',
      /--tag images:none --tag tug:\S+ --tag trigger:manual/,
      'the snapshot says it has no images and that it was taken on demand',
    );
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'control-backups')),
      [],
      'no local archive is kept',
    );
    docker.execResponder = (cmd) =>
      cmd[1] === 'backup' ? { code: 1, err: 'store is full' } : { code: 0 };
    const failed = await call(s.base, 'POST', '/api/v1/control/backups/run', {
      toDestination: true,
    });
    assert.equal(
      failed.status,
      502,
      'a backup that could not be stored is an error, not a success',
    );
    assert.match((await json(failed)).error, /store is full/, 'the cause is reported');
  } finally {
    await s.close();
  }
});

test('the control backup list shows copies on the host and the snapshots really in the destination', async () => {
  const snapshots = JSON.stringify([
    {
      id: 'a'.repeat(64),
      short_id: 'aaaaaaaa',
      time: '2026-01-02T00:00:00Z',
      tags: ['control', 'images:none', 'tug:1.0.0'],
    },
  ]);
  const docker = resticDocker((cmd) =>
    cmd[1] === 'snapshots' ? { code: 0, out: snapshots } : { code: 0 },
  );
  const s = await server(docker, NOTHING_NIGHTLY);
  try {
    const bare = await json(await call(s.base, 'GET', '/api/v1/control/backups'));
    assert.equal(bare.remote, null, 'without a destination there is nothing remote to list');
    await archiveOf(s.base, false);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const listed = await json(await call(s.base, 'GET', '/api/v1/control/backups'));
    assert.equal(listed.local.length, 1, 'the local archive is listed');
    assert.equal(listed.local[0].images, false, 'it says it was taken without images');
    assert.equal(listed.local[0].onDisk, true, 'it is on disk');
    assert.equal(listed.remote.state, 'ok', 'the destination is readable');
    assert.equal(
      listed.remote.snapshots[0].shortId,
      'aaaaaaaa',
      'the snapshot comes from the destination itself',
    );
    docker.execResponder = (cmd) =>
      cmd[1] === 'cat' ? { code: 1, err: 'The specified bucket does not exist.' } : { code: 0 };
    const broken = await json(await call(s.base, 'GET', '/api/v1/control/backups'));
    assert.equal(
      broken.remote.state,
      'error',
      'an unreadable destination is an error, not an empty list',
    );
    assert.match(broken.remote.error, /cannot read the control repository/, 'the cause is shown');
  } finally {
    await s.close();
  }
});

test('a restore can be verified without applying it, and a named snapshot is the one that is read', async () => {
  const source = await server(resticDocker());
  let archive: Buffer;
  let artifact: string;
  let password: string;
  try {
    artifact = await archiveOf(source.base);
    archive = await fs.readFile(artifact);
    password = await controlPassword(source.base);
  } finally {
    await source.close(true);
  }
  const id = 'abcd1234';
  const docker = resticDocker((cmd) => {
    if (cmd[1] === 'snapshots')
      return {
        code: 0,
        out: JSON.stringify([
          { id: id.padEnd(64, '0'), short_id: id, time: '2026-01-01T00:00:00Z', tags: ['control'] },
        ]),
      };
    return cmd[1] === 'dump' ? { code: 0, out: archive } : { code: 0 };
  });
  const target = await server(docker);
  try {
    const key = await fs.readFile(path.join(target.dir, 'master.key'), 'utf8');
    const unconfirmed = await call(target.base, 'POST', '/api/v1/control/restore', {
      artifactRef: artifact,
    });
    assert.equal(
      unconfirmed.status,
      400,
      'a restore still needs confirmation unless it only verifies',
    );
    const verified = await call(target.base, 'POST', '/api/v1/control/restore', {
      artifactRef: artifact,
      verify: true,
    });
    assert.equal(verified.status, 200, 'a backup can be verified without confirmation');
    const summary = await json(verified);
    assert.equal(summary.verified, true, 'the answer says it was only verified');
    assert.equal(summary.images, true, 'it says whether the backup holds build images');
    assert.equal(typeof summary.projects, 'number', 'it says what the backup holds');
    assert.equal(
      await fs.readFile(path.join(target.dir, 'master.key'), 'utf8'),
      key,
      'verifying changes nothing live',
    );
    assert.equal(
      (await call(target.base, 'POST', '/api/v1/control/backups/run', {})).status,
      200,
      'verifying does not leave control waiting for a restart',
    );
    const named = await call(target.base, 'POST', '/api/v1/control/restore', {
      verify: true,
      fromDestination: { ...DESTINATION, password, snapshot: id },
    });
    assert.equal(
      named.status,
      200,
      `a named snapshot verifies: ${JSON.stringify(await named.clone().json())}`,
    );
    assert.ok(
      docker.calls.some((c) => c.includes(`restic dump ${id} /control.tar.gz`)),
      'the named snapshot, not the latest, is read',
    );
    const bad = await call(target.base, 'POST', '/api/v1/control/restore', {
      verify: true,
      fromDestination: { ...DESTINATION, password, snapshot: '--all' },
    });
    assert.equal(bad.status, 400, 'a snapshot that is not an id is refused');
  } finally {
    await target.close();
  }
});

test('a restore that fails between the database and the master key puts the previous state back', async () => {
  const source = await server(resticDocker());
  let artifact: string;
  try {
    artifact = await archiveOf(source.base);
  } finally {
    await source.close(true);
  }
  const first = await server(
    resticDocker(),
    {},
    {
      restoreAfterStep: (step) => {
        if (step === 'database') throw new Error('disk full');
      },
    },
  );
  const read = (name: string) => fs.readFile(path.join(first.dir, name), 'utf8');
  const key = await read('master.key');
  const ca = await read('pki/ca.crt');
  // A node that exists only in this control's own database tells the two generations of the database apart.
  await call(first.base, 'POST', '/api/v1/nodes/register', { name: 'only-in-the-original' });
  const dir = first.dir;
  try {
    const res = await call(first.base, 'POST', '/api/v1/control/restore', {
      artifactRef: artifact,
      confirm: true,
    });
    assert.equal(res.status, 500, 'the failure is reported');
    assert.match(
      (await json(res)).error,
      /previous state was put back/,
      'the operator is told nothing was lost',
    );
  } finally {
    await first.close(true);
  }
  const again = await server(resticDocker(), {}, { dir });
  try {
    assert.equal(
      await read('master.key'),
      key,
      'the master key is the one the database was written under',
    );
    assert.equal(await read('pki/ca.crt'), ca, 'the CA is the previous one');
    assert.equal(
      (await call(again.base, 'GET', '/api/v1/backups')).status,
      200,
      'control starts and serves',
    );
    const nodes = JSON.stringify(await json(await call(again.base, 'GET', '/api/v1/nodes')));
    assert.ok(
      nodes.includes('only-in-the-original'),
      'the database is the original one, not the half-restored one the failed restore had already written',
    );
    const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith('restore-'));
    assert.deepEqual(leftovers, [], 'no journal or previous generation is left behind');
  } finally {
    await again.close();
  }
});

test('after a restore the commands it carried are retired, not delivered to agents again', async () => {
  const source = await server(resticDocker());
  let artifact: string;
  let nodeId: string;
  try {
    nodeId = (await json(await call(source.base, 'POST', '/api/v1/nodes/register', { name: 'n1' })))
      .nodeId;
    const db = new DatabaseSync(path.join(source.dir, 'tug.db'));
    db.prepare(
      "INSERT INTO commands(id,node_id,project_id,type,state,payload_json,created_at,updated_at) VALUES('cmd_replay',?,'site','volume.delete','pending','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    ).run(nodeId);
    db.close();
    const before = await json(
      await fetch(`${source.base}/agent/v1/work`, { headers: { 'x-tug-test-node': nodeId } }),
    );
    assert.ok(
      before.commands.some((c: { id: string }) => c.id === 'cmd_replay'),
      'the original control would deliver the command',
    );
    // The first delivery marked it running; put it back to pending as it was when the backup was taken.
    const again = new DatabaseSync(path.join(source.dir, 'tug.db'));
    again.prepare("UPDATE commands SET state='pending' WHERE id='cmd_replay'").run();
    again
      .prepare(
        "INSERT INTO backup_runs(id,project_id,target,type,node_id,command_id,trigger,state,queued_at) VALUES('bkr_replay','site','volume:x','volume',?,'cmd_replay','manual','queued','2026-01-01T00:00:00.000Z')",
      )
      .run(nodeId);
    again.close();
    artifact = await archiveOf(source.base);
  } finally {
    await source.close(true);
  }
  const target = await server(resticDocker());
  const dir = target.dir;
  try {
    const res = await call(target.base, 'POST', '/api/v1/control/restore', {
      artifactRef: artifact,
      confirm: true,
    });
    assert.equal(res.status, 200, 'the restore succeeds');
  } finally {
    await target.close(true);
  }
  const restored = await server(resticDocker(), {}, { dir });
  try {
    const work = await json(
      await fetch(`${restored.base}/agent/v1/work`, { headers: { 'x-tug-test-node': nodeId } }),
    );
    assert.ok(
      !work.commands.some((c: { id: string }) => c.id === 'cmd_replay'),
      'a queued command carried in the backup is not delivered by the restored control',
    );
    const db2 = new DatabaseSync(path.join(dir, 'tug.db'));
    const row = db2.prepare("SELECT state FROM commands WHERE id='cmd_replay'").get() as {
      state: string;
    };
    assert.equal(row.state, 'cancelled', 'it stays in the history, retired');
    const run = db2.prepare("SELECT state FROM backup_runs WHERE id='bkr_replay'").get() as {
      state: string;
    };
    assert.equal(
      run.state,
      'missed',
      'the backup run of the retired command is closed instead of staying queued for ever',
    );
    assert.ok(
      JSON.stringify(await json(await call(restored.base, 'GET', '/api/v1/events'))).includes(
        'control.restore_activated',
      ),
      'the retirement is recorded as an event',
    );
    db2.close();
  } finally {
    await restored.close();
  }
});
