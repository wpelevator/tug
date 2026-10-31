import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { LIVE_MAX_FRAME_BYTES } from './protocol.ts';
import { LiveOperationEngine } from './live.ts';
import type { LiveEvent, LiveEngineOptions } from './live.ts';
import type {
  AttachedProcess,
  ContainerFilter,
  ContainerSummary,
  DockerApi,
  ExecOptions,
  LogsOptions,
} from './docker-api.ts';

class FakeProcess extends EventEmitter implements AttachedProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: (NodeJS.Signals | undefined)[] = [];
  dimensions: number[][] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}
class TtyProcess extends FakeProcess {
  resize(columns: number, rows: number): void {
    this.dimensions.push([columns, rows]);
  }
}

/** Just the Engine API calls the live engine makes, recorded; processes are handed back for the test to drive. */
function fixture(options: Partial<LiveEngineOptions> = {}) {
  const children: FakeProcess[] = [];
  const calls: { op: string; id?: string; options?: unknown }[] = [];
  const events: LiveEvent[] = [];
  const state: {
    ps: (filter?: ContainerFilter) => Promise<ContainerSummary[]>;
    inspect: () => Promise<object>;
    failExec?: Error;
  } = {
    ps: async () => [],
    inspect: async () => ({ Id: 'app-1' }),
  };
  const docker = {
    async execStart(id: string, execOptions: ExecOptions) {
      calls.push({ op: 'exec', id, options: execOptions });
      if (state.failExec) throw state.failExec;
      const child = execOptions.tty ? new TtyProcess() : new FakeProcess();
      children.push(child);
      return child;
    },
    async logs(id: string, logsOptions: LogsOptions) {
      calls.push({ op: 'logs', id, options: logsOptions });
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
    async listContainers(filter?: ContainerFilter) {
      calls.push({ op: 'ps', options: filter });
      return state.ps(filter);
    },
    async inspectContainer(id: string) {
      calls.push({ op: 'inspect', id });
      return state.inspect();
    },
  } as unknown as DockerApi;
  const engine = new LiveOperationEngine({
    emit: (event) => events.push(event),
    docker,
    ...options,
  });
  return { engine, events, calls, children, state };
}
const exec = {
  operation: 'exec',
  sessionId: 'exec-1',
  container: 'app-1',
  command: ['sh', '-c', 'printf "%s" "$HOME; x"'],
} as const;
function execRequest() {
  return { ...exec, command: [...exec.command] };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (id: string): ContainerSummary => ({
  Id: id,
  Names: [`/${id}`],
  Image: 'x',
  State: 'running',
  Labels: {},
});

test('exec preserves argv, streams binary stdout/stderr, forwards stdin and exits once', async () => {
  const { engine, events, calls, children } = fixture();
  await engine.start(execRequest());
  const child = children[0];
  assert.deepEqual(
    calls[0],
    {
      op: 'exec',
      id: 'app-1',
      options: {
        cmd: exec.command,
        stdin: true,
        tty: false,
        columns: undefined,
        rows: undefined,
      },
    },
    'the Engine receives the argv as separate entries with shell metacharacters preserved',
  );
  const input = Buffer.from('input\n');
  assert.equal(engine.stdin('exec-1', input), true, 'Small input should report writable capacity');
  assert.deepEqual(child.stdin.read(), input, 'Exec stdin should receive the exact input bytes');
  child.stdout.write(Buffer.from([0, 255, 10]));
  child.stderr.write('warning');
  assert.deepEqual(
    events.slice(0, 2),
    [
      { sessionId: 'exec-1', type: 'output', stream: 'stdout', data: 'AP8K', encoding: 'base64' },
      {
        sessionId: 'exec-1',
        type: 'output',
        stream: 'stderr',
        data: Buffer.from('warning').toString('base64'),
        encoding: 'base64',
      },
    ],
    'Output events should preserve stream identity and arbitrary bytes',
  );
  engine.endStdin('exec-1');
  assert.equal(child.stdin.writableEnded, true, 'Input EOF should close only the child stdin');
  child.emit('close', 7, null);
  child.emit('close', 9, null);
  assert.deepEqual(
    events.at(-1),
    { sessionId: 'exec-1', type: 'exit', code: 7, signal: null, cancelled: false },
    'Exec should report its actual exit status once',
  );
  assert.equal(events.length, 3, 'Duplicate close events should not emit duplicate exits');
  assert.equal(engine.activeSessions, 0, 'Exited exec should release its session slot');
  assert.equal(child.stdout.listenerCount('data'), 0, 'Exit should detach stdout listeners');
  assert.equal(child.listenerCount('close'), 0, 'Exit should detach process listeners');
});

test('TTY exec gets a real terminal with initial dimensions and resizes through the Engine API', async () => {
  const { engine, calls, children } = fixture();
  await engine.start({ ...execRequest(), tty: true, columns: 120, rows: 40 });
  assert.deepEqual(
    calls[0].options,
    { cmd: exec.command, stdin: true, tty: true, columns: 120, rows: 40 },
    'TTY exec requests a terminal of the initial size',
  );
  engine.resize('exec-1', 90, 30);
  assert.deepEqual(
    (children[0] as TtyProcess).dimensions,
    [[90, 30]],
    'a later resize reaches the terminal',
  );
  assert.throws(() => engine.resize('exec-1', 0, 30), /dimensions/, 'Zero dimensions are rejected');
  engine.dispose();

  const plain = fixture();
  await plain.engine.start(execRequest());
  assert.throws(
    () => plain.engine.resize('exec-1', 80, 24),
    /no terminal/,
    'a session without a terminal cannot be resized',
  );
});

test('logs follows bounded tail and emits capped frames without buffering lines', async () => {
  const { engine, calls, events, children } = fixture();
  await engine.start({
    operation: 'logs',
    sessionId: 'logs',
    container: 'web',
    tail: 25,
    timestamps: true,
  });
  assert.deepEqual(
    calls[0],
    { op: 'logs', id: 'web', options: { follow: true, tail: 25, timestamps: true } },
    'Logs should follow the requested bounded tail with timestamps',
  );
  children[0].stdout.write(Buffer.alloc(70000, 120));
  children[0].stderr.write('partial line');
  assert.equal(
    events.length,
    3,
    'Logs should emit partial lines immediately and split large frames',
  );
  for (const event of events)
    if (event.type === 'output')
      assert.ok(
        Buffer.from(event.data, 'base64').length <= 65536,
        'Every output frame should be bounded to 64 KiB',
      );
  engine.cancel('logs');
  children[0].stdout.write('ignored');
  engine.cancel('logs');
  assert.deepEqual(children[0].signals, ['SIGKILL'], 'Cancellation should kill the stream once');
  assert.equal(
    events.length,
    4,
    'Cancelled logs suppress later output and duplicate terminal events',
  );
  assert.deepEqual(
    events.at(-1),
    { sessionId: 'logs', type: 'exit', code: null, signal: null, cancelled: true },
    'Cancellation should report a terminal cancelled event',
  );
});

test('ps returns the containers of the selected projects as one bounded session', async () => {
  const { engine, events, calls, state } = fixture();
  state.ps = async (filter) => [row(`${filter?.label?.[0]}`)];
  await engine.start({ operation: 'ps', sessionId: 'ps', projects: ['demo', 'other', 'demo'] });
  assert.deepEqual(
    calls.map((c) => c.options),
    [{ label: ['tug.project=demo'] }, { label: ['tug.project=other'] }],
    'each distinct project is queried once with its exact label',
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['result', 'exit'],
    'the rows arrive in one result followed by one exit',
  );
  assert.equal((events[0] as Extract<LiveEvent, { type: 'result' }>).result.length, 2);
  assert.equal(engine.activeSessions, 0, 'a finished query releases its slot');
});

test('inspect returns a structured object and forwards Engine errors', async () => {
  const { engine, events, state } = fixture();
  await engine.start({ operation: 'inspect', sessionId: 'i1', container: 'app-1' });
  assert.deepEqual(events[0], { sessionId: 'i1', type: 'result', result: [{ Id: 'app-1' }] });
  assert.deepEqual(events[1], {
    sessionId: 'i1',
    type: 'exit',
    code: 0,
    signal: null,
    cancelled: false,
  });

  state.inspect = async () => {
    throw new Error('No such container: gone');
  };
  await engine.start({ operation: 'inspect', sessionId: 'i2', container: 'gone' });
  assert.deepEqual(
    events.at(-1),
    {
      sessionId: 'i2',
      type: 'exit',
      code: 1,
      signal: null,
      cancelled: false,
      error: 'No such container: gone',
    },
    'an Engine error becomes the terminal error with no partial result',
  );
  assert.equal(events.filter((e) => e.sessionId === 'i2' && e.type === 'result').length, 0);
});

test('malformed requests never reach the Engine', async () => {
  const { engine, calls } = fixture();
  const bad: unknown[] = [
    null,
    { ...execRequest(), sessionId: '../x' },
    { ...execRequest(), operation: 'rm' },
    { ...execRequest(), container: '--privileged' },
    { ...execRequest(), command: [] },
    { ...execRequest(), command: [''] },
    { ...execRequest(), command: ['a\0b'] },
    { ...execRequest(), columns: 5000 },
    { operation: 'logs', sessionId: 'l', container: 'web', tail: -1 },
    { operation: 'logs', sessionId: 'l', container: 'web', tail: 10001 },
    { operation: 'ps', sessionId: 'p', projects: [] },
    { operation: 'ps', sessionId: 'p', projects: ['-bad'] },
    { operation: 'ps', sessionId: 'p', projects: 'demo' },
  ];
  for (const request of bad) await assert.rejects(engine.start(request), /Invalid/);
  assert.deepEqual(calls, [], 'validation failures do not call Docker');
});

test('duplicate sessions and concurrent session limits reject before any Engine call', async () => {
  const { engine, calls } = fixture({ maxSessions: 2 });
  await engine.start(execRequest());
  await assert.rejects(engine.start(execRequest()), /Duplicate live session ID/);
  await engine.start({ ...execRequest(), sessionId: 'exec-2' });
  await assert.rejects(engine.start({ ...execRequest(), sessionId: 'exec-3' }), /session limit/);
  assert.equal(calls.length, 2, 'rejected starts create no stream');
  engine.dispose();
});

test('stdin and resize reject unknown, oversized, closed, or inapplicable sessions', async () => {
  const { engine, children } = fixture();
  assert.throws(() => engine.stdin('missing', Buffer.from('x')), /Unknown exec session/);
  await engine.start(execRequest());
  assert.throws(() => engine.stdin('exec-1', new Uint8Array(65537)), /Invalid stdin frame/);
  children[0].stdin.end();
  assert.throws(() => engine.stdin('exec-1', Buffer.from('x')), /stdin is closed/);
  await engine.start({ operation: 'logs', sessionId: 'logs', container: 'web' });
  assert.throws(() => engine.stdin('logs', Buffer.from('x')), /Unknown exec session/);
  assert.throws(() => engine.resize('logs', 80, 24), /Unknown exec session/);
  engine.dispose();
});

test('stdin buffering remains bounded even if a transport ignores backpressure', async () => {
  const { engine, children } = fixture();
  await engine.start(execRequest());
  children[0].stdin.pause();
  children[0].stdin.cork();
  let rejected = false;
  for (let i = 0; i < 20 && !rejected; i++) {
    try {
      engine.stdin('exec-1', Buffer.alloc(65536));
    } catch (error) {
      rejected = /queue exceeds size limit/.test(String(error));
    }
  }
  assert.ok(rejected, 'a transport that ignores backpressure hits the queue limit');
  engine.dispose();
});

test('a failing exec start releases the session and reports the error to the caller', async () => {
  const { engine, state } = fixture();
  state.failExec = new Error('container is not running');
  await assert.rejects(engine.start(execRequest()), /container is not running/);
  assert.equal(engine.activeSessions, 0, 'a failed start holds no session slot');
  state.failExec = undefined;
  await engine.start(execRequest());
  assert.equal(engine.activeSessions, 1, 'the same session ID can start again');
  engine.dispose();
});

test('process errors release the session and emit one terminal event', async () => {
  const { engine, events, children } = fixture();
  await engine.start(execRequest());
  children[0].emit('error', new Error('socket hang up'));
  children[0].emit('close', null, null);
  assert.deepEqual(events.filter((e) => e.type === 'exit').length, 1);
  assert.equal((events.at(-1) as Extract<LiveEvent, { type: 'exit' }>).error, 'socket hang up');
  assert.equal(engine.activeSessions, 0);
  assert.deepEqual(children[0].signals, ['SIGKILL'], 'a broken stream is torn down');
});

test('a cancel that arrives while the stream is opening closes it on arrival', async () => {
  const { engine, events, children } = fixture();
  const starting = engine.start(execRequest());
  engine.cancel('exec-1');
  await starting;
  assert.deepEqual(children[0].signals, ['SIGKILL'], 'the late stream is killed');
  assert.deepEqual(events, [
    { sessionId: 'exec-1', type: 'exit', code: null, signal: null, cancelled: true },
  ]);
  assert.equal(engine.activeSessions, 0);
  await tick();
});

test('query and stream timeouts terminate and clean up', async () => {
  const { engine, children, events, state } = fixture({ queryTimeoutMs: 5, maxSessionMs: 5 });
  state.ps = () => new Promise(() => {});
  await engine.start({ operation: 'ps', sessionId: 'ps', projects: ['demo'] }).catch(() => {});
  await engine.start(execRequest());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(engine.activeSessions, 0, 'All operation types should have a maximum lifetime');
  assert.equal(
    events.filter((e) => e.type === 'exit').length,
    2,
    'Each timed-out session emits one exit',
  );
  assert.ok(
    events.every((e) => e.type !== 'exit' || e.error === 'Live operation timed out'),
    'the exit says the operation timed out',
  );
  for (const child of children)
    assert.deepEqual(child.signals, ['SIGKILL'], 'Timeout should kill every timed-out stream');
});

test('dispose cancels all operations and validates engine bounds', async () => {
  const { engine, children, events } = fixture();
  await engine.start(execRequest());
  await engine.start({ operation: 'logs', sessionId: 'logs', container: 'web' });
  engine.dispose();
  assert.equal(engine.activeSessions, 0, 'Disposal should release all active sessions');
  assert.equal(
    events.filter((event) => event.type === 'exit' && event.cancelled).length,
    2,
    'Disposal should notify each session of cancellation',
  );
  for (const child of children) {
    assert.equal(child.stdout.listenerCount('data'), 0, 'Disposal should remove output listeners');
    child.emit('error', new Error('late error'));
    child.stdin.emit('error', new Error('late input error'));
    child.emit('close', null, 'SIGKILL');
    assert.equal(child.listenerCount('error'), 0, 'close after disposal removes error listeners');
  }
  for (const key of ['maxSessions', 'maxSessionMs', 'queryTimeoutMs'])
    assert.throws(() => fixture({ [key]: 0 }), /Invalid/, 'limits must be positive integers');
});

test('noninteractive exec omits the stdin attachment and sends EOF', async () => {
  const { engine, calls, children } = fixture();
  await engine.start({ ...execRequest(), interactive: false });
  assert.equal((calls[0].options as ExecOptions).stdin, false, 'no input attachment is requested');
  assert.equal(children[0].stdin.writableEnded, true, 'Noninteractive exec delivers immediate EOF');
});

test('structured results larger than a protocol frame fail instead of being emitted', async () => {
  const { engine, events, state } = fixture();
  state.inspect = async () => ({ value: '€'.repeat(Math.ceil(LIVE_MAX_FRAME_BYTES / 3)) });
  await engine.start({ operation: 'inspect', sessionId: 'big', container: 'app-1' });
  assert.equal(
    events.filter((e) => e.type === 'result').length,
    0,
    'no oversized frame is emitted',
  );
  const exit = events.at(-1) as Extract<LiveEvent, { type: 'exit' }>;
  assert.match(exit.error ?? '', /serialized frame size limit/);

  // A result that fits exactly stays deliverable.
  const filler = '€'.repeat(Math.floor(LIVE_MAX_FRAME_BYTES / 3));
  let size = LIVE_MAX_FRAME_BYTES + 1;
  let pad = 0;
  while (size > LIVE_MAX_FRAME_BYTES) {
    const value = filler.slice(0, filler.length - pad++);
    size = Buffer.byteLength(
      JSON.stringify({ v: 1, type: 'live.result', sessionId: 'fit', result: [{ value }] }),
    );
    state.inspect = async () => ({ value });
  }
  await engine.start({ operation: 'inspect', sessionId: 'fit', container: 'app-1' });
  assert.ok(
    events.some((e) => e.sessionId === 'fit' && e.type === 'result'),
    'a result at or under the frame limit is delivered',
  );
});
