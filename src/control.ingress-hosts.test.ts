import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testIdentity, testImageResolver } from '../tests/helpers.ts';

async function server() {
  process.env.TUG_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-hosts-'));
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
  const reg = await json(await call('POST', '/api/v1/nodes/register', { name: 'n1' }));
  const node = { 'x-tug-test-node': reg.nodeId, 'content-type': 'application/json' };
  return {
    deploy: (project: string, version: string, host: string) =>
      call('POST', '/api/v1/deployments', {
        project,
        version,
        compose: {
          services: {
            web: {
              image: 'nginx',
              ports: ['8080:80'],
              'x-tug': { placement: { nodes: ['n1'] }, ingress: { host, port: 80 } },
            },
          },
        },
      }),
    serve: (project: string, version: string, revision: string) =>
      call(
        'POST',
        '/agent/v1/status',
        {
          projects: [
            { project, observedVersion: version, observedRevision: revision, health: 'serving' },
          ],
        },
        node,
      ),
    rollback: (project: string) => call('POST', '/api/v1/rollback', { project, force: true }),
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

test('a project cannot take an ingress hostname that another project already routes', async () => {
  const s = await server();
  try {
    const first = await json(await s.deploy('victim', 'v1', 'app.example.com'));
    await s.serve('victim', 'v1', first.desiredState.revision);
    const taken = await s.deploy('alpha', 'v1', 'APP.Example.com');
    assert.equal(taken.status, 409, 'a lexically earlier project must not displace the owner');
    assert.match(
      (await json(taken)).error,
      /app\.example\.com is already routed by project victim/,
      'the error names the host and its owner, ignoring case',
    );
    assert.equal(
      (await s.deploy('victim', 'v2', 'app.example.com')).status,
      200,
      'the owner can redeploy its own hostname',
    );
    assert.equal(
      (await s.deploy('alpha', 'v1', 'other.example.com')).status,
      200,
      'a different hostname is unaffected',
    );
  } finally {
    await s.close();
  }
});

test('a rollback cannot restore a hostname that another project now owns', async () => {
  const s = await server();
  try {
    const first = await json(await s.deploy('victim', 'v1', 'old.example.com'));
    await s.serve('victim', 'v1', first.desiredState.revision);
    assert.equal((await s.deploy('victim', 'v2', 'new.example.com')).status, 200);
    assert.equal(
      (await s.deploy('alpha', 'v1', 'old.example.com')).status,
      200,
      'the released hostname can be claimed by another project',
    );
    const rollback = await s.rollback('victim');
    assert.equal(
      rollback.status,
      409,
      'rollback must not take the hostname back from its new owner',
    );
    assert.match(
      (await json(rollback)).error,
      /old\.example\.com is already routed by project alpha/,
    );
  } finally {
    await s.close();
  }
});
