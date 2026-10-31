import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { json } from '../tests/helpers.ts';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-vol-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = 'op-volume-token';
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-volume-token', 'content-type': 'application/json' };
async function post(base: string, route: string, body: unknown, headers = op) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text(); assert.equal(res.status, 200, text); return JSON.parse(text);
}

test('volume metadata is protected and delete-data queues deletion after unreferenced', async () => {
  const s = await makeServer();
  try {
    const registered = await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    const withVolume = { services: { app: { image: 'busybox', volumes: ['data:/data'], 'x-tug': { placement: { nodes: ['n1'] } } } }, volumes: { data: { 'x-tug': { type: 'local', persistent: true, placement: { nodes: ['n1'] } } } } };
    const noVolume = { services: { app: { image: 'busybox', 'x-tug': { placement: { nodes: ['n1'] } } } } };
    const first = await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v1', compose: withVolume });
    let res = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ projects: [{ project: 'site', observedVersion: 'v1', observedRevision: first.desiredState.revision, health: 'serving' }] }) });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/volumes?project=site`, { headers: op });
    assert.equal((await json(res)).volumes[0].name, 'data');
    res = await fetch(`${s.base}/api/v1/volumes/data?project=site&deleteData=true`, { method: 'DELETE', headers: op });
    assert.equal(res.status, 409);
    await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v2', compose: noVolume });
    res = await fetch(`${s.base}/api/v1/volumes/data?project=site`, { method: 'DELETE', headers: op });
    assert.equal(res.status, 409);
    res = await fetch(`${s.base}/api/v1/volumes/data?project=site&deleteData=true`, { method: 'DELETE', headers: op });
    assert.equal(res.status, 200);
    const deleted = await json(res);
    assert.match(deleted.commandId, /^cmd_/);
  } finally { await s.close(); }
});
