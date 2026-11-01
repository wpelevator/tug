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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-diag-'));
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

test('control diagnostics and node diagnostics command queue', async () => {
  const s = await makeServer();
  try {
    let res = await fetch(`${s.base}/api/v1/diagnostics`, { headers: op });
    assert.equal(res.status, 200);
    const diagnostics = await json(res);
    assert.ok(
      diagnostics.checks.some((c: { name: string; ok: boolean }) => c.name === 'sqlite' && c.ok),
    );

    res = await fetch(`${s.base}/api/v1/nodes/register`, {
      method: 'POST',
      headers: op,
      body: JSON.stringify({ name: 'n1' }),
    });
    assert.equal(res.status, 200);
    const node = await json(res);
    res = await fetch(`${s.base}/api/v1/diagnostics/nodes`, {
      method: 'POST',
      headers: op,
      body: JSON.stringify({ node: 'n1' }),
    });
    assert.equal(res.status, 200);
    const queued = await json(res);
    assert.match(queued.commands[0].commandId, /^cmd_/);
    res = await fetch(`${s.base}/agent/v1/work`, {
      headers: { 'x-tug-test-node': node.nodeId },
    });
    assert.equal((await json(res)).commands[0].type, 'diagnostics.run');
    res = await fetch(`${s.base}/api/v1/diagnostics/nodes`, {
      method: 'POST',
      headers: op,
      body: JSON.stringify({ node: 'missing' }),
    });
    assert.equal(res.status, 404, 'an unknown node is not an empty diagnostic run');
    assert.equal(
      (await json(res)).error,
      'node missing not found',
      'the error names the node that was requested',
    );
  } finally {
    await s.close();
  }
});

test('node diagnostics separate observed clock skew from unknown for offline nodes', async () => {
  const stale = process.env.TUG_STALE_SECONDS;
  const s = await makeServer();
  try {
    const call = async (route: string, headers: Record<string, string>, body?: unknown) =>
      fetch(`${s.base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const register = async (name: string) =>
      await json(await call('/api/v1/nodes/register', op, { name }));
    const [a, b] = [await register('a'), await register('b')];
    const report = (nodeId: string, name: string, sentAt: string) =>
      call(
        '/agent/v1/status',
        { 'x-tug-test-node': nodeId, 'content-type': 'application/json' },
        { node: name, sentAt, projects: [], commandResults: [] },
      );
    const nodesCheck = async () => {
      const diagnostics = await json(await call('/api/v1/diagnostics', op));
      return diagnostics.checks.find((c: { name: string }) => c.name === 'nodes');
    };
    const byName = (c: any, name: string) => c.nodes.find((n: { name: string }) => n.name === name);

    assert.equal(
      (await report(a.nodeId, 'a', new Date(Date.now() + 2000).toISOString())).status,
      200,
      'the status report with a clock is accepted',
    );
    let check = await nodesCheck();
    assert.equal(check.ok, true, 'a node with a small skew passes');
    assert.equal(
      byName(check, 'a').clockSkew.state,
      'observed',
      'the reporting node has an observed skew',
    );
    assert.ok(
      Math.abs(byName(check, 'a').clockSkew.ms - 2000) < 1500,
      'the observed skew is the reported clock minus control time',
    );
    assert.deepEqual(
      byName(check, 'b').clockSkew,
      { state: 'unknown', reason: 'never reported' },
      'a node that never reported has an unknown skew',
    );

    const ahead = new Date(Date.now() + 20 * 60_000).toISOString();
    assert.equal((await report(b.nodeId, 'b', ahead)).status, 200, 'the report is accepted');
    check = await nodesCheck();
    assert.equal(check.ok, false, 'a node 20 minutes ahead fails the nodes check');
    assert.match(
      check.error,
      /b: clock differs from the control plane/,
      'the failure names the node',
    );

    process.env.TUG_STALE_SECONDS = '0.001';
    await new Promise((resolve) => setTimeout(resolve, 30));
    check = await nodesCheck();
    assert.deepEqual(
      byName(check, 'b').clockSkew,
      { state: 'unknown', reason: 'offline' },
      'once the node stops reporting its skew is unknown, not the last observation',
    );
    assert.equal(check.ok, true, 'an offline node cannot fail the clock check');
  } finally {
    if (stale === undefined) delete process.env.TUG_STALE_SECONDS;
    else process.env.TUG_STALE_SECONDS = stale;
    await s.close();
  }
});
