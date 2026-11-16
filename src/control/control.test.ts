import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { until } from '../../tests/wait.ts';
import { recordEvent } from './credentials.ts';
import { WRITER_OVERDUE_AFTER_MS } from './writer-queue.ts';
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
  return { base, dir, close: () => new Promise((resolve) => srv.close(resolve)) };
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

test('readiness stays responsive behind an overdue deploy and recovers when the writer completes', async () => {
  let time = 1000;
  let entered = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = await server({
    writerClock: () => time,
    images: {
      resolve: async (...args) => {
        entered = true;
        await blocked;
        return testImageResolver(args[0]);
      },
    },
  });
  let deployment: Promise<Response> | undefined;
  try {
    await fetch(s.base + '/api/v1/nodes/register', {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ name: 'n1' }),
    });
    deployment = fetch(s.base + '/api/v1/deployments', {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({
        project: 'site',
        version: 'v1',
        compose: {
          services: { web: { image: 'nginx', 'x-tug': { placement: { nodes: ['n1'] } } } },
        },
      }),
    });
    await until(() => entered, 'deployment to hold the writer during image resolution');
    let response = await fetch(s.base + '/api/v1/readyz', {
      headers: op(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, 'a normal in-progress deploy stays ready');
    time += WRITER_OVERDUE_AFTER_MS + 1;
    response = await fetch(s.base + '/api/v1/readyz', {
      headers: op(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      response.status,
      503,
      'an overdue active writer makes readiness fail without waiting',
    );
    assert.equal(
      (await json(response)).checks.writer,
      'overdue',
      'readiness identifies the overdue writer',
    );
    release();
    assert.equal(
      (await deployment).status,
      200,
      'the deployment still completes after readiness failed',
    );
    response = await fetch(s.base + '/api/v1/readyz', { headers: op() });
    assert.equal(response.status, 200, 'readiness recovers after writer completion');
  } finally {
    release();
    await deployment;
    await s.close();
  }
});

test('webhook delivery cannot block readiness and omits private event details', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies: string[] = [];
  const s = await server({
    notificationTickMs: 10,
    webhook: {
      url: 'https://receiver.example.test/hooks',
      secret: 'test-signing-key',
      fetch: async (_url, options) => {
        bodies.push(String(options?.body));
        await blocked;
        return new Response('', { status: 200 });
      },
    },
  });
  const db = await openDb(path.join(s.dir, 'tug.db'));
  try {
    recordEvent(db, {
      actor: 'test',
      type: 'backup.failed',
      message: 'private-bucket-secret',
      metadata: { command: 'private-password' },
    });
    await until(
      () => bodies.length > 0,
      'a committed backup failure to be delivered without a watcher',
    );
    const ready = await fetch(s.base + '/api/v1/readyz', {
      headers: op(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready.status, 200, 'blocked receiver leaves readiness responsive');
    const metrics = await (await fetch(s.base + '/api/v1/metrics', { headers: op() })).text();
    assert.match(
      metrics,
      /# TYPE tug_webhook_delivered_total counter/,
      'delivery totals use Prometheus counter semantics',
    );
    assert.match(
      metrics,
      /# TYPE tug_webhook_pending gauge/,
      'pending delivery is a current-value gauge',
    );
    assert.ok(
      !bodies[0].includes('private-'),
      'outbound notification omits raw message and metadata',
    );
    release();
  } finally {
    release();
    db.close();
    await s.close();
  }
});

test('configured writer admission returns Retry-After and preserves accepted deployments', async () => {
  const previous = process.env.TUG_WRITER_MAX_PENDING;
  process.env.TUG_WRITER_MAX_PENDING = '1';
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  let s: Awaited<ReturnType<typeof server>>;
  try {
    s = await server({
      images: {
        resolve: async (image) => {
          entered = true;
          await blocked;
          return testImageResolver(image);
        },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.TUG_WRITER_MAX_PENDING;
    else process.env.TUG_WRITER_MAX_PENDING = previous;
  }
  let first: Promise<Response> | undefined;
  let second: Promise<Response> | undefined;
  try {
    await fetch(s.base + '/api/v1/nodes/register', {
      method: 'POST',
      headers: op(),
      body: JSON.stringify({ name: 'n1' }),
    });
    const deploy = (project: string) =>
      fetch(s.base + '/api/v1/deployments', {
        method: 'POST',
        headers: op(),
        body: JSON.stringify({
          project,
          version: 'v1',
          compose: { services: { web: { image: 'nginx' } } },
        }),
      });
    first = deploy('first');
    await until(() => entered, 'the first deployment to acquire the writer');
    second = deploy('second');
    await until(
      async () =>
        /tug_writer_queue_depth 1\b/.test(
          await (await fetch(s.base + '/api/v1/metrics', { headers: op() })).text(),
        ),
      'the second deployment to enter the configured queue',
    );
    const overflow = await deploy('overflow');
    assert.equal(
      overflow.status,
      503,
      'excess operator work is refused before changing desired state',
    );
    assert.equal(
      overflow.headers.get('retry-after'),
      '5',
      'overloaded clients get a bounded retry hint',
    );
    release();
    assert.equal(
      (await first).status,
      200,
      'active work completes despite refused excess admission',
    );
    assert.equal((await second).status, 200, 'accepted queued work completes in order');
  } finally {
    release();
    await first;
    await second;
    await s.close();
  }
});

test('invalid optional webhook configuration disables delivery without disabling control', async () => {
  const s = await server({ webhook: { url: 'http://not-https.example.test', secret: 'private' } });
  try {
    const response = await fetch(s.base + '/api/v1/readyz', { headers: op() });
    assert.equal(
      response.status,
      200,
      'optional notification misconfiguration cannot take control offline',
    );
  } finally {
    await s.close();
  }
});

test('aborted requests are logged without their incomplete body', async (t) => {
  const { request } = await import('node:http');
  let entered = false;
  const s = await server({
    identity: (req, db) => {
      entered = true;
      return testIdentity(req, db);
    },
  });
  const lines: string[] = [];
  const original = process.stderr.write;
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const pending = request(s.base + '/api/v1/deployments', { method: 'POST', headers: op() });
  pending.on('error', () => {});
  try {
    pending.write('{"private":"never-log-this-body"');
    await until(() => entered, 'the server to accept request headers before an aborted upload');
    pending.destroy();
    await until(
      () => lines.some((line) => line.includes('request aborted')),
      'an aborted request to be recorded without a finish event',
    );
    assert.doesNotMatch(
      lines.join('\n'),
      /never-log-this-body/,
      'request diagnostics never serialize incomplete request bodies',
    );
  } finally {
    pending.destroy();
    process.stderr.write = original;
    await s.close();
  }
});
