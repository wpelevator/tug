import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AgentLiveOperations, AgentWakeChannel, resolveLiveContainer } from './agent.ts';
import type { AgentContext, AgentLiveControlFrame, AgentLiveOutputFrame } from './agent.ts';
import type { LiveProcess } from './live.ts';
import { LIVE_MAX_FRAME_BYTES } from './protocol.ts';

const containerId = 'a'.repeat(64);
class Child extends EventEmitter implements LiveProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: AgentLiveOutputFrame[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate(): void {
    this.close();
  }
  message(data: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }
}
async function fixture(t: test.TestContext, override: Partial<AgentContext> = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-live-agent-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const dockerCalls: string[][] = [];
  const ctx: AgentContext = {
    stateDir,
    nodeName: 'n1',
    apply: true,
    token: 'secret',
    controlUrl: 'http://control.test',
    http: fetch,
    docker: async (args) => {
      dockerCalls.push(args);
      return { out: containerId, err: '' };
    },
    ...override,
  };
  const children: Child[] = [];
  const calls: string[][] = [];
  const events: AgentLiveOutputFrame[] = [];
  const live = new AgentLiveOperations(ctx, (frame) => events.push(frame), {
    spawn: (_file, args) => {
      const child = new Child();
      children.push(child);
      calls.push(args);
      return child;
    },
  });
  t.after(() => live.dispose());
  return { ctx, live, events, children, calls, dockerCalls };
}
const open = (
  operation: 'exec' | 'logs' | 'ps' | 'inspect' = 'exec',
): Extract<AgentLiveControlFrame, { type: 'live.open' }> => {
  const base = { project: 'demo', service: 'web' };
  const request =
    operation === 'exec'
      ? { ...base, operation, command: ['printf', 'hello; $HOME'], interactive: true, tty: false }
      : operation === 'logs'
        ? { ...base, operation, follow: true as const, tail: 100 }
        : { ...base, operation };
  return { v: 1, type: 'live.open', sessionId: 'session-1', request };
};

test('wake channel discriminates live frames before cursor arithmetic and preserves fallback cursor', async (t) => {
  const requests: string[] = [];
  const { ctx } = await fixture(t, {
    http: (async (url) => {
      requests.push(String(url));
      return Response.json({ type: 'timeout', cursor: 8 });
    }) as typeof fetch,
  });
  const first = new Socket();
  let count = 0;
  let disconnects = 0;
  const frames: AgentLiveControlFrame[] = [];
  const channel = new AgentWakeChannel(
    ctx,
    () => {
      const socket = count++ === 0 ? first : new Socket();
      queueMicrotask(() => socket.emit(count === 1 ? 'open' : 'error', new Error('proxy blocked')));
      return socket as unknown as WebSocket;
    },
    {
      onLive: (frame) => {
        frames.push(frame);
      },
      onDisconnect: () => {
        disconnects++;
      },
    },
  );
  t.after(() => channel.close());
  await channel.wait(1);
  first.message({ type: 'ready', nodeId: 'node-id', cursor: 7 });
  first.message(open());
  first.message({ type: 'work-available', cursor: 'invalid' });
  first.message({ type: 'ready' });
  assert.equal(
    frames.length,
    1,
    'Live messages should reach the live handler without requiring a wake cursor',
  );
  assert.equal(
    channel.send({ v: 1, type: 'live.started', sessionId: 'session-1' }),
    true,
    'An open channel should send live agent frames',
  );
  assert.equal(first.sent.length, 1, 'Live output should be written to the outbound agent stream');
  first.close();
  await channel.wait(1);
  assert.match(
    requests[0],
    /after=7&/,
    'Live messages and malformed wake messages should not poison the fallback cursor',
  );
  assert.ok(disconnects >= 1, 'Socket loss should invoke live session cleanup');
});

