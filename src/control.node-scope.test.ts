import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './control.ts';
import { json, testIdentity, testImageResolver } from '../tests/helpers.ts';

/** Every `/agent/v1/*` handler derives the node from the certificate, never from the request. */
async function setup() {
  process.env.TUG_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-scope-'));
  const app = await createApp({ identity: testIdentity, images: { resolve: testImageResolver } });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const op = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
  const as = (node: string) => ({ 'x-tug-test-node': node, 'content-type': 'application/json' });
  const call = (method: string, route: string, headers: Record<string, string>, body?: unknown) =>
    fetch(base + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  for (const name of ['n1', 'n2'])
    await call('POST', '/api/v1/nodes/register', op, { name, address: `10.0.0.${name.slice(1)}` });
  await call('POST', '/api/v1/secrets', op, { project: 'site', name: 'S', value: 'secret-for-n1' });
  const deployed = await call('POST', '/api/v1/deployments', op, {
    project: 'site',
    version: 'v1',
    compose: {
      services: {
        web: {
          image: 'nginx:alpine',
          environment: { S: '@@tug:secret:S@@' },
          'x-tug': { placement: { nodes: ['n1'] } },
        },
      },
    },
  });
  assert.equal(deployed.status, 200, 'the fixture deploys a service placed on n1');
  const restart = await json(
    await call('POST', '/api/v1/restart', op, { project: 'site', service: 'web' }),
  );
  return {
    call,
    op,
    as,
    commandId: restart.commandId as string,
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('secrets: a node receives secrets only for services placed on it', async () => {
  const s = await setup();
  try {
    const mine = await json(
      await s.call('GET', '/agent/v1/secrets?project=site&services=web', s.as('n1')),
    );
    assert.equal(mine.secrets.S, 'secret-for-n1', 'the placed node gets its service secret');
    const other = await json(
      await s.call('GET', '/agent/v1/secrets?project=site&services=web', s.as('n2')),
    );
    assert.deepEqual(
      other.secrets,
      {},
      'another node must not receive that secret, even when it names the service',
    );
  } finally {
    await s.close();
  }
});

test('work: queued commands and desired state go only to the node they belong to', async () => {
  const s = await setup();
  try {
    const one = JSON.stringify(await json(await s.call('GET', '/agent/v1/work', s.as('n1'))));
    const two = JSON.stringify(await json(await s.call('GET', '/agent/v1/work', s.as('n2'))));
    assert.ok(one.includes(s.commandId), 'the owning node sees its command');
    assert.ok(!two.includes(s.commandId), "another node must not see n1's command");
  } finally {
    await s.close();
  }
});

test('status and events: reports are recorded against the authenticated node, whatever the body claims', async () => {
  const s = await setup();
  try {
    const status = await s.call('POST', '/agent/v1/status', s.as('n2'), {
      node: 'n1',
      nodeId: 'n1',
      projects: [],
      commandResults: [{ commandId: s.commandId, state: 'succeeded', result: {} }],
    });
    assert.ok(status.status < 500, 'the report is handled');
    const events = await s.call('POST', '/agent/v1/events', s.as('n2'), {
      projectId: 'site',
      type: 'service.serving',
      message: 'from n2',
      nodeId: 'n1',
      node_id: 'n1',
    });
    assert.equal(events.status, 200);
    const nodes = (await json(await s.call('GET', '/api/v1/nodes', s.op))).nodes;
    const seen = Object.fromEntries(
      nodes.map((n: { name: string; last_seen_at: string | null }) => [n.name, n.last_seen_at]),
    );
    assert.equal(seen.n1, null, 'a report from n2 must not mark n1 as seen');
    assert.ok(seen.n2, 'the report is attributed to n2');
    const listed = (await json(await s.call('GET', '/api/v1/events?project=site', s.op))).events;
    const mine = listed.find((e: { message: string }) => e.message === 'from n2');
    assert.equal(
      mine.node_id,
      'n2',
      'the event carries the authenticated node, not the claimed one',
    );
    const command = await json(await s.call('GET', `/api/v1/commands/${s.commandId}`, s.op));
    assert.notEqual(command.state, 'succeeded', "n2 must not be able to complete n1's command");
  } finally {
    await s.close();
  }
});

test('backup credentials: only the node that owns the command can fetch them', async () => {
  const s = await setup();
  try {
    const other = await s.call(
      'GET',
      `/agent/v1/backup/credentials?command=${s.commandId}`,
      s.as('n2'),
    );
    assert.equal(other.status, 403, "another node must not read a command's credentials");
    const unknown = await s.call('GET', '/agent/v1/backup/credentials?command=nope', s.as('n2'));
    assert.equal(unknown.status, 404, 'unknown commands are not found');
    const owner = await s.call(
      'GET',
      `/agent/v1/backup/credentials?command=${s.commandId}`,
      s.as('n1'),
    );
    assert.equal(
      owner.status,
      403,
      'even the owner gets nothing for a command type that does not use credentials',
    );
  } finally {
    await s.close();
  }
});

test('wireguard key: the handler acts on the authenticated node only', async () => {
  const s = await setup();
  try {
    const key = await s.call('POST', '/agent/v1/wireguard/key', s.as('n2'), {
      publicKey: 'x',
      nodeId: 'n1',
    });
    assert.ok(
      [400, 409].includes(key.status),
      'a bad key or a disabled mesh is refused for n2 without touching n1',
    );
  } finally {
    await s.close();
  }
});

test('images: a node cannot download an archive it is not assigned', async () => {
  const s = await setup();
  try {
    const res = await s.call('GET', '/agent/v1/images/build_nonexistent', s.as('n2'));
    assert.equal(res.status, 404, 'unassigned or unknown archives are not found for any node');
  } finally {
    await s.close();
  }
});
