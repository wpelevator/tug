import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testIdentity, testImageResolver } from '../tests/helpers.ts';
import { generateWgKeyPair } from './mesh.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-reports-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_MESH = 'true';
  const app = await createApp({ identity: testIdentity, images: { resolve: testImageResolver } });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const operator: Record<string, string> = {
    'x-tug-test-operator': 'operator',
    'content-type': 'application/json',
  };
  const call = (method: string, route: string, body?: unknown, headers = operator) =>
    fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const register = async (name: string) => {
    const reg = await json(
      await call('POST', '/api/v1/nodes/register', {
        name,
        publicAddress: '203.0.113.1',
        wgPublicKey: generateWgKeyPair().publicKey,
      }),
    );
    const headers = { 'x-tug-test-node': reg.nodeId, 'content-type': 'application/json' };
    return {
      work: async () => json(await call('GET', '/agent/v1/work', undefined, headers)),
      status: (body: unknown) => call('POST', '/agent/v1/status', body, headers),
      credentials: (command: string) =>
        call('GET', `/agent/v1/backup/credentials?command=${command}`, undefined, headers),
    };
  };
  return {
    call,
    register,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

/** `web` on the given node, plus a `cache` on `b` so node `b` receives the project's endpoints too. */
const webOn = (node: string) => ({
  services: {
    web: { image: 'nginx', ports: ['8080:80'], 'x-tug': { placement: { nodes: [node] } } },
    cache: { image: 'redis', 'x-tug': { placement: { nodes: ['b'] } } },
  },
});
const serving = (project: string, port?: unknown) => ({
  projects: [
    {
      project,
      observedVersion: 'v1',
      health: 'serving',
      services: ['web'],
      serviceStates: { web: { rolloutState: 'serving', ...(port === undefined ? {} : { port }) } },
    },
  ],
  commandResults: [],
});

test('a node status report with a malformed rollout port is rejected before it reaches ingress configuration', async () => {
  const s = await server();
  try {
    const a = await s.register('a');
    const b = await s.register('b');
    await s.call('POST', '/api/v1/deployments', {
      project: 'app',
      version: 'v1',
      compose: webOn('a'),
    });
    for (const port of [
      '8080 {\n\t\theader_down X-Audit injected\n\t\t#',
      0,
      65536,
      80.5,
      {},
      null,
    ]) {
      const res = await a.status(serving('app', port));
      assert.equal(
        res.status,
        400,
        `port ${JSON.stringify(port)} must be refused as a malformed report`,
      );
    }
    assert.deepEqual(
      (await b.work()).serviceEndpoints,
      { app: {} },
      'a refused report publishes no endpoint',
    );
    assert.equal((await a.status(serving('app', 8081))).status, 200, 'a numeric port is accepted');
    assert.deepEqual(
      (await b.work()).serviceEndpoints.app.web.map((e: { port: number }) => e.port),
      [8081],
      'the valid rolling port reaches the endpoint list',
    );
  } finally {
    await s.close();
  }
});

test('a node can only report services that are placed on it', async () => {
  const s = await server();
  try {
    const a = await s.register('a');
    const b = await s.register('b');
    await s.call('POST', '/api/v1/deployments', {
      project: 'app',
      version: 'v1',
      compose: webOn('a'),
    });
    assert.equal((await b.status(serving('app', 9999))).status, 200, 'the report is accepted');
    assert.equal(
      (await b.status(serving('ghost'))).status,
      200,
      'a report for an unknown project is accepted',
    );
    assert.deepEqual(
      (await a.work()).serviceEndpoints,
      { app: {} },
      'a node the service is not placed on cannot become an endpoint',
    );
  } finally {
    await s.close();
  }
});

test('disabling a node withdraws it from healthy peers and from service endpoints', async () => {
  const s = await server();
  try {
    const a = await s.register('a');
    const b = await s.register('b');
    await s.call('POST', '/api/v1/deployments', {
      project: 'app',
      version: 'v1',
      compose: webOn('a'),
    });
    await a.status(serving('app'));
    const before = await b.work();
    assert.deepEqual(
      before.network.peers.map((p: { node: string }) => p.node),
      ['a'],
      'a healthy node starts as a mesh peer',
    );
    assert.equal(before.serviceEndpoints.app.web.length, 1, 'and as a service endpoint');
    assert.equal((await s.call('POST', '/api/v1/nodes/a/disable', {})).status, 200);
    const after = await b.work();
    assert.deepEqual(after.network.peers, [], 'a disabled node is no longer a WireGuard peer');
    assert.deepEqual(after.serviceEndpoints, { app: {} }, 'nor a service endpoint');
  } finally {
    await s.close();
  }
});

test('backup results and heartbeats from another node or for a finished command change nothing', async () => {
  const s = await server();
  try {
    const n1 = await s.register('n1');
    const n2 = await s.register('n2');
    await s.call('POST', '/api/v1/backup/destination', {
      url: 's3:https://s3.example.com/bucket/tug',
      env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
    });
    await s.call('POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose: {
        'x-tug': { backup: { schedule: '0 3 * * *', retention: { daily: 7 } } },
        services: {
          db: {
            image: 'mariadb:11.4',
            volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/mysql' }],
            'x-tug': { placement: { nodes: ['n1'] }, backup: { command: 'dump-it', verify: 'ok' } },
          },
        },
        volumes: { 'db-data': {} },
      },
    });
    const revision = (await n1.work()).desiredStates[0].revision;
    await n1.status({
      projects: [
        { project: 'site', observedVersion: 'v1', observedRevision: revision, health: 'serving' },
      ],
      commandResults: [],
    });
    await s.call('POST', '/api/v1/backups/run', { project: 'site', targets: ['db'] });
    const command = (await n1.work()).commands.find(
      (c: { type: string }) => c.type === 'backup.run',
    );
    const runId = JSON.parse(command.payload_json).runId;
    const runState = async () =>
      (await json(await s.call('GET', '/api/v1/backups?project=site'))).runs[0];

    await n2.status({
      projects: [],
      commandResults: [
        { commandId: command.id, state: 'succeeded', result: { runId, snapshotId: 'forged' } },
      ],
      jobs: [
        { commandId: command.id, runId, phase: 'dumping', startedAt: new Date().toISOString() },
      ],
    });
    const forged = await runState();
    assert.notEqual(forged.state, 'succeeded', "another node cannot complete the owner's backup");
    assert.notEqual(forged.snapshot_id, 'forged', 'and cannot plant a snapshot id');
    assert.notEqual(forged.state, 'running', "nor keep the owner's job alive with a heartbeat");

    await n1.status({
      projects: [],
      commandResults: [
        { commandId: command.id, state: 'succeeded', result: { runId, snapshotId: 'real' } },
      ],
    });
    assert.deepEqual(
      [(await runState()).state, (await runState()).snapshot_id],
      ['succeeded', 'real'],
      'the owning node completes its own command',
    );

    assert.equal(
      (
        await n1.status({
          projects: [],
          commandResults: [],
          jobs: [
            { commandId: command.id, runId, phase: 'dumping', startedAt: new Date().toISOString() },
          ],
        })
      ).status,
      200,
      'a late heartbeat is accepted and ignored',
    );
    assert.equal(
      (await n1.credentials(command.id)).status,
      409,
      'a finished command is not reopened by a heartbeat, so it releases no credentials',
    );
    assert.equal(
      (
        await n1.status({
          projects: [],
          commandResults: [{ commandId: command.id, state: 'running', result: {} }],
        })
      ).status,
      400,
      'a node cannot report a command as running',
    );
  } finally {
    await s.close();
  }
});
