import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AgentWakeChannel } from './agent.ts';
import { FakeDocker } from '../tests/fake-docker.ts';
import type { AgentContext } from './agent.ts';
import { createApp, listen } from './control.ts';
import { LIVE_MAX_SESSIONS } from './protocol.ts';
import type { StreamMessage, WakeResponse } from './protocol.ts';
import { testImageResolver, json } from '../tests/helpers.ts';

const OPERATOR = 'op-stream-test';

async function server(liveStartTimeoutMs?: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-stream-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = OPERATOR;
  delete process.env.TUG_TLS_CERT_FILE;
  delete process.env.TUG_TLS_KEY_FILE;
  const app = await createApp({ liveStartTimeoutMs, images: { resolve: testImageResolver } });
  const httpServer = await listen(app, 0);
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const call = (method: string, route: string, body?: unknown) =>
    fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const registered = await json(
    await call('POST', '/api/v1/nodes/register', { name: 'n1', address: '10.0.0.1' }),
  );
  const close = () =>
    new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  return { base, call, registered, close };
}

function nextMessage(ws: WebSocket): Promise<StreamMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for stream message')),
      2000,
    );
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as StreamMessage);
    });
  });
}

test('authenticated stream wakes the node and the cursor closes long-poll races', async () => {
  const s = await server();
  const ws = new WebSocket(s.base.replace(/^http/, 'ws') + '/agent/v1/stream', {
    headers: { Authorization: `Bearer ${s.registered.agentToken}` },
  });
  try {
    const ready = await nextMessage(ws);
    assert.equal(
      ready.type,
      'ready',
      'an authenticated agent should receive the stream-ready message',
    );
    assert.equal(
      ready.nodeId,
      'n1',
      'the stream-ready message should identify the authenticated node',
    );

    const streamed = nextMessage(ws);
    const diagnostics = await json(
      await s.call('POST', '/api/v1/diagnostics/nodes', { node: 'n1' }),
    );
    const wake = await streamed;
    assert.equal(wake.type, 'work-available', 'queuing a command should wake the connected agent');
    assert.ok(wake.cursor > ready.cursor, 'each wake should advance the node cursor');

    const immediate = (await json(
      await fetch(`${s.base}/agent/v1/wake?after=${ready.cursor}&timeout=1000`, {
        headers: { Authorization: `Bearer ${s.registered.agentToken}` },
      }),
    )) as WakeResponse;
    assert.equal(
      immediate.type,
      'work-available',
      'long polling from an older cursor should return immediately instead of losing the wake',
    );
    assert.equal(
      immediate.cursor,
      wake.cursor,
      'WebSocket and long-poll notifications should share one cursor',
    );
    assert.equal(
      diagnostics.commands[0].nodeId,
      'n1',
      'the wake should correspond to work queued for the target node',
    );

    const deployWake = nextMessage(ws);
    const compose = {
      services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } },
    };
    const deployed = await s.call('POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose,
    });
    assert.equal(deployed.status, 200, 'the test deployment should publish successfully');
    assert.equal(
      (await deployWake).type,
      'work-available',
      'publishing desired state should wake agents immediately',
    );
    const work = await json(
      await fetch(`${s.base}/agent/v1/work`, {
        headers: { Authorization: `Bearer ${s.registered.agentToken}` },
      }),
    );
    const report = {
      projects: [
        {
          project: 'site',
          observedVersion: 'v1',
          observedRevision: work.desiredStates[0].revision,
          health: 'serving',
          serviceStates: { web: { rolloutState: 'serving' } },
        },
      ],
    };
    const endpointWake = nextMessage(ws);
    const reported = await fetch(`${s.base}/agent/v1/status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.registered.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(report),
    });
    assert.equal(reported.status, 200, 'the serving endpoint report should be accepted');
    const endpointMessage = await endpointWake;
    assert.equal(
      endpointMessage.type,
      'work-available',
      'a changed serving endpoint should wake peers that render service DNS or ingress',
    );

    const repeated = await fetch(`${s.base}/agent/v1/status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.registered.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(report),
    });
    assert.equal(
      repeated.status,
      200,
      'repeating an unchanged endpoint report should still succeed',
    );
    const unchanged = (await json(
      await fetch(`${s.base}/agent/v1/wake?after=${endpointMessage.cursor}&timeout=25`, {
        headers: { Authorization: `Bearer ${s.registered.agentToken}` },
      }),
    )) as WakeResponse;
    assert.equal(
      unchanged.type,
      'timeout',
      'an unchanged endpoint report should not create a wake feedback loop',
    );
  } finally {
    ws.terminate();
    await s.close();
  }
});

