import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-place-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = 'op-place-token';
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-place-token', 'content-type': 'application/json' };
async function post(base: string, route: string, body: unknown) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: op, body: JSON.stringify(body) });
  const text = await res.text(); assert.equal(res.status, 200, text); return JSON.parse(text);
}

test('label placement spreads replicas, scale resizes them and NFS volumes get the exporter address', async () => {
  const s = await makeServer();
  try {
    await post(s.base, '/api/v1/nodes/register', { name: 'app1', labels: ['app'] });
    await post(s.base, '/api/v1/nodes/register', { name: 'app2', labels: ['app'] });
    await post(s.base, '/api/v1/nodes/register', { name: 'store', address: '10.0.0.40', labels: ['storage'] });
    const nodes = await (await fetch(`${s.base}/api/v1/nodes`, { headers: op })).json() as { nodes: Array<{ name: string; labels: string[] }> };
    assert.deepEqual(nodes.nodes.find(n => n.name === 'app1')?.labels, ['app'], 'registered labels should be listed on the node');
    const compose = {
      services: {
        web: { image: 'nginx', volumes: ['shared:/data'], 'x-tug': { placement: { labels: ['app'] }, replicas: 1 } },
        nfsd: { image: 'busybox', volumes: ['shared:/data'], 'x-tug': { placement: { nodes: ['store'] } } }
      },
      volumes: { shared: { 'x-tug': { type: 'nfs', placement: { nodes: ['store'] } } } }
    };
    const dep = await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v1', compose });
    const svcs = dep.desiredState.services;
    assert.deepEqual(svcs.web.placement.nodes, ['app1'], 'replicas: 1 should pick one node among the label matches');
    assert.equal(dep.desiredState.compose.volumes.shared['x-tug'].address, '10.0.0.40', 'control should stamp the exporter address into the NFS volume');
    const scaled = await post(s.base, '/api/v1/scale', { project: 'site', service: 'web', replicas: 2 });
    assert.deepEqual(scaled.nodes, ['app1', 'app2'], 'scaling up should spread across matching nodes');
    const down = await post(s.base, '/api/v1/scale', { project: 'site', service: 'web', replicas: 1 });
    assert.equal(down.replicas, 1, 'scaling down should reduce replicas');
  } finally { await s.close(); }
});
