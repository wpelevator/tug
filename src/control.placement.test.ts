import test from 'node:test';
import { normalized } from '../tests/fake-docker.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { testImageResolver, testIdentity } from '../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-place-'));
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
async function post(base: string, route: string, body: unknown) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: op,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

test('label placement spreads replicas, scale resizes them', async () => {
  const s = await makeServer();
  try {
    await post(s.base, '/api/v1/nodes/register', { name: 'app1', labels: ['app'] });
    await post(s.base, '/api/v1/nodes/register', { name: 'app2', labels: ['app'] });
    const nodes = (await (await fetch(`${s.base}/api/v1/nodes`, { headers: op })).json()) as {
      nodes: Array<{ name: string; labels: string[] }>;
    };
    assert.deepEqual(
      nodes.nodes.find((n) => n.name === 'app1')?.labels,
      ['app'],
      'registered labels should be listed on the node',
    );
    const compose = {
      services: {
        web: {
          image: 'nginx',
          'x-tug': { placement: { labels: ['app'] }, replicas: 1 },
        },
      },
    };
    const dep = await post(s.base, '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose: normalized(compose),
    });
    const svcs = dep.desiredState.services;
    assert.deepEqual(
      svcs.web.placement.nodes,
      ['app1'],
      'replicas: 1 should pick one node among the label matches',
    );
    const scaled = await post(s.base, '/api/v1/scale', {
      project: 'site',
      service: 'web',
      replicas: 2,
    });
    assert.deepEqual(
      scaled.nodes,
      ['app1', 'app2'],
      'scaling up should spread across matching nodes',
    );
    const down = await post(s.base, '/api/v1/scale', {
      project: 'site',
      service: 'web',
      replicas: 1,
    });
    assert.equal(down.replicas, 1, 'scaling down should reduce replicas');
  } finally {
    await s.close();
  }
});

test('stale nodes are skipped by label placement and scale, and scale never falls back to non-matching nodes', async () => {
  process.env.TUG_STALE_SECONDS = '1';
  const s = await makeServer();
  try {
    const live = await post(s.base, '/api/v1/nodes/register', { name: 'live', labels: ['app'] });
    const dead = await post(s.base, '/api/v1/nodes/register', { name: 'dead', labels: ['app'] });
    await post(s.base, '/api/v1/nodes/register', { name: 'other', labels: ['db'] });
    for (const node of [live, dead])
      await fetch(`${s.base}/agent/v1/status`, {
        method: 'POST',
        headers: { 'x-tug-test-node': node.nodeId, 'content-type': 'application/json' },
        body: JSON.stringify({ projects: [] }),
      });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await fetch(`${s.base}/agent/v1/status`, {
      method: 'POST',
      headers: { 'x-tug-test-node': live.nodeId, 'content-type': 'application/json' },
      body: JSON.stringify({ projects: [] }),
    });
    const compose = {
      services: {
        web: { image: 'nginx', 'x-tug': { global: true, placement: { labels: ['app'] } } },
      },
    };
    const dep = await post(s.base, '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose,
    });
    assert.deepEqual(
      dep.desiredState.services.web.placement.nodes,
      ['live'],
      'a node not seen within the stale window should not receive new replicas',
    );
    const scaled = await post(s.base, '/api/v1/scale', {
      project: 'site',
      service: 'web',
      replicas: 3,
    });
    assert.deepEqual(
      scaled.nodes,
      ['live'],
      'scale should stay within healthy nodes carrying the labels',
    );
  } finally {
    delete process.env.TUG_STALE_SECONDS;
    await s.close();
  }
});