test('wake channel bounds outbound buffering and disposes sessions on close', async (t) => {
  const { ctx } = await fixture(t);
  const socket = new Socket();
  let disconnected = 0;
  const channel = new AgentWakeChannel(
    ctx,
    () => {
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
    {
      onDisconnect: () => {
        disconnected++;
      },
    },
  );
  await channel.wait(1);
  socket.bufferedAmount = 1048577;
  assert.equal(
    channel.send({ v: 1, type: 'live.started', sessionId: 's' }),
    false,
    'A backlogged socket should reject further output',
  );
  assert.equal(disconnected, 1, 'A backlogged socket should dispose its live sessions once');
});

test('recreate service resolution pins a unique full container ID by exact Docker labels', async (t) => {
  const { ctx, dockerCalls } = await fixture(t);
  const id = await resolveLiveContainer(ctx, { project: 'demo', service: 'web' });
  assert.equal(id, containerId, 'Resolution should return the concrete full container ID');
  assert.deepEqual(
    dockerCalls[0],
    [
      'ps',
      '--all',
      '--no-trunc',
      '--quiet',
      '--filter',
      'label=com.docker.compose.project=demo',
      '--filter',
      'label=com.docker.compose.service=web',
      '--filter',
      'label=com.docker.compose.oneoff=False',
    ],
    'Resolution should scope both project and service and exclude one-off containers',
  );
});

test('rolling resolution selects only the active revision and rejects candidate-only services', async (t) => {
  const { ctx, dockerCalls } = await fixture(t);
  const dir = path.join(ctx.stateDir, 'projects', 'demo');
  await fs.mkdir(dir, { recursive: true });
  const state = {
    services: {
      web: {
        active: { project: 'demo-web-active' },
        candidate: { project: 'demo-web-candidate' },
        draining: [{ project: 'demo-web-old' }],
      },
    },
  };
  await fs.writeFile(path.join(dir, 'rollout.json'), JSON.stringify(state));
  await resolveLiveContainer(ctx, { project: 'demo', service: 'web' });
  assert.ok(
    dockerCalls[0].includes('label=com.docker.compose.project=demo-web-active'),
    'Rolling resolution should select the serving revision project',
  );
  assert.ok(
    !dockerCalls[0].some((arg) => /candidate|old/.test(arg)),
    'Rolling resolution should exclude candidates and draining revisions',
  );
  await fs.writeFile(
    path.join(dir, 'rollout.json'),
    JSON.stringify({
      services: { web: { candidate: state.services.web.candidate, draining: [] } },
    }),
  );
  await assert.rejects(
    resolveLiveContainer(ctx, { project: 'demo', service: 'web' }),
    /no active/,
    'A rolling service without an active revision should fail instead of targeting a candidate',
  );
});

test('agent exec acknowledges startup, preserves argv and binary input/output, and forwards exit', async (t) => {
  const { live, calls, events, children } = await fixture(t);
  await live.handle(open());
  assert.deepEqual(
    calls[0],
    ['exec', '-i', containerId, 'printf', 'hello; $HOME'],
    'Agent exec should use the pinned container and preserve command arguments',
  );
  assert.deepEqual(
    events[0],
    { v: 1, type: 'live.started', sessionId: 'session-1' },
    'Agent should acknowledge successful startup explicitly',
  );
  const bytes = Buffer.from([0, 255, 10]);
  await live.handle({
    v: 1,
    type: 'live.stdin',
    sessionId: 'session-1',
    data: bytes.toString('base64'),
  });
  assert.deepEqual(
    children[0].stdin.read(),
    bytes,
    'Agent stdin should decode base64 without UTF-8 corruption',
  );
  children[0].stderr.write(bytes);
  assert.deepEqual(
    events[1],
    {
      v: 1,
      type: 'live.output',
      sessionId: 'session-1',
      stream: 'stderr',
      data: bytes.toString('base64'),
    },
    'Agent output should preserve binary stderr in protocol frames',
  );
  await live.handle({ v: 1, type: 'live.stdin-end', sessionId: 'session-1' });
  assert.equal(children[0].stdin.writableEnded, true, 'Agent stdin-end should deliver EOF');
  children[0].emit('close', 3, null);
  assert.deepEqual(
    events.at(-1),
    { v: 1, type: 'live.exit', sessionId: 'session-1', code: 3, signal: null, cancelled: false },
    'Agent should forward the actual exit status',
  );
});

test('ps uses only selected project labels and inspect returns structured results', async (t) => {
  const { live, calls, children, events, dockerCalls } = await fixture(t);
  await live.handle(open('ps'));
  assert.equal(
    dockerCalls.length,
    0,
    'Project ps should not select an arbitrary service container',
  );
  assert.ok(
    calls[0].includes('label=com.docker.compose.project=demo'),
    'Project ps should filter the selected project label',
  );
  children[0].stdout.write('{"ID":"abc","State":"running"}\n');
  children[0].emit('close', 0, null);
  assert.ok(
    events.some((event) => event.type === 'live.result' && Array.isArray(event.result)),
    'Project ps should emit a structured result',
  );
  await live.handle(open('inspect'));
  assert.deepEqual(
    calls[1],
    ['inspect', '--type', 'container', containerId],
    'Inspect should use a pinned service container',
  );
});

test('cancellation while resolution is pending prevents process creation and buffered stdin replay', async (t) => {
  let resolve!: (value: { out: string; err: string }) => void;
  const { live, calls, events } = await fixture(t, {
    docker: async () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const starting = live.handle(open());
  while (!resolve) await new Promise((done) => setImmediate(done));
  const input = live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: 'eA==' });
  await live.handle({ v: 1, type: 'live.cancel', sessionId: 'session-1' });
  resolve({ out: containerId, err: '' });
  await Promise.all([starting, input]);
  assert.equal(calls.length, 0, 'Cancelled pending resolution should never create a process');
  assert.ok(
    events.length === 1 && events[0].type === 'live.exit' && events[0].cancelled,
    'Pending cancellation should emit one terminal cancelled frame',
  );
});

test('stdin arriving during resolution is delivered after startup in order', async (t) => {
  let resolve!: (value: { out: string; err: string }) => void;
  const { live, children } = await fixture(t, {
    docker: async () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const starting = live.handle(open());
  const first = live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: 'YQ==' });
  const second = live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: 'Yg==' });
  while (!resolve) await new Promise((done) => setImmediate(done));
  resolve({ out: containerId, err: '' });
  await Promise.all([starting, first, second]);
  const chunks: Buffer[] = [];
  for (let chunk = children[0].stdin.read(); chunk !== null; chunk = children[0].stdin.read())
    chunks.push(chunk);
  assert.equal(
    Buffer.concat(chunks).toString(),
    'ab',
    'Early stdin frames should wait for startup and preserve arrival order',
  );
});

