import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { startApplyHeartbeat } from '../agent/agent.ts';
import type { AgentContext } from '../agent/agent.ts';

test('an applying heartbeat marks the node busy in the node list until its next work fetch or report', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-node-busy-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({ identity: testIdentity, controlUrl: testControlUrl });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const registered = await json(
      await fetch(`${base}/api/v1/nodes/register`, {
        method: 'POST',
        headers: { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'n1' }),
      }),
    );
    const agent = (route: string) =>
      fetch(base + route, { headers: { 'x-tug-test-node': registered.nodeId } });
    const listed = async () =>
      (
        await json(
          await fetch(`${base}/api/v1/nodes`, { headers: { 'x-tug-test-operator': 'operator' } }),
        )
      ).nodes[0];
    assert.equal(
      (await listed()).applying,
      false,
      'a node that never sent a heartbeat is not busy',
    );
    await agent('/agent/v1/wake?after=0&timeout=0&applying=1');
    const busy = await listed();
    assert.equal(busy.applying, true, 'the heartbeat of an applying agent marks the node busy');
    assert.equal(busy.status, 'online', 'a busy node is still online, not stale');
    await agent('/agent/v1/work');
    assert.equal((await listed()).applying, false, 'the next work fetch ends the busy state');
    await agent('/agent/v1/wake?after=0&timeout=0&applying=1');
    await agent('/agent/v1/wake?after=0&timeout=0');
    assert.equal((await listed()).applying, false, 'an ordinary wake call ends it too');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('startApplyHeartbeat sends nothing from a quick poll, beats while one is running, and stops', async () => {
  const urls: string[] = [];
  const ctx = {
    controlUrl: 'https://control.test',
    http: async (url: string) => {
      urls.push(url);
      return Response.json({});
    },
  } as unknown as AgentContext;
  const quick = startApplyHeartbeat(ctx, 20);
  quick();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(urls.length, 0, 'a poll that finishes before the first interval sends no heartbeat');
  const slow = startApplyHeartbeat(ctx, 20);
  await new Promise((resolve) => setTimeout(resolve, 90));
  slow();
  const sent = urls.length;
  assert.ok(sent >= 2, 'a long poll sends a heartbeat every interval');
  assert.ok(
    urls.every((url) => url.endsWith('/agent/v1/wake?after=0&timeout=0&applying=1')),
    'the heartbeat is a wake call that says the agent is applying',
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(urls.length, sent, 'no heartbeat is sent after the poll finished');
});
