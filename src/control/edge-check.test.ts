import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testControlUrl, testIdentity, testImageResolver } from '../../tests/helpers.ts';

async function setup(edgeCapable: boolean) {
  process.env.TUG_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-edge-'));
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const op = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
  const call = (method: string, route: string, headers: Record<string, string>, body?: unknown) =>
    fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const register = async (name: string, address: string) => {
    const reg = await json(await call('POST', '/api/v1/nodes/register', op, { name, address }));
    return { 'x-tug-test-node': reg.nodeId as string, 'content-type': 'application/json' };
  };
  const appNode = await register('app', '10.0.0.2');
  const edgeNode = await register('edge', '10.0.0.1');
  await call('POST', '/api/v1/nodes/edge/ingress', op, { enabled: true });
  const deployed = await call('POST', '/api/v1/deployments', op, {
    project: 'site',
    version: 'v1',
    compose: {
      services: {
        web: {
          image: 'nginx',
          ports: ['8080:80'],
          'x-tug': {
            placement: { nodes: ['app'] },
            health: { type: 'http', port: 80 },
            ingress: { host: 'site.test', port: 80, tls: 'off' },
            rollout: { strategy: 'rolling' },
          },
        },
      },
    },
  });
  assert.equal(deployed.status, 200, 'the rolling project must deploy');
  const report = (ingress: Record<string, unknown>) =>
    call('POST', '/agent/v1/status', edgeNode, {
      node: 'edge',
      sentAt: new Date().toISOString(),
      projects: [],
      commandResults: [],
      ingress: { state: 'serving', configHash: 'h', routes: 1, ...ingress },
    });
  assert.equal((await report(edgeCapable ? { edgeProbe: true } : {})).status, 200);
  return {
    check: () =>
      call('POST', '/agent/v1/edge-check', appNode, {
        project: 'site',
        service: 'web',
        port: 20001,
      }),
    work: async () => json(await call('GET', '/agent/v1/work', edgeNode)),
    report,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

test('an ingress node that cannot dial the candidate fails the check with its reason', async () => {
  const t = await setup(true);
  try {
    const pending = t.check();
    let probes: { id: string; host: string; port: number }[] = [];
    for (let i = 0; i < 50 && !probes.length; i++) {
      probes = (await t.work()).ingress?.probes ?? [];
      if (!probes.length) await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      probes.map((p) => [p.host, p.port]),
      [['10.0.0.2', 20001]],
      'the edge is asked to dial the app node address and the candidate port, not the container',
    );
    await t.report({
      edgeProbe: true,
      probeResults: [{ id: probes[0].id, ok: false, error: 'ETIMEDOUT dialing 10.0.0.2:20001' }],
    });
    const result = await json(await pending);
    assert.equal(result.ok, false, 'a definitive dial failure closes the gate');
    assert.deepEqual(
      result.failed,
      [{ node: 'edge', error: 'ETIMEDOUT dialing 10.0.0.2:20001' }],
      'the failing ingress node and its error are returned',
    );
    assert.equal(
      (await t.work()).ingress?.probes,
      undefined,
      'an answered probe is not sent again',
    );
  } finally {
    await t.close();
  }
});

test('an ingress node that dials the candidate successfully passes the check', async () => {
  const t = await setup(true);
  try {
    const pending = t.check();
    let probes: { id: string }[] = [];
    for (let i = 0; i < 50 && !probes.length; i++) {
      probes = (await t.work()).ingress?.probes ?? [];
      if (!probes.length) await new Promise((r) => setTimeout(r, 20));
    }
    await t.report({ edgeProbe: true, probeResults: [{ id: probes[0].id, ok: true }] });
    const result = await json(await pending);
    assert.deepEqual(
      [result.ok, result.reached],
      [true, ['edge']],
      'the edge that reached the candidate is reported',
    );
  } finally {
    await t.close();
  }
});

test('an ingress node that does not answer, or cannot probe, never blocks the rollout', async () => {
  process.env.TUG_EDGE_CHECK_TIMEOUT_MS = '100';
  try {
    const silent = await setup(true);
    try {
      const result = await json(await silent.check());
      assert.deepEqual(
        [result.ok, result.unchecked],
        [true, ['edge']],
        'silence is reported as unchecked and passes',
      );
    } finally {
      await silent.close();
    }
    const old = await setup(false);
    try {
      const result = await json(await old.check());
      assert.deepEqual(
        [result.ok, result.reached, result.failed, result.unchecked],
        [true, [], [], []],
        'an agent without the probe capability is not asked',
      );
    } finally {
      await old.close();
    }
  } finally {
    delete process.env.TUG_EDGE_CHECK_TIMEOUT_MS;
  }
});