test('channel disconnect disposes active exec and logs processes', async (t) => {
  const { ctx } = await fixture(t);
  const socket = new Socket();
  const children: Child[] = [];
  const channel = new AgentWakeChannel(
    ctx,
    () => {
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
    { onLive: (frame) => live.handle(frame), onDisconnect: () => live.dispose() },
  );
  const live = new AgentLiveOperations(
    ctx,
    (frame) => {
      channel.send(frame);
    },
    {
      spawn: () => {
        const child = new Child();
        children.push(child);
        return child;
      },
    },
  );
  t.after(() => {
    channel.close();
    live.dispose();
  });
  await channel.wait(1);
  await live.handle(open());
  await live.handle({ ...open('logs'), sessionId: 'logs' });
  socket.close();
  assert.equal(children.length, 2, 'Exec and logs should each create their own child process');
  assert.ok(
    children.every((child) => child.killed),
    'Disconnect should terminate every active live child',
  );
});

test('agent sends terminal errors for TTY unavailability, invalid input, selection errors, and wrong node', async (t) => {
  const { live, events, children } = await fixture(t);
  await live.handle({
    ...open(),
    request: { ...open().request, tty: true },
  } as AgentLiveControlFrame);
  assert.ok(
    events[0].type === 'live.exit' && events[0].error?.includes('PTY adapter'),
    'Unavailable TTY should fail explicitly through the protocol',
  );
  await live.handle(open());
  await live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: '!not-base64!' });
  assert.ok(
    events.at(-1)?.type === 'live.exit' && 'error' in events.at(-1)!,
    'Malformed base64 should produce a terminal protocol error',
  );
  assert.equal(
    children[0].killed,
    true,
    'Invalid input should terminate the corresponding process',
  );
  assert.equal(
    events.filter((event) => event.type === 'live.exit').length,
    2,
    'Failure cleanup should not emit an extra cancelled exit',
  );
  await live.handle({
    ...open(),
    request: { ...open().request, node: 'other' },
  } as AgentLiveControlFrame);
  const end = events.at(-1);
  assert.ok(
    end?.type === 'live.exit' && end.error?.includes('different node'),
    'Wrong-node requests should be rejected',
  );
  for (const out of ['', containerId + '\n' + 'b'.repeat(64), '--invalid']) {
    const f = await fixture(t, { docker: async () => ({ out, err: '' }) });
    await f.live.handle(open());
    assert.ok(
      f.events[0].type === 'live.exit' && f.events[0].error,
      'Missing, ambiguous, or malformed container selections should produce a terminal error',
    );
    assert.equal(f.calls.length, 0, 'Failed selections should never spawn exec');
  }
});

