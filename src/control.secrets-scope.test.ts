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

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-sec-scope-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({ identity: testIdentity, images: { resolve: testImageResolver } });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}
const op = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
async function post(base: string, route: string, body: unknown, headers = op) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

test('agent secret fetch is scoped to requested assigned services', async () => {
  const s = await makeServer();
  try {
    const node = await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    await post(s.base, '/api/v1/secrets', { project: 'site', name: 'WEB_SECRET', value: 'web' });
    await post(s.base, '/api/v1/secrets', { project: 'site', name: 'DB_PASSWORD', value: 'db' });
    await post(s.base, '/api/v1/secrets', { project: 'site', name: 'UNUSED', value: 'unused' });
    const compose = {
      services: {
        web: {
          image: 'nginx',
          environment: { WEB_SECRET: '@@tug:secret:WEB_SECRET@@', STATIC: 'literal' },
          'x-tug': { placement: { nodes: ['n1'] } },
        },
        db: {
          image: 'postgres',
          environment: { DB_PASSWORD: '@@tug:secret:DB_PASSWORD@@' },
          'x-tug': { placement: { nodes: ['n2'] } },
        },
      },
    };
    await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v1', compose });
    const res = await fetch(`${s.base}/agent/v1/secrets?project=site&services=web`, {
      headers: { 'x-tug-test-node': node.agentToken },
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(Object.keys(body.secrets).sort(), ['WEB_SECRET']);
  } finally {
    await s.close();
  }
});
