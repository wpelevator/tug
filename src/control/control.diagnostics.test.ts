import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { json } from '../../tests/helpers.ts';
import { until } from '../../tests/wait.ts';

async function makeServer(
  docker = new FakeDocker(),
  extra: { probePort?: (host: string, port: number, timeoutMs: number) => Promise<any> } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-diag-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({
    docker,
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
    ...extra,
  });
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
    check = await until(async () => {
      const latest = await nodesCheck();
      return byName(latest, 'b').clockSkew?.state === 'unknown' ? latest : undefined;
    }, 'the silent node to count as offline');
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

test('the docker diagnostics check reports the engine version from the Engine API and fails when the socket does not answer', async () => {
  const docker = new FakeDocker();
  docker.version_ = { Version: '28.1.1', ApiVersion: '1.49', MinAPIVersion: '1.24' };
  const s = await makeServer(docker);
  try {
    const check = async () =>
      (await json(await fetch(`${s.base}/api/v1/diagnostics`, { headers: op }))).checks.find(
        (c: { name: string }) => c.name === 'docker',
      );
    const ok = await check();
    assert.deepEqual(
      [ok.ok, ok.output],
      [true, '28.1.1'],
      'the check reports the server version the engine returns, without running the docker CLI',
    );
    docker.version = async () => {
      throw new Error('connect ENOENT /var/run/docker.sock');
    };
    const down = await check();
    assert.equal(down.ok, false, 'an unreachable engine socket fails the check');
    assert.match(down.error, /ENOENT/, 'the failure names why the socket did not answer');
  } finally {
    await s.close();
  }
});

test('doctor checks ports 80 and 443 on online ingress nodes and names the closed port, cause and remedy', async () => {
  const probed: string[] = [];
  const closed = new Set<string>();
  const s = await makeServer(new FakeDocker(), {
    probePort: async (host, port) => {
      probed.push(`${host}:${port}`);
      return closed.has(`${host}:${port}`) ? 'timeout' : 'open';
    },
  });
  try {
    const call = (route: string, headers: Record<string, string>, body?: unknown) =>
      fetch(`${s.base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const portsCheck = async () => {
      const diagnostics = await json(await call('/api/v1/diagnostics', op));
      return diagnostics.checks.find((c: { name: string }) => c.name === 'ingress_ports');
    };
    assert.equal(await portsCheck(), undefined, 'without an ingress node there is no port check');
    const register = async (name: string, address?: string) => {
      const node = await json(await call('/api/v1/nodes/register', op, { name, address }));
      await call(`/api/v1/nodes/${name}/ingress`, op, { enabled: true });
      return node;
    };
    const online = (nodeId: string, name: string) =>
      call(
        '/agent/v1/status',
        { 'x-tug-test-node': nodeId, 'content-type': 'application/json' },
        { node: name, sentAt: new Date().toISOString(), projects: [], commandResults: [] },
      );
    const a = await register('a', '10.0.0.4');
    await register('noaddr');
    await register('silent', '10.0.0.9');
    assert.equal((await online(a.nodeId, 'a')).status, 200, 'the status report is accepted');

    let check = await portsCheck();
    assert.equal(check.ok, true, 'open ports pass the check');
    assert.deepEqual(
      probed.sort(),
      ['10.0.0.4:443', '10.0.0.4:80'],
      'only the online node with an address is probed, on both ports and nothing else',
    );
    assert.equal(
      check.nodes.find((n: { name: string }) => n.name === 'a').scope,
      'private',
      'a private address is labelled so the limit is visible in the document',
    );
    assert.equal(check.output, '80, 443 open on a', 'a passing check says what was verified');
    assert.deepEqual(
      check.warnings.map((w: string) => w.split(':')[0]).sort(),
      ['noaddr', 'silent'],
      'nodes that cannot be probed produce warnings, not failures',
    );

    closed.add('10.0.0.4:443');
    check = await portsCheck();
    assert.equal(check.ok, false, 'a closed port fails the check');
    assert.match(
      check.error,
      /port 443 on ingress node a \(10\.0\.0\.4\)/,
      'the failure names the port and node',
    );
    assert.doesNotMatch(check.error, /port 80 /, 'the open port is not reported');
    assert.match(
      check.error,
      /host firewall.*provider firewall/,
      'the failure names the likely cause',
    );
    assert.match(check.error, /ufw allow 80,443\/tcp/, 'the failure gives the remedy');
  } finally {
    await s.close();
  }
});

test('control diagnostics report host resources without failing', async () => {
  const s = await makeServer();
  try {
    const diagnostics = await json(await fetch(`${s.base}/api/v1/diagnostics`, { headers: op }));
    const resources = diagnostics.checks.find((c: { name: string }) => c.name === 'resources');
    assert.equal(resources.ok, true, 'reading resources never fails the diagnostics');
    assert.ok(
      resources.resources.disk.freeBytes > 0,
      'free disk under the control data directory is reported',
    );
    assert.ok(
      Array.isArray(resources.resources.containers),
      'container usage is a list, empty outside a container',
    );
  } finally {
    await s.close();
  }
});
