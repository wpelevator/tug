import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { testImageResolver, testIdentity } from '../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { json } from '../tests/helpers.ts';
import { openDb } from './db.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lock-'));
  const dbFile = path.join(dir, 'tug.db');
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({ identity: testIdentity, images: { resolve: testImageResolver } });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    dbFile,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}
const headers = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
const compose = {
  services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } },
};

test('a stale lock is purged and no longer blocks new operations', async () => {
  const s = await server();
  try {
    const db = await openDb(s.dbFile);
    const expired = new Date(Date.now() - 60_000).toISOString();
    db.run(
      'INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)',
      'project:site',
      'deploy:lock_stale',
      expired,
      new Date(Date.now() - 120_000).toISOString(),
    );

    const res = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project: 'site', version: 'v1', compose }),
    });
    assert.equal(res.status, 200, await res.text());

    let remaining;
    for (let i = 0; i < 20; i++) {
      remaining = db.get('SELECT * FROM locks WHERE name=?', 'project:site');
      if (!remaining) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(remaining, undefined);
  } finally {
    await s.close();
  }
});

test('an active (non-expired) lock blocks a conflicting operation with owner/expiry info', async () => {
  const s = await server();
  try {
    const db = await openDb(s.dbFile);
    const future = new Date(Date.now() + 60_000).toISOString();
    db.run(
      'INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)',
      'project:site',
      'restore:lock_active',
      future,
      new Date().toISOString(),
    );

    const res = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project: 'site', version: 'v1', compose }),
    });
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.lock.owner, 'restore:lock_active');
    assert.equal(body.lock.expires_at, future);
    assert.match(body.error, /locked by restore:lock_active/);
  } finally {
    await s.close();
  }
});

test('concurrent deploy requests for the same project: only one acquires the lock', async () => {
  const s = await server();
  try {
    const fire = () =>
      fetch(`${s.base}/api/v1/deployments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ project: 'site', version: `v-${Math.random()}`, compose }),
      });
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    await s.close();
  }
});