test('node-remove deletes a retired node but refuses placed or still-reporting nodes unless forced', async () => {
  process.env.TUG_STALE_SECONDS = '1';
  const s = await makeServer();
  const del = (name: string, query = '') =>
    fetch(`${s.base}/api/v1/nodes/${name}${query}`, { method: 'DELETE', headers: op });
  try {
    const keep = await post(s.base, '/api/v1/nodes/register', { name: 'keep' });
    const old = await post(s.base, '/api/v1/nodes/register', { name: 'old' });
    await post(s.base, '/api/v1/nodes/register', { name: 'idle' });
    const first = await post(s.base, '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose: {
        services: {
          web: { image: 'nginx', 'x-tug': { placement: { nodes: ['old'] } } },
          api: { image: 'nginx', 'x-tug': { placement: { nodes: ['keep'] } } },
        },
      },
    });
    for (const node of [keep, old])
      await fetch(`${s.base}/agent/v1/status`, {
        method: 'POST',
        headers: { 'x-tug-test-node': node.nodeId, 'content-type': 'application/json' },
        body: JSON.stringify({ projects: [] }),
      });
    assert.equal((await del('ghost')).status, 404, 'removing an unknown node should be 404');
    const placed = await del('old');
    assert.equal(
      placed.status,
      409,
      'a node a current deployment places services on should not be removable',
    );
    assert.match(
      ((await placed.json()) as { error: string }).error,
      /site\/web/,
      'the refusal should name the service placed on the node',
    );
    assert.equal((await del('keep')).status, 409, 'a placed node must stay');
    assert.equal(
      (await del('idle')).status,
      200,
      'a never-seen node with no placement should be removable',
    );
    await post(s.base, `/api/v1/deployments/${first.deployment?.id || first.id}/cancel`, {});
    await post(s.base, '/api/v1/deployments', {
      project: 'site',
      version: 'v2',
      compose: {
        services: { api: { image: 'nginx', 'x-tug': { placement: { nodes: ['keep'] } } } },
      },
    });
    assert.equal(
      (await del('old')).status,
      409,
      'a node whose agent is still reporting should need force',
    );
    assert.equal(
      (await del('old', '?force=true')).status,
      200,
      'force should remove a node that is still reporting',
    );
    const nodes = (await (await fetch(`${s.base}/api/v1/nodes`, { headers: op })).json()) as {
      nodes: Array<{ name: string }>;
    };
    assert.deepEqual(
      nodes.nodes.map((n) => n.name),
      ['keep'],
      'removed nodes should disappear from the node list',
    );
  } finally {
    delete process.env.TUG_STALE_SECONDS;
    await s.close();
  }
});

test('explicit placement is refused on disabled or unknown nodes', async () => {
  const s = await makeServer();
  try {
    await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    await post(s.base, '/api/v1/nodes/register', { name: 'n2' });
    await post(s.base, '/api/v1/nodes/n1/disable', {});
    const deploy = (node: string) =>
      fetch(`${s.base}/api/v1/deployments`, {
        method: 'POST',
        headers: op,
        body: JSON.stringify({
          project: 'site',
          version: node,
          compose: {
            services: { web: { image: 'nginx', 'x-tug': { placement: { nodes: [node] } } } },
          },
        }),
      });
    assert.equal((await deploy('n1')).status, 400, 'a disabled node cannot receive new placement');
    assert.equal((await deploy('ghost')).status, 400, 'an unregistered node is refused');
    assert.equal((await deploy('n2')).status, 200, 'an enabled node still accepts placement');
  } finally {
    await s.close();
  }
});

test('node addresses cannot carry configuration syntax', async () => {
  const s = await makeServer();
  try {
    const register = (body: object) =>
      fetch(`${s.base}/api/v1/nodes/register`, {
        method: 'POST',
        headers: op,
        body: JSON.stringify(body),
      });
    for (const address of ['10.0.0.9 {\n\theader_down X injected\n\t#', 'host:80', 'a b', '[::1]'])
      assert.equal(
        (await register({ name: 'bad', address })).status,
        400,
        `address ${JSON.stringify(address)} must be rejected`,
      );
    assert.equal(
      (await register({ name: 'bad', publicAddress: '1.2.3.4 {\n#' })).status,
      400,
      'a public address with syntax must be rejected',
    );
    assert.equal(
      (await register({ name: 'ok', address: '10.0.0.9', publicAddress: 'node.example.com:51820' }))
        .status,
      200,
      'plain host and host:port public addresses are accepted',
    );
  } finally {
    await s.close();
  }
});