test('stream rejects invalid agent credentials', async () => {
  const s = await server();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(s.base.replace(/^http/, 'ws') + '/agent/v1/stream', {
        headers: { Authorization: 'Bearer wrong' },
      });
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      ws.once('open', () => {
        ws.terminate();
        reject(new Error('invalid credentials unexpectedly opened a stream'));
      });
      ws.once('error', () => {});
    });
    assert.equal(
      status,
      401,
      'an invalid agent token should be rejected during the WebSocket upgrade',
    );
  } finally {
    await s.close();
  }
});

test('agent wake channel falls back to long polling when WebSockets are unavailable', async () => {
  const s = await server();
  const ctx: AgentContext = {
    docker: new FakeDocker(),
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    await s.call('POST', '/api/v1/diagnostics/nodes', { node: 'n1' });
    await assert.doesNotReject(
      waiting,
      'the HTTP fallback should release the agent when control queues work',
    );
  } finally {
    channel.close();
    await s.close();
  }
});

/** Queue messages so adjacent output/result/exit frames cannot race test listeners. */
function inbox(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const next = waiters.shift();
    if (next) next(frame);
    else messages.push(frame);
  });
  return () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const frame = messages.shift();
      if (frame) {
        resolve(frame);
        return;
      }
      const deliver = (frame: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(deliver);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('expected a live frame within two seconds'));
      }, 2000);
      waiters.push(deliver);
    });
}

async function socket(base: string, route: string, token: string) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + route, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const next = inbox(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, next, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
}

async function liveFixture(nodes = ['n1'], liveStartTimeoutMs?: number) {
  const s = await server(liveStartTimeoutMs);
  for (const name of nodes.filter((name) => name !== 'n1'))
    await s.call('POST', '/api/v1/nodes/register', { name, address: '10.0.0.2' });
  const deployed = await s.call('POST', '/api/v1/deployments', {
    project: 'site',
    version: 'v1',
    compose: { services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes } } } } },
  });
  assert.equal(deployed.status, 200, 'live test desired state should publish successfully');
  const agent = await socket(s.base, '/agent/v1/stream', s.registered.agentToken);
  assert.equal(
    (await agent.next()).type,
    'ready',
    'live fixture agent should authenticate before routing sessions',
  );
  return { ...s, agent };
}
const execRequest = {
  operation: 'exec',
  project: 'site',
  service: 'web',
  command: ['sh'],
  interactive: true,
  tty: true,
  columns: 80,
  rows: 24,
};

async function rejectedUpgrade(base: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/v1/live', {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('expected live upgrade to reject credentials'));
    });
    ws.once('error', () => {});
  });
}

