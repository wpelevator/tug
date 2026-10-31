import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AgentWakeChannel } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { createApp, listen } from './control.ts';
import type { StreamMessage, WakeResponse } from './protocol.ts';
import { json } from '../tests/helpers.ts';

const OPERATOR = 'op-stream-test';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-stream-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = OPERATOR;
  process.env.TUG_REGISTRY = 'registry.test';
  delete process.env.TUG_TLS_CERT_FILE;
  delete process.env.TUG_TLS_KEY_FILE;
  const app = await createApp();
  const httpServer = await listen(app, 0);
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const call = (method: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const registered = await json(await call('POST', '/api/v1/nodes/register', { name: 'n1', address: '10.0.0.1' }));
  const close = () => new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
  return { base, call, registered, close };
}

function nextMessage(ws: WebSocket): Promise<StreamMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for stream message')), 2000);
    ws.once('message', data => { clearTimeout(timeout); resolve(JSON.parse(data.toString()) as StreamMessage); });
  });
}

test('authenticated stream wakes the node and the cursor closes long-poll races', async () => {
  const s = await server();
  const ws = new WebSocket(s.base.replace(/^http/, 'ws') + '/agent/v1/stream', { headers: { Authorization: `Bearer ${s.registered.agentToken}` } });
  try {
    const ready = await nextMessage(ws);
    assert.equal(ready.type, 'ready', 'an authenticated agent should receive the stream-ready message');
    assert.equal(ready.nodeId, 'n1', 'the stream-ready message should identify the authenticated node');

    const streamed = nextMessage(ws);
    const diagnostics = await json(await s.call('POST', '/api/v1/diagnostics/nodes', { node: 'n1' }));
    const wake = await streamed;
    assert.equal(wake.type, 'work-available', 'queuing a command should wake the connected agent');
    assert.ok(wake.cursor > ready.cursor, 'each wake should advance the node cursor');

    const immediate = await json(await fetch(`${s.base}/agent/v1/wake?after=${ready.cursor}&timeout=1000`, { headers: { Authorization: `Bearer ${s.registered.agentToken}` } })) as WakeResponse;
    assert.equal(immediate.type, 'work-available', 'long polling from an older cursor should return immediately instead of losing the wake');
    assert.equal(immediate.cursor, wake.cursor, 'WebSocket and long-poll notifications should share one cursor');
    assert.equal(diagnostics.commands[0].nodeId, 'n1', 'the wake should correspond to work queued for the target node');

    const deployWake = nextMessage(ws);
    const compose = { services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } } };
    const deployed = await s.call('POST', '/api/v1/deployments', { project: 'site', version: 'v1', compose });
    assert.equal(deployed.status, 200, 'the test deployment should publish successfully');
    assert.equal((await deployWake).type, 'work-available', 'publishing desired state should wake agents immediately');
    const work = await json(await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${s.registered.agentToken}` } }));
    const report = { projects: [{ project: 'site', observedVersion: 'v1', observedRevision: work.desiredStates[0].revision, health: 'serving', serviceStates: { web: { rolloutState: 'serving' } } }] };
    const endpointWake = nextMessage(ws);
    const reported = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${s.registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(reported.status, 200, 'the serving endpoint report should be accepted');
    const endpointMessage = await endpointWake;
    assert.equal(endpointMessage.type, 'work-available', 'a changed serving endpoint should wake peers that render service DNS or ingress');

    const repeated = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${s.registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(repeated.status, 200, 'repeating an unchanged endpoint report should still succeed');
    const unchanged = await json(await fetch(`${s.base}/agent/v1/wake?after=${endpointMessage.cursor}&timeout=25`, { headers: { Authorization: `Bearer ${s.registered.agentToken}` } })) as WakeResponse;
    assert.equal(unchanged.type, 'timeout', 'an unchanged endpoint report should not create a wake feedback loop');
  } finally {
    ws.terminate();
    await s.close();
  }
});

test('stream rejects invalid agent credentials', async () => {
  const s = await server();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(s.base.replace(/^http/, 'ws') + '/agent/v1/stream', { headers: { Authorization: 'Bearer wrong' } });
      ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      ws.once('open', () => { ws.terminate(); reject(new Error('invalid credentials unexpectedly opened a stream')); });
      ws.once('error', () => {});
    });
    assert.equal(status, 401, 'an invalid agent token should be rejected during the WebSocket upgrade');
  } finally { await s.close(); }
});

test('agent wake channel falls back to long polling when WebSockets are unavailable', async () => {
  const s = await server();
  const ctx: AgentContext = {
    docker: async () => ({ out: '', err: '' }),
    http: fetch,
    nodeName: 'n1',
    stateDir: await fs.mkdtemp(path.join(os.tmpdir(), 'tug-stream-agent-')),
    apply: false,
    controlUrl: s.base,
    token: s.registered.agentToken,
  };
  const channel = new AgentWakeChannel(ctx, () => new WebSocket('ws://127.0.0.1:1'));
  try {
    const waiting = channel.wait(2000);
    await new Promise(resolve => setTimeout(resolve, 50));
    await s.call('POST', '/api/v1/diagnostics/nodes', { node: 'n1' });
    await assert.doesNotReject(waiting, 'the HTTP fallback should release the agent when control queues work');
  } finally {
    channel.close();
    await s.close();
  }
});
