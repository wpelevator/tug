import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.js';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-rb-'));
  process.env.LAUNCHPAD_DB = path.join(dir, 'launchpad.db');
  process.env.LAUNCHPAD_MASTER_KEY_FILE = path.join(dir, 'master.key');
  process.env.LAUNCHPAD_OPERATOR_TOKEN = 'op-rollback-token';
  process.env.LAUNCHPAD_REGISTRY = 'registry.test';
  const app = await createApp();
  const srv = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const headers = { Authorization: 'Bearer op-rollback-token', 'content-type': 'application/json' };

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

test('rollback selects previous immutable desired state', async () => {
  const s = await makeServer();
  try {
    const compose = tag => ({ services: { web: { image: `nginx:${tag}`, 'x-launchpad': { placement: { nodes: ['n1'] } } } } });
    const registered = await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    const first = await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v1', compose: compose('1.27-alpine') });
    let res = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ projects: [{ project: 'site', observedVersion: 'v1', health: 'serving' }] }) });
    assert.equal(res.status, 200);
    await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v2', compose: compose('1.26-alpine') });
    const rb = await post(s.base, '/api/v1/rollback', { project: 'site', force: true });
    assert.equal(rb.desiredState.version, first.desiredState.version);
    assert.equal(rb.desiredState.services.web.image, 'nginx:1.27-alpine');
  } finally { await s.close(); }
});