test('live upgrades enforce roles and project scope before resolving desired state', async () => {
  const s = await liveFixture();
  let operator: Awaited<ReturnType<typeof socket>> | undefined;
  try {
    const read = await json(
      await s.call('POST', '/api/v1/tokens', { name: 'reader-live', role: 'read' }),
    );
    const scoped = await json(
      await s.call('POST', '/api/v1/tokens', {
        name: 'scoped-live',
        role: 'deploy',
        projects: ['own'],
      }),
    );
    assert.equal(
      await rejectedUpgrade(s.base, 'wrong'),
      401,
      'invalid credentials should fail the live upgrade',
    );
    assert.equal(
      await rejectedUpgrade(s.base, read.token),
      403,
      'read tokens should not open live sessions',
    );
    assert.equal(
      await rejectedUpgrade(s.base, s.registered.agentToken),
      401,
      'agent credentials should not authenticate an operator live socket',
    );
    assert.equal(
      (await s.call('GET', '/api/v1/live')).status,
      426,
      'authenticated ordinary GET should explain that live requires WebSocket upgrade',
    );
    operator = await socket(s.base, '/api/v1/live', scoped.token);
    operator.send({
      v: 1,
      type: 'live.open',
      request: { ...execRequest, project: 'unknown-private' },
    });
    const error = await operator.next();
    assert.equal(
      error.type,
      'live.error',
      'a scoped token should receive one terminal live error for a foreign project',
    );
    assert.match(
      String(error.message),
      /forbidden/,
      'project isolation should deny access before revealing desired-state existence',
    );
  } finally {
    operator?.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('live exec routes binary-safe input/output, resize and exit alongside wake notifications', async () => {
  const s = await liveFixture();
  const operator = await socket(s.base, '/api/v1/live', OPERATOR);
  try {
    operator.send({ v: 1, type: 'live.open', request: execRequest });
    const open = await s.agent.next();
    assert.deepEqual(
      open.request,
      execRequest,
      'control should forward only the validated live request to the placed agent',
    );
    assert.equal(
      open.type,
      'live.open',
      'control should allocate a live session on the outbound agent connection',
    );
    const sessionId = open.sessionId;
    s.agent.send({ v: 1, type: 'live.started', sessionId });
    assert.equal(
      (await operator.next()).node,
      'n1',
      'startup acknowledgment should identify the resolved node',
    );
    const data = Buffer.from([0, 255, 13, 10, 128]).toString('base64');
    operator.send({ v: 1, type: 'live.stdin', data });
    assert.deepEqual(
      await s.agent.next(),
      { v: 1, type: 'live.stdin', data, sessionId },
      'stdin must preserve arbitrary bytes while control adds the bound session identity',
    );
    operator.send({ v: 1, type: 'live.resize', columns: 120, rows: 40 });
    assert.equal(
      (await s.agent.next()).columns,
      120,
      'TTY resize should route to the bound agent session',
    );
    operator.send({ v: 1, type: 'live.stdin-end' });
    assert.equal(
      (await s.agent.next()).type,
      'live.stdin-end',
      'stdin EOF should route without terminating output',
    );
    s.agent.send({ v: 1, type: 'live.output', sessionId, stream: 'stderr', data });
    assert.equal(
      (await operator.next()).data,
      data,
      'live output must preserve arbitrary bytes as base64',
    );
    await s.call('POST', '/api/v1/diagnostics/nodes', { node: 'n1' });
    assert.equal(
      (await s.agent.next()).type,
      'work-available',
      'wake messages should coexist with an active live session',
    );
    s.agent.send({ v: 1, type: 'live.exit', sessionId, code: 7, signal: null, cancelled: false });
    assert.equal(
      (await operator.next()).code,
      7,
      'the operator should receive the remote process exit code',
    );
  } finally {
    operator.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('live structured results precede a single terminal exit and agent errors become terminal errors', async () => {
  const s = await liveFixture();
  const operator = await socket(s.base, '/api/v1/live', OPERATOR);
  let failed: Awaited<ReturnType<typeof socket>> | undefined;
  try {
    operator.send({ v: 1, type: 'live.open', request: { operation: 'ps', project: 'site' } });
    const { sessionId } = await s.agent.next();
    s.agent.send({ v: 1, type: 'live.started', sessionId });
    await operator.next();
    s.agent.send({
      v: 1,
      type: 'live.result',
      sessionId,
      result: [{ service: 'web', state: 'running' }],
    });
    assert.deepEqual(
      (await operator.next()).value,
      [{ service: 'web', state: 'running' }],
      'structured agent results should be exposed as operator values',
    );
    s.agent.send({ v: 1, type: 'live.exit', sessionId, code: 0, signal: null, cancelled: false });
    assert.equal(
      (await operator.next()).code,
      0,
      'a structured result should keep the session alive until its successful terminal exit',
    );
    failed = await socket(s.base, '/api/v1/live', OPERATOR);
    failed.send({
      v: 1,
      type: 'live.open',
      request: { operation: 'inspect', project: 'site', service: 'web' },
    });
    const second = await s.agent.next();
    s.agent.send({
      v: 1,
      type: 'live.exit',
      sessionId: second.sessionId,
      code: null,
      signal: null,
      cancelled: false,
      error: 'container missing',
    });
    assert.equal(
      (await failed.next()).message,
      'container missing',
      'an agent execution error should be returned as one terminal live.error',
    );
    assert.equal(
      (await s.agent.next()).type,
      'live.cancel',
      'terminal failures should cancel remaining remote resources idempotently',
    );
  } finally {
    operator.ws.terminate();
    failed?.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('live routing rejects ambiguity, ineligible nodes and disconnected agents without queueing', async () => {
  const s = await liveFixture(['n1', 'n2']);
  const operators: Awaited<ReturnType<typeof socket>>[] = [];
  try {
    for (const request of [
      execRequest,
      { operation: 'ps', project: 'site' },
      { ...execRequest, node: 'foreign' },
      { ...execRequest, node: 'n2' },
    ]) {
      const operator = await socket(s.base, '/api/v1/live', OPERATOR);
      operators.push(operator);
      operator.send({ v: 1, type: 'live.open', request });
      const frame = await operator.next();
      assert.equal(
        frame.type,
        'live.error',
        'ambiguous, ineligible or disconnected placement must fail instead of choosing a node or queueing',
      );
      assert.match(
        String(frame.message),
        /--node|not placed|not connected/,
        'placement failures should explain how routing failed',
      );
    }
  } finally {
    for (const operator of operators) operator.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('operator cancel/disconnect and agent replacement clean up the exact live socket generation', async () => {
  const s = await liveFixture();
  const operators: Awaited<ReturnType<typeof socket>>[] = [];
  let replacement: Awaited<ReturnType<typeof socket>> | undefined;
  try {
    for (const action of ['cancel', 'disconnect', 'replace']) {
      const operator = await socket(s.base, '/api/v1/live', OPERATOR);
      operators.push(operator);
      operator.send({ v: 1, type: 'live.open', request: execRequest });
      const opened = await s.agent.next();
      if (action === 'cancel') {
        operator.send({ v: 1, type: 'live.cancel' });
        assert.equal(
          (await operator.next()).code,
          130,
          'explicit cancellation should return a single conventional cancelled exit',
        );
      } else if (action === 'disconnect') operator.ws.terminate();
      else {
        replacement = await socket(s.base, '/agent/v1/stream', s.registered.agentToken);
        assert.equal(
          (await replacement.next()).type,
          'ready',
          'a replacement agent should establish its own wake channel',
        );
        assert.match(
          String((await operator.next()).message),
          /replaced/,
          'replacement should terminate sessions bound to the older socket generation',
        );
      }
      const cancel = await s.agent.next();
      assert.equal(
        cancel.type,
        'live.cancel',
        'all teardown paths should cancel the old remote session',
      );
      assert.equal(
        cancel.sessionId,
        opened.sessionId,
        'cleanup should affect only the exact bound session',
      );
      if (action !== 'replace') {
        s.agent.send({
          v: 1,
          type: 'live.exit',
          sessionId: opened.sessionId,
          code: null,
          signal: null,
          cancelled: true,
        });
        await s.call('POST', '/api/v1/diagnostics/nodes', { node: 'n1' });
        assert.equal(
          (await s.agent.next()).type,
          'work-available',
          'late cancellation acknowledgments must not disconnect the healthy agent',
        );
      }
    }
  } finally {
    for (const operator of operators) operator.ws.terminate();
    s.agent.ws.terminate();
    replacement?.ws.terminate();
    await s.close();
  }
});

test('live rejects foreign session spoofing and malformed/binary operator frames', async () => {
  const s = await liveFixture(['n1', 'n2']);
  const other = await json(
    await s.call('POST', '/api/v1/nodes/register', { name: 'n3', address: '10.0.0.3' }),
  );
  assert.equal(
    (await s.agent.next()).type,
    'work-available',
    'registering a mesh peer should preserve agent wake notifications',
  );
  const foreign = await socket(s.base, '/agent/v1/stream', other.agentToken);
  await foreign.next();
  const operator = await socket(s.base, '/api/v1/live', OPERATOR);
  const invalid: Awaited<ReturnType<typeof socket>>[] = [];
  try {
    operator.send({ v: 1, type: 'live.open', request: { ...execRequest, node: 'n1' } });
    const open = await s.agent.next();
    const closed = new Promise<number>((resolve) =>
      foreign.ws.once('close', (code) => resolve(code)),
    );
    foreign.send({
      v: 1,
      type: 'live.output',
      sessionId: open.sessionId,
      stream: 'stdout',
      data: 'c3Bvb2Y=',
    });
    assert.equal(
      await closed,
      1008,
      'an agent must be disconnected when spoofing another node session',
    );
    s.agent.send({ v: 1, type: 'live.started', sessionId: open.sessionId });
    assert.equal(
      (await operator.next()).type,
      'live.started',
      'a foreign agent must not interfere with the legitimate session',
    );
    for (const frame of [
      Buffer.from('{}'),
      JSON.stringify({ v: 2, type: 'live.open', request: execRequest }),
      JSON.stringify({
        v: 1,
        type: 'live.open',
        request: { ...execRequest, containerId: 'host-container' },
      }),
    ]) {
      const client = await socket(s.base, '/api/v1/live', OPERATOR);
      invalid.push(client);
      client.ws.send(frame);
      assert.equal(
        (await client.next()).type,
        'live.error',
        'binary, unsupported-version and unrecognized-target frames should be rejected',
      );
    }
    s.agent.ws.terminate();
    assert.match(
      String((await operator.next()).message),
      /disconnected/,
      'agent disconnect should terminate its active operator session',
    );
  } finally {
    operator.ws.terminate();
    for (const client of invalid) client.ws.terminate();
    foreign.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('live startup timeout cancels the pending agent operation and oversized frames close their socket', async () => {
  const s = await liveFixture(['n1'], 100);
  const operator = await socket(s.base, '/api/v1/live', OPERATOR);
  let oversized: Awaited<ReturnType<typeof socket>> | undefined;
  try {
    operator.send({ v: 1, type: 'live.open', request: execRequest });
    const opened = await s.agent.next();
    assert.match(
      String((await operator.next()).message),
      /startup timeout/,
      'an unacknowledged agent operation must fail within the startup deadline',
    );
    assert.equal(
      (await s.agent.next()).sessionId,
      opened.sessionId,
      'startup timeout must cancel the exact pending remote session',
    );
    oversized = await socket(s.base, '/api/v1/live', OPERATOR);
    const closed = new Promise<number>((resolve) =>
      oversized!.ws.once('close', (code) => resolve(code)),
    );
    oversized.ws.send(
      JSON.stringify({
        v: 1,
        type: 'live.open',
        request: { ...execRequest, command: ['x'.repeat(300_000)] },
      }),
    );
    assert.equal(
      await closed,
      1009,
      'an oversized WebSocket message must close with the message-too-big status',
    );
  } finally {
    operator.ws.terminate();
    oversized?.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('live session concurrency is bounded and cleanup immediately releases capacity', async () => {
  const s = await liveFixture();
  const operators: Awaited<ReturnType<typeof socket>>[] = [];
  try {
    for (let index = 0; index < LIVE_MAX_SESSIONS; index++) {
      const operator = await socket(s.base, '/api/v1/live', OPERATOR);
      operators.push(operator);
      operator.send({ v: 1, type: 'live.open', request: execRequest });
      const { sessionId } = await s.agent.next();
      s.agent.send({ v: 1, type: 'live.started', sessionId });
      assert.equal(
        (await operator.next()).type,
        'live.started',
        'sessions within the configured concurrency bound should start',
      );
    }
    const excess = await socket(s.base, '/api/v1/live', OPERATOR);
    operators.push(excess);
    excess.send({ v: 1, type: 'live.open', request: execRequest });
    assert.match(
      String((await excess.next()).message),
      /too many live sessions/,
      'an operation beyond the concurrency ceiling must fail without reaching an agent',
    );
    operators[0]!.send({ v: 1, type: 'live.cancel' });
    await operators[0]!.next();
    assert.equal(
      (await s.agent.next()).type,
      'live.cancel',
      'cancellation must release capacity and clean up its remote session',
    );
    const resumed = await socket(s.base, '/api/v1/live', OPERATOR);
    operators.push(resumed);
    resumed.send({ v: 1, type: 'live.open', request: execRequest });
    assert.equal(
      (await s.agent.next()).type,
      'live.open',
      'a cleaned-up session should immediately free one concurrency slot',
    );
  } finally {
    for (const operator of operators) operator.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('a stalled operator cannot grow live output buffering without cancelling the remote operation', async () => {
  const s = await liveFixture();
  const operator = await socket(s.base, '/api/v1/live', OPERATOR);
  try {
    operator.send({ v: 1, type: 'live.open', request: execRequest });
    const { sessionId } = await s.agent.next();
    s.agent.send({ v: 1, type: 'live.started', sessionId });
    await operator.next();
    operator.ws.pause();
    const data = Buffer.alloc(150_000, 0x61).toString('base64');
    for (let index = 0; index < 120; index++)
      s.agent.send({ v: 1, type: 'live.output', sessionId, stream: 'stdout', data });
    const cancelled = await s.agent.next();
    assert.equal(
      cancelled.type,
      'live.cancel',
      'exceeding an operator socket buffer must cancel its remote operation',
    );
    assert.equal(
      cancelled.sessionId,
      sessionId,
      'backpressure cleanup must remain bound to the stalled operator session',
    );
  } finally {
    operator.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});

test('live logs follow the validated service and reject stdin without allowing target overrides', async () => {
  const s = await liveFixture();
  const operator = await socket(s.base, '/api/v1/live', OPERATOR);
  try {
    const request = { operation: 'logs', project: 'site', service: 'web', follow: true, tail: 50 };
    operator.send({ v: 1, type: 'live.open', request });
    const opened = await s.agent.next();
    assert.deepEqual(
      opened.request,
      request,
      'live logs should forward the validated service, follow mode and bounded tail',
    );
    s.agent.send({ v: 1, type: 'live.started', sessionId: opened.sessionId });
    await operator.next();
    const data = Buffer.from('service log\n').toString('base64');
    s.agent.send({
      v: 1,
      type: 'live.output',
      sessionId: opened.sessionId,
      stream: 'stdout',
      data,
    });
    assert.equal(
      (await operator.next()).data,
      data,
      'following logs should stream output until terminated',
    );
    operator.send({ v: 1, type: 'live.stdin', data: 'aW5wdXQ=' });
    assert.match(
      String((await operator.next()).message),
      /does not accept input/,
      'a log session should reject exec-only input frames',
    );
    assert.equal(
      (await s.agent.next()).type,
      'live.cancel',
      'invalid log input should cancel only its bound remote operation',
    );
  } finally {
    operator.ws.terminate();
    s.agent.ws.terminate();
    await s.close();
  }
});
