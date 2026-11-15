import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { openDb } from '../db/db.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { json } from '../../tests/helpers.ts';

async function server(options: Parameters<typeof createApp>[0] = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({
    identity: (req, db) => {
      for (const role of ['read', 'deploy'] as const) {
        if (req.headers[`x-tug-test-${role}`]) {
          const id = `cred_test_${role}`;
          db.run(
            'INSERT OR IGNORE INTO operator_credentials(id,name,key_hash,role,created_at,created_by) VALUES(?,?,?,?,?,?)',
            id,
            role,
            `test-${role}`,
            role,
            new Date().toISOString(),
            'test',
          );
          return { uri: `tug:operator:${id}`, keyHash: `test-${role}` };
        }
      }
      return testIdentity(req, db);
    },
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
    ...options,
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((resolve) => srv.close(resolve)) };
}
function op() {
  return { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
}

test('readiness is protected by the read role and reports database failures without details', async () => {
  let failDatabaseProbe = false;
  const s = await server({
    openDatabase: async (filename) => {
      const db = await openDb(filename);
      return {
        get: (sql, ...values) => {
          if (failDatabaseProbe && sql === 'SELECT id FROM projects LIMIT 1')
            throw new Error('private sqlite path and details');
          return db.get(sql, ...values);
        },
        all: db.all.bind(db),
        run: db.run.bind(db),
        exec: db.exec.bind(db),
        close: db.close.bind(db),
      };
    },
  });
  try {
    let res = await fetch(`${s.base}/api/v1/readyz`);
    assert.equal(res.status, 401, 'readiness requires an authenticated operator credential');

    res = await fetch(`${s.base}/api/v1/readyz`, { headers: { 'x-tug-test-read': 'read' } });
    assert.equal(
      res.status,
      200,
      'a read credential gets readiness when the database probe succeeds',
    );
    assert.deepEqual(await json(res), {
      ready: true,
      checks: { database: 'ok', writer: 'ok' },
    });

    res = await fetch(`${s.base}/api/v1/readyz`, { headers: { 'x-tug-test-deploy': 'deploy' } });
    assert.equal(
      res.status,
      200,
      'higher-privilege operator credentials also satisfy the read role',
    );

    failDatabaseProbe = true;
    res = await fetch(`${s.base}/api/v1/readyz`, { headers: { 'x-tug-test-read': 'read' } });
    assert.equal(res.status, 503, 'a failed database probe makes readiness unavailable');
    const body = await json(res);
    assert.deepEqual(body, {
      ready: false,
      checks: { database: 'failed', writer: 'ok' },
    });
    assert.equal(
      JSON.stringify(body).includes('private sqlite'),
      false,
      'database errors stay private',
    );
  } finally {
    await s.close();
  }
});

test('registers node, stores secret, creates desired state, serves agent work', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/register`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ name: 'n1', address: '10.0.0.1' }),
    });
    assert.equal(res.status, 200);
    const registered = await json(res);
    assert.equal(registered.node.name, 'n1', 'registration returns the node identity');
    assert.match(
      registered.certificate,
      /BEGIN CERTIFICATE/,
      'registration returns a certificate for the node key',
    );

    res = await fetch(`${s.base}/api/v1/secrets`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', name: 'DB_PASSWORD', value: 'pw' }),
    });
    assert.equal(res.status, 200);

    const compose = {
      services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } },
    };
    res = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', version: 'git-a', compose }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${s.base}/agent/v1/work`, {
      headers: { 'x-tug-test-node': registered.nodeId },
    });
    let work = await json(res);
    assert.equal(work.desiredStates[0].version, 'git-a');

    res = await fetch(`${s.base}/api/v1/restart`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', service: 'web' }),
    });
    assert.equal(res.status, 200);
    const restart = await json(res);
    res = await fetch(`${s.base}/api/v1/logs`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', service: 'web', tail: 5 }),
    });
    assert.equal(res.status, 200);
    const command = await json(res);
    res = await fetch(`${s.base}/agent/v1/work`, {
      headers: { 'x-tug-test-node': registered.nodeId },
    });
    work = await json(res);
    assert.equal(work.commands[0].id, restart.commandId);
    assert.equal(work.commands[1].id, command.commandId);
    res = await fetch(`${s.base}/agent/v1/status`, {
      method: 'POST',
      headers: {
        'x-tug-test-node': registered.nodeId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        projects: [
          {
            project: 'site',
            observedVersion: 'git-a',
            observedRevision: work.desiredStates[0].revision,
            health: 'serving',
          },
        ],
        commandResults: [
          { commandId: restart.commandId, state: 'succeeded', result: { restarted: true } },
          { commandId: command.commandId, state: 'succeeded', result: { stdout: 'ok' } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/commands/${command.commandId}`, { headers: op() });
    assert.equal((await json(res)).state, 'succeeded');
    res = await fetch(`${s.base}/api/v1/status`, { headers: op() });
    const status = await json(res);
    assert.equal(status.deployments[0].state, 'succeeded');
  } finally {
    await s.close();
  }
});

test('failed node status fails deployment and unblocks future deploys', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/register`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ name: 'n1' }),
    });
    const registered = await json(res);
    const compose = {
      services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } },
    };
    res = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', version: 'bad', compose }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', version: 'blocked', compose }),
    });
    assert.equal(res.status, 409);
    res = await fetch(`${s.base}/agent/v1/status`, {
      method: 'POST',
      headers: {
        'x-tug-test-node': registered.nodeId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        projects: [
          {
            project: 'site',
            observedVersion: 'bad',
            observedRevision: (
              await json(
                await fetch(`${s.base}/agent/v1/work`, {
                  headers: { 'x-tug-test-node': registered.nodeId },
                }),
              )
            ).desiredStates[0].revision,
            health: 'failed',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ project: 'site', version: 'good', compose }),
    });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});
