import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { openDb } from './db.ts';
import { decrypt } from './secrets.ts';
import { json, testImageResolver, testIdentity } from '../tests/helpers.ts';
import { repositoryPassword } from './backup-destination.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-bkdest-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({ identity: testIdentity, images: { resolve: testImageResolver } });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    dbFile: path.join(dir, 'tug.db'),
    keyFile: path.join(dir, 'master.key'),
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}
const headers: Record<string, string> = {
  'x-tug-test-operator': 'operator',
  'content-type': 'application/json',
};
const call = (base: string, method: string, route: string, body?: unknown, h = headers) =>
  fetch(`${base}${route}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
const destination = {
  url: 's3:https://s3.example.com/bucket/tug',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
};

test('the destination is stored encrypted and its values never leave control through the API', async () => {
  const s = await server();
  try {
    assert.deepEqual(await json(await call(s.base, 'GET', '/api/v1/backup/destination')), {
      configured: false,
    });
    const set = await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    assert.equal(set.status, 200, 'an admin can set the destination');
    const shown = await call(s.base, 'GET', '/api/v1/backup/destination');
    const text = await shown.text();
    assert.ok(
      !text.includes('sekret-value-1'),
      'the secret value should not appear in the response',
    );
    const body = JSON.parse(text);
    assert.equal(body.url, destination.url, 'the url is shown');
    assert.deepEqual(
      body.envNames,
      ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      'names are shown',
    );

    const db = await openDb(s.dbFile);
    const row = db.get<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM secrets WHERE project_id='_backup' AND name='AWS_SECRET_ACCESS_KEY'",
    );
    assert.ok(row, 'the value is kept in the secrets table under the reserved project');
    assert.ok(!row.encrypted_value.includes('sekret'), 'the stored value is encrypted');
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(decrypt(row.encrypted_value, key), 'sekret-value-1', 'the master key decrypts it');
    const events = db.all<{ message: string; metadata_json: string }>(
      "SELECT message,metadata_json FROM events WHERE type='backup.destination_set'",
    );
    assert.equal(events.length, 1, 'setting the destination is audited');
    assert.ok(
      !JSON.stringify(events).includes('sekret'),
      'the audit event should not contain the secret',
    );
  } finally {
    await s.close();
  }
});

test('setting a destination replaces the previous variables and an invalid one changes nothing', async () => {
  const s = await server();
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const bad = await call(s.base, 'POST', '/api/v1/backup/destination', { url: 's3:https://h/b' });
    assert.equal(bad.status, 400, 'a destination without credentials is rejected');
    assert.match((await json(bad)).error, /need AWS_ACCESS_KEY_ID/);
    const unchanged = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
    assert.equal(unchanged.url, destination.url, 'the stored destination is untouched');

    await call(s.base, 'POST', '/api/v1/backup/destination', { url: '/srv/restic', env: {} });
    const db = await openDb(s.dbFile);
    assert.equal(
      db.all("SELECT 1 FROM secrets WHERE project_id='_backup'").length,
      0,
      'the old credentials are removed',
    );
    const removed = await json(await call(s.base, 'DELETE', '/api/v1/backup/destination'));
    assert.equal(removed.removed, true, 'the destination can be removed');
    assert.equal(
      (await json(await call(s.base, 'GET', '/api/v1/backup/destination'))).configured,
      false,
    );
  } finally {
    await s.close();
  }
});

test('destination and key endpoints are admin only', async () => {
  const s = await server();
  try {
    const created = await json(
      await call(s.base, 'POST', '/api/v1/credentials', { name: 'ci', role: 'deploy' }),
    );
    const ci = { 'x-tug-test-credential': created.credential, 'content-type': 'application/json' };
    for (const [method, route] of [
      ['GET', '/api/v1/backup/destination'],
      ['POST', '/api/v1/backup/destination'],
      ['DELETE', '/api/v1/backup/destination'],
      ['GET', '/api/v1/backup/repository-password?project=site'],
    ])
      assert.equal(
        (await call(s.base, method, route, method === 'POST' ? destination : undefined, ci)).status,
        403,
        `${method} ${route} should need admin`,
      );
  } finally {
    await s.close();
  }
});

test('the project repository password is derived from the master key and audited', async () => {
  const s = await server();
  try {
    assert.equal(
      (await call(s.base, 'GET', '/api/v1/backup/repository-password?project=ghost')).status,
      404,
      'an unknown project has no key',
    );
    await call(s.base, 'POST', '/api/v1/projects', { name: 'site' });
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const body = await json(
      await call(s.base, 'GET', '/api/v1/backup/repository-password?project=site'),
    );
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(body.password, repositoryPassword(key, 'site'), 'the password is derived');
    assert.equal(
      body.repository,
      's3:https://s3.example.com/bucket/tug/site',
      'one repo per project',
    );
    const db = await openDb(s.dbFile);
    assert.equal(
      db.all("SELECT 1 FROM events WHERE type='backup.key_read'").length,
      1,
      'reading the key is audited',
    );
  } finally {
    await s.close();
  }
});

test('the reserved backup project cannot be reached through the secrets API', async () => {
  const s = await server();
  try {
    for (const [method, route, body] of [
      ['POST', '/api/v1/secrets', { project: '_backup', name: 'X', value: 'y' }],
      ['GET', '/api/v1/secrets?project=_backup', undefined],
      ['DELETE', '/api/v1/secrets/X?project=_backup', undefined],
    ] as const)
      assert.equal(
        (await call(s.base, method, route, body)).status,
        400,
        `${method} ${route} should refuse a reserved project`,
      );
  } finally {
    await s.close();
  }
});

test('credentials are released only to the owning node for a running backup command', async () => {
  const s = await server();
  try {
    await call(s.base, 'POST', '/api/v1/projects', { name: 'site' });
    const n1 = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
    const n2 = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n2' }));
    const deployOn = (version: string, node: string) =>
      call(s.base, 'POST', '/api/v1/deployments', {
        project: 'site',
        version,
        compose: {
          services: { web: { image: 'nginx', 'x-tug': { placement: { nodes: [node] } } } },
        },
      });
    assert.equal((await deployOn('v1', 'n1')).status, 200, 'the project is placed on n1');
    const db = await openDb(s.dbFile);
    const ids = db.all<{ id: string; name: string }>('SELECT id,name FROM nodes');
    const nodeId = (name: string) => ids.find((n) => n.name === name)!.id;
    const insert = (id: string, node: string, type: string, state: string) =>
      db.run(
        'INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        nodeId(node),
        'site',
        type,
        state,
        '{}',
        0,
        'now',
        'now',
      );
    insert('cmd_run', 'n1', 'backup.run', 'running');
    insert('cmd_pending', 'n1', 'backup.run', 'pending');
    insert('cmd_other', 'n1', 'service.restart', 'running');
    const fetchCredentials = (nodeId: string, command: string) =>
      fetch(`${s.base}/agent/v1/backup/credentials?command=${command}`, {
        headers: { 'x-tug-test-node': nodeId },
      });

    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_run')).status,
      409,
      'no credentials before a destination exists',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);

    const ok = await fetchCredentials(n1.nodeId, 'cmd_run');
    assert.equal(ok.status, 200, 'the running backup command gets its credentials');
    const { env } = await json(ok);
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'sekret-value-1', 'destination variables are released');
    assert.equal(
      env.RESTIC_PASSWORD,
      repositoryPassword(key, 'site'),
      'the project password is released',
    );

    assert.equal(
      (await fetchCredentials(n2.nodeId, 'cmd_run')).status,
      403,
      'another node is refused',
    );
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_pending')).status,
      409,
      'a pending command is refused',
    );
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_other')).status,
      403,
      'a non-backup command is refused',
    );
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_missing')).status,
      404,
      'an unknown command is refused',
    );
    assert.equal(
      (await fetch(`${s.base}/agent/v1/backup/credentials?command=cmd_run`, { headers })).status,
      403,
      'an operator credential is not a node credential',
    );

    db.run("UPDATE deployments SET state='succeeded'");
    assert.equal((await deployOn('v2', 'n2')).status, 200, 'the project moves to n2');
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_run')).status,
      403,
      'a running command on a node the project left is refused credentials',
    );
  } finally {
    await s.close();
  }
});