test('noninteractive agent exec closes stdin and repeated open is idempotent', async (t) => {
  const { live, calls, children } = await fixture(t);
  const request = open();
  assert.equal(request.request.operation, 'exec', 'Fixture should create an exec request');
  await live.handle({
    ...request,
    request: { ...request.request, interactive: false },
  } as AgentLiveControlFrame);
  await live.handle(request);
  assert.equal(
    calls.length,
    1,
    'Replayed open frames should not create duplicate Docker processes',
  );
  assert.equal(
    calls[0].includes('-i'),
    false,
    'Noninteractive protocol requests should omit Docker input attachment',
  );
  assert.equal(
    children[0].stdin.writableEnded,
    true,
    'Noninteractive protocol requests should deliver immediate EOF',
  );
});

test('project ps includes base and active rolling revisions while excluding candidate, draining and foreign projects', async (t) => {
  const { ctx, live, calls, children, events } = await fixture(t);
  const dir = path.join(ctx.stateDir, 'projects', 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'rollout.json'),
    JSON.stringify({
      services: {
        web: {
          active: { project: 'demo-web-active' },
          candidate: { project: 'demo-web-candidate' },
          draining: [{ project: 'demo-web-old' }],
        },
        api: { active: { project: 'demo-api-active' }, draining: [] },
        legacy: { active: { project: 'demo' }, draining: [] },
        pending: {
          candidate: { project: 'demo-pending-candidate' },
          draining: [{ project: 'demo-pending-old' }],
        },
      },
    }),
  );
  const foreign = path.join(ctx.stateDir, 'projects', 'foreign');
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(
    path.join(foreign, 'rollout.json'),
    JSON.stringify({
      services: { web: { active: { project: 'foreign-web-active' }, draining: [] } },
    }),
  );
  await live.handle(open('ps'));
  for (let index = 0; index < 3; index++) {
    assert.ok(children[index], 'Every selected active project should have a Docker query');
    children[index].stdout.write(JSON.stringify({ ID: String(index), State: 'running' }) + '\n');
    children[index].emit('close', 0, null);
  }
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    [
      'label=com.docker.compose.project=demo',
      'label=com.docker.compose.project=demo-web-active',
      'label=com.docker.compose.project=demo-api-active',
    ],
    'PS should query the base and every unique active rolling project with exact label filters only',
  );
  assert.equal(
    calls.length,
    3,
    'PS should exclude candidate, draining, foreign, and duplicate legacy project queries',
  );
  const result = events.find((event) => event.type === 'live.result');
  assert.ok(
    result?.type === 'live.result' && Array.isArray(result.result) && result.result.length === 3,
    'Project PS should return the combined base and active revision container rows',
  );
  assert.equal(
    events.filter((event) => event.type === 'live.exit').length,
    1,
    'Project aggregation should produce exactly one terminal exit',
  );
});

test('oversized structured results fail within frame limits while subsequent sessions remain usable', async (t) => {
  const { live, children, events } = await fixture(t);
  await live.handle(open('inspect'));
  children[0].stdout.write(
    JSON.stringify([{ value: '€'.repeat(Math.ceil(LIVE_MAX_FRAME_BYTES / 3)) }]),
  );
  children[0].emit('close', 0, null);
  assert.equal(
    events.filter((event) => event.type === 'live.result').length,
    0,
    'An oversized inspect should never emit a structured frame to the shared agent socket',
  );
  const error = events.at(-1);
  assert.ok(
    error?.type === 'live.exit' && error.error?.includes('serialized frame size limit'),
    'Oversized UTF-8 inspect output should become a terminal size-limit error',
  );
  for (const frame of events)
    assert.ok(
      Buffer.byteLength(JSON.stringify(frame)) <= LIVE_MAX_FRAME_BYTES,
      'Every emitted agent frame should fit the shared protocol byte limit',
    );
  await live.handle(open('ps'));
  children[1].stdout.write('{"ID":"healthy"}\n');
  children[1].emit('close', 0, null);
  assert.ok(
    events.some((event) => event.type === 'live.result'),
    'Rejecting an oversized result should leave the shared channel usable for later operations',
  );
});
