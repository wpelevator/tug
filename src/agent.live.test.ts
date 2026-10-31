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
import { LIVE_MAX_FRAME_BYTES } from './protocol.ts';
import type { AttachedProcess, ExecOptions } from './docker-api.ts';
import { FakeDocker } from '../tests/fake-docker.ts';

class Child extends EventEmitter implements AttachedProcess {
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

/** A node with one `demo/web` container whose exec and logs streams the test drives through `children`. */
async function fixture(t: test.TestContext, override: Partial<AgentContext> = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-live-agent-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const docker = new FakeDocker();
  docker.addImage('app');
  const containerId = await docker.createContainer('tug-demo-web-1', {
    Image: 'app',
    Labels: { 'tug.project': 'demo', 'tug.service': 'web' },
  });
  await docker.startContainer(containerId);
  const children: Child[] = [];
  const execs: { id: string; options: ExecOptions }[] = [];
  docker.execStart = async (id, options) => {
    const child = new Child();
    children.push(child);
    execs.push({ id, options });
    if (options.stdin === false) child.stdin.end();
    return child as unknown as AttachedProcess;
  };
  docker.logs = async () => {
    const child = new Child();
    children.push(child);
    return child as unknown as AttachedProcess;
  };
  const ctx: AgentContext = {
    stateDir,
    nodeName: 'n1',
    apply: true,
    token: 'secret',
    controlUrl: 'http://control.test',
    http: fetch,
    docker,
    ...override,
  };
  const events: AgentLiveOutputFrame[] = [];
  const live = new AgentLiveOperations(ctx, (frame) => events.push(frame));
  t.after(() => live.dispose());
  return { ctx, live, events, children, execs, docker, containerId };
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
const settle = () => new Promise((resolve) => setImmediate(resolve));

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

test('service resolution pins the unique full container ID by exact Tug labels', async (t) => {
  const { ctx, containerId, docker } = await fixture(t);
  const id = await resolveLiveContainer(ctx, { project: 'demo', service: 'web' });
  assert.equal(id, containerId, 'Resolution should return the concrete full container ID');

  const other = await docker.createContainer('tug-demo-api-1', {
    Image: 'app',
    Labels: { 'tug.project': 'demo-other', 'tug.service': 'web' },
  });
  await docker.startContainer(other);
  assert.equal(
    await resolveLiveContainer(ctx, { project: 'demo', service: 'web' }),
    containerId,
    'a service of the same name in another project is never selected',
  );
});

test('resolution rejects missing, ambiguous and malformed selections', async (t) => {
  const { ctx, docker } = await fixture(t);
  await assert.rejects(
    resolveLiveContainer(ctx, { project: 'demo', service: 'api' }),
    /no container on this node/,
    'a service with no container fails explicitly',
  );
  const dup = await docker.createContainer('tug-demo-web-2', {
    Image: 'app',
    Labels: { 'tug.project': 'demo', 'tug.service': 'web' },
  });
  await docker.startContainer(dup);
  await assert.rejects(
    resolveLiveContainer(ctx, { project: 'demo', service: 'web' }),
    /multiple containers/,
    'two containers for one service are ambiguous',
  );
  for (const request of [
    { project: '../x', service: 'web' },
    { project: 'demo', service: '--all' },
    { project: 'demo' },
  ])
    await assert.rejects(resolveLiveContainer(ctx, request), /valid project and service/);
});

test('rolling resolution selects only the active revision and rejects candidate-only services', async (t) => {
  const { ctx, docker } = await fixture(t);
  const dir = path.join(ctx.stateDir, 'projects', 'demo');
  await fs.mkdir(dir, { recursive: true });
  const labels = { 'tug.project': 'demo', 'tug.service': 'web' };
  for (const name of ['tug-demo-web-active', 'tug-demo-web-candidate'])
    await docker.startContainer(
      await docker.createContainer(name, { Image: 'app', Labels: labels }),
    );
  const state = {
    services: {
      web: {
        active: { container: 'tug-demo-web-active' },
        candidate: { container: 'tug-demo-web-candidate' },
        draining: [{ container: 'tug-demo-web-1' }],
      },
    },
  };
  await fs.writeFile(path.join(dir, 'rollout.json'), JSON.stringify(state));
  const id = await resolveLiveContainer(ctx, { project: 'demo', service: 'web' });
  assert.equal(
    id,
    docker.byName('tug-demo-web-active')!.id,
    'Rolling resolution should select the serving revision, not a candidate or draining container',
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
  const { live, execs, events, children, containerId } = await fixture(t);
  await live.handle(open());
  assert.deepEqual(
    execs[0],
    {
      id: containerId,
      options: {
        cmd: ['printf', 'hello; $HOME'],
        stdin: true,
        tty: false,
        columns: undefined,
        rows: undefined,
      },
    },
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

test('TTY exec is allocated a terminal of the requested size', async (t) => {
  const { live, execs, events } = await fixture(t);
  const request = open();
  await live.handle({
    ...request,
    request: { ...request.request, tty: true, columns: 100, rows: 30 },
  } as AgentLiveControlFrame);
  assert.deepEqual(
    execs[0].options,
    { cmd: ['printf', 'hello; $HOME'], stdin: true, tty: true, columns: 100, rows: 30 },
    'the Engine API exec is created with a TTY and its console size',
  );
  assert.deepEqual(events[0], { v: 1, type: 'live.started', sessionId: 'session-1' });
});

test('ps lists the selected project from the Engine and inspect returns structured results', async (t) => {
  const { live, events, containerId } = await fixture(t);
  await live.handle(open('ps'));
  const result = events.find((event) => event.type === 'live.result');
  assert.ok(
    result?.type === 'live.result' &&
      Array.isArray(result.result) &&
      result.result.length === 1 &&
      result.result[0].Id === containerId,
    'Project ps emits the project containers as a structured result',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['live.started', 'live.result', 'live.exit'],
    'a query is acknowledged, answers once and exits',
  );

  await live.handle({ ...open('inspect'), sessionId: 'session-2' });
  const inspected = events.find(
    (event) => event.type === 'live.result' && event.sessionId === 'session-2',
  );
  assert.ok(
    inspected?.type === 'live.result' &&
      (inspected.result as { Id: string }[])[0].Id === containerId,
    'Inspect returns the pinned service container',
  );
});

test('cancellation while resolution is pending prevents process creation and buffered stdin replay', async (t) => {
  const { live, events, execs, docker } = await fixture(t);
  let release!: () => void;
  const list = docker.listContainers.bind(docker);
  docker.listContainers = async (filter, all) => {
    await new Promise<void>((done) => {
      release = done;
    });
    return list(filter, all);
  };
  const starting = live.handle(open());
  while (!release) await settle();
  const input = live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: 'eA==' });
  await live.handle({ v: 1, type: 'live.cancel', sessionId: 'session-1' });
  release();
  await Promise.all([starting, input]);
  assert.equal(execs.length, 0, 'Cancelled pending resolution should never create a process');
  assert.ok(
    events.length === 1 && events[0].type === 'live.exit' && events[0].cancelled,
    'Pending cancellation should emit one terminal cancelled frame',
  );
});

test('stdin arriving during resolution is delivered after startup in order', async (t) => {
  const { live, children, docker } = await fixture(t);
  let release!: () => void;
  const list = docker.listContainers.bind(docker);
  docker.listContainers = async (filter, all) => {
    await new Promise<void>((done) => {
      release = done;
    });
    return list(filter, all);
  };
  const starting = live.handle(open());
  const first = live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: 'YQ==' });
  const second = live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: 'Yg==' });
  while (!release) await settle();
  release();
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
  const { ctx, children } = await fixture(t);
  const socket = new Socket();
  const channel = new AgentWakeChannel(
    ctx,
    () => {
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
    { onLive: (frame) => live.handle(frame), onDisconnect: () => live.dispose() },
  );
  const live = new AgentLiveOperations(ctx, (frame) => {
    channel.send(frame);
  });
  t.after(() => {
    channel.close();
    live.dispose();
  });
  await channel.wait(1);
  await live.handle(open());
  await live.handle({ ...open('logs'), sessionId: 'logs' });
  socket.close();
  assert.equal(children.length, 2, 'Exec and logs should each create their own stream');
  assert.ok(
    children.every((child) => child.killed),
    'Disconnect should terminate every active live stream',
  );
});

test('agent sends terminal errors for invalid input, selection errors, wrong node and a daemon failure', async (t) => {
  const { live, events, children, docker } = await fixture(t);
  await live.handle(open());
  await live.handle({ v: 1, type: 'live.stdin', sessionId: 'session-1', data: '!not-base64!' });
  assert.ok(
    events.at(-1)?.type === 'live.exit' && 'error' in events.at(-1)!,
    'Malformed base64 should produce a terminal protocol error',
  );
  assert.equal(children[0].killed, true, 'Invalid input should terminate the corresponding stream');
  assert.equal(
    events.filter((event) => event.type === 'live.exit').length,
    1,
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

  const missing = await fixture(t);
  await missing.live.handle({
    ...open(),
    request: { ...open().request, service: 'nope' },
  } as AgentLiveControlFrame);
  assert.ok(
    missing.events[0].type === 'live.exit' && missing.events[0].error,
    'A service with no container produces a terminal error',
  );
  assert.equal(missing.execs.length, 0, 'Failed selections should never start an exec');

  docker.execStart = async () => {
    throw new Error('container is paused');
  };
  await live.handle({ ...open(), sessionId: 'session-3' });
  const failure = events.at(-1);
  assert.ok(
    failure?.type === 'live.exit' && failure.error === 'container is paused',
    'An Engine failure while starting the exec is reported to the operator',
  );
});

test('noninteractive agent exec closes stdin and repeated open is idempotent', async (t) => {
  const { live, execs, children } = await fixture(t);
  const request = open();
  assert.equal(request.request.operation, 'exec', 'Fixture should create an exec request');
  await live.handle({
    ...request,
    request: { ...request.request, interactive: false },
  } as AgentLiveControlFrame);
  await live.handle(request);
  assert.equal(execs.length, 1, 'Replayed open frames should not create duplicate execs');
  assert.equal(execs[0].options.stdin, false, 'Noninteractive requests omit the input attachment');
  assert.equal(
    children[0].stdin.writableEnded,
    true,
    'Noninteractive protocol requests should deliver immediate EOF',
  );
});

test('project ps returns only the selected project and never a rolling candidate state of another', async (t) => {
  const { ctx, live, events, docker } = await fixture(t);
  const foreign = await docker.createContainer('tug-foreign-web-1', {
    Image: 'app',
    Labels: { 'tug.project': 'foreign', 'tug.service': 'web' },
  });
  await docker.startContainer(foreign);
  const dir = path.join(ctx.stateDir, 'projects', 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'rollout.json'),
    JSON.stringify({ services: { web: { candidate: { container: 'x' }, draining: [] } } }),
  );
  await live.handle(open('ps'));
  const result = events.find((event) => event.type === 'live.result');
  assert.ok(
    result?.type === 'live.result' && (result.result as unknown[]).length === 1,
    'only the selected project containers are listed',
  );
  assert.equal(events.filter((event) => event.type === 'live.exit').length, 1);
});

test('oversized structured results fail within frame limits while subsequent sessions remain usable', async (t) => {
  const { live, events, docker, containerId } = await fixture(t);
  const inspect = docker.inspectContainer.bind(docker);
  docker.inspectContainer = async (id) => ({
    ...(await inspect(id)),
    big: '€'.repeat(Math.ceil(LIVE_MAX_FRAME_BYTES / 3)),
  });
  await live.handle(open('inspect'));
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
  docker.inspectContainer = inspect;
  await live.handle({ ...open('ps'), sessionId: 'session-2' });
  assert.ok(
    events.some((event) => event.type === 'live.result' && event.sessionId === 'session-2'),
    'Rejecting an oversized result should leave the shared channel usable for later operations',
  );
  assert.ok(containerId);
});
