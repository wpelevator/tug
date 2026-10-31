import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { LIVE_MAX_FRAME_BYTES } from './protocol.ts';
import { LiveOperationEngine } from './live.ts';
import type { LiveEvent, LiveProcess, LiveEngineOptions } from './live.ts';

class FakeProcess extends EventEmitter implements LiveProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: (NodeJS.Signals | undefined)[] = [];
  dimensions: number[][] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  resize(columns: number, rows: number): void {
    this.dimensions.push([columns, rows]);
  }
}
function fixture(options: Partial<LiveEngineOptions> = {}) {
  const children: FakeProcess[] = [];
  const calls: { file: string; args: string[] }[] = [];
  const events: LiveEvent[] = [];
  const spawn = (file: string, args: string[]) => {
    const child = new FakeProcess();
    calls.push({ file, args });
    children.push(child);
    return child;
  };
  const engine = new LiveOperationEngine({
    emit: (event) => events.push(event),
    spawn,
    ...options,
  });
  return { engine, events, calls, children, spawn };
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

test('exec preserves argv, streams binary stdout/stderr, forwards stdin and exits once', () => {
  const { engine, events, calls, children } = fixture();
  engine.start(execRequest());
  const child = children[0];
  assert.deepEqual(
    calls[0],
    { file: 'docker', args: ['exec', '-i', 'app-1', ...exec.command] },
    'Docker should receive separate argv entries with shell metacharacters preserved',
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

test('TTY requires an adapter and supports initial dimensions and resize', () => {
  const { engine } = fixture();
  assert.throws(
    () => engine.start({ ...execRequest(), tty: true }),
    /PTY adapter/,
    'TTY exec should fail explicitly when a PTY is unavailable',
  );
  const child = new FakeProcess();
  const calls: string[][] = [];
  const tty = fixture({
    spawnTty: (_file, args) => {
      calls.push(args);
      return child;
    },
  });
  tty.engine.start({ ...execRequest(), tty: true, columns: 120, rows: 40 });
  tty.engine.resize('exec-1', 90, 30);
  assert.deepEqual(
    calls[0].slice(0, 4),
    ['exec', '-i', '-t', 'app-1'],
    'TTY exec should request Docker interactive and terminal modes',
  );
  assert.deepEqual(
    child.dimensions,
    [
      [120, 40],
      [90, 30],
    ],
    'PTY should receive both initial and later terminal sizes',
  );
  assert.throws(
    () => tty.engine.resize('exec-1', 0, 30),
    /dimensions/,
    'Zero terminal dimensions should be rejected',
  );
  tty.engine.dispose();
});

test('TTY adapter missing resize fails and releases the process', () => {
  const child = new FakeProcess();
  Object.defineProperty(child, 'resize', { value: undefined });
  const { engine, events } = fixture({ spawnTty: () => child });
  engine.start({ ...execRequest(), tty: true });
  assert.ok(
    events[0].type === 'exit' && events[0].error === 'PTY adapter does not support resize',
    'Missing resize should produce an explanatory terminal event',
  );
  assert.deepEqual(child.signals, ['SIGKILL'], 'Invalid PTY adapter should terminate its process');
  assert.equal(engine.activeSessions, 0, 'Invalid PTY adapter should release its session');
});

test('logs follows bounded tail and emits capped frames without buffering lines', () => {
  const { engine, calls, events, children } = fixture();
  engine.start({
    operation: 'logs',
    sessionId: 'logs',
    container: 'web',
    tail: 25,
    timestamps: true,
  });
  assert.deepEqual(
    calls[0].args,
    ['logs', '--follow', '--tail', '25', '--timestamps', 'web'],
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
  assert.deepEqual(children[0].signals, ['SIGKILL'], 'Cancellation should kill the child once');
  assert.equal(
    events.length,
    4,
    'Cancelled logs should suppress subsequent output and duplicate terminal events',
  );
  assert.deepEqual(
    events.at(-1),
    { sessionId: 'logs', type: 'exit', code: null, signal: null, cancelled: true },
    'Cancellation should report a terminal cancelled event',
  );
});

test('ps returns structured container rows and restricts the compose project', () => {
  const { engine, events, calls, children } = fixture();
  engine.start({ operation: 'ps', sessionId: 'ps', projects: ['demo'] });
  assert.deepEqual(
    calls[0].args,
    [
      'ps',
      '--all',
      '--no-trunc',
      '--format',
      '{{json .}}',
      '--filter',
      'label=com.docker.compose.project=demo',
    ],
    'PS should include stopped containers and apply the project label filter',
  );
  children[0].stdout.write('{"ID":"abc","State":"running"}\n{"ID":');
  children[0].stdout.write('"def","State":"exited"}\n');
  assert.equal(events.length, 0, 'Query output should remain buffered until Docker exits');
  children[0].emit('close', 0, null);
  assert.deepEqual(
    events[0],
    {
      sessionId: 'ps',
      type: 'result',
      result: [
        { ID: 'abc', State: 'running' },
        { ID: 'def', State: 'exited' },
      ],
    },
    'PS should parse JSON rows across arbitrary stream chunk boundaries',
  );
});

test('inspect returns structured Docker objects and forwards Docker errors', () => {
  const { engine, events, calls, children } = fixture();
  engine.start({ operation: 'inspect', sessionId: 'inspect', container: 'abc' });
  assert.deepEqual(
    calls[0].args,
    ['inspect', '--type', 'container', 'abc'],
    'Inspect should only inspect containers',
  );
  children[0].stdout.write('[{"Id":"abc","State":{"Running":true}}]');
  children[0].emit('close', 0, null);
  assert.deepEqual(
    events[0],
    { sessionId: 'inspect', type: 'result', result: [{ Id: 'abc', State: { Running: true } }] },
    'Inspect should retain the structured state object',
  );
  engine.start({ operation: 'inspect', sessionId: 'failure', container: 'missing' });
  children[1].stderr.write('No such container');
  children[1].emit('close', 1, null);
  const end = events.at(-1);
  assert.ok(
    end?.type === 'exit' && end.error === 'No such container',
    'Docker stderr should explain unsuccessful queries',
  );
});

test('malformed requests never spawn Docker', () => {
  const { engine, calls } = fixture();
  for (const request of [
    null,
    {},
    { ...execRequest(), sessionId: '../bad' },
    { ...execRequest(), container: '--privileged' },
    { ...execRequest(), command: [] },
    { ...execRequest(), command: ['a\0b'] },
    { ...execRequest(), command: [4] },
    { ...execRequest(), tty: 'true' },
    { ...execRequest(), rows: 1001 },
    { operation: 'logs', sessionId: 'x', container: 'a', tail: -1 },
    { operation: 'logs', sessionId: 'x', container: 'a', timestamps: 'true' },
    { operation: 'ps', sessionId: 'x', projects: ['--bad'] },
    { operation: 'unknown', sessionId: 'x' },
  ]) {
    assert.throws(
      () => engine.start(request),
      /Invalid/,
      'Malformed requests should fail before process creation',
    );
  }
  assert.equal(calls.length, 0, 'Invalid requests should never reach Docker');
});

test('duplicate sessions and concurrent session limits reject before spawn', () => {
  const { engine, calls, children, events } = fixture({ maxSessions: 1 });
  engine.start(execRequest());
  assert.throws(
    () => engine.start(execRequest()),
    /Duplicate/,
    'Active session IDs should be unique',
  );
  assert.throws(
    () => engine.start({ ...execRequest(), sessionId: 'other' }),
    /limit/,
    'Concurrent process count should be bounded',
  );
  assert.equal(calls.length, 1, 'Rejected sessions should not create extra processes');
  engine.cancel('exec-1');
  engine.start(execRequest());
  assert.equal(calls.length, 2, 'Finished session IDs should become available again');
  children[0].emit('error', new Error('late error from previous process'));
  children[0].emit('close', 1, null);
  assert.equal(
    engine.activeSessions,
    1,
    'Late events from a cancelled process should not terminate a reused session ID',
  );
  assert.equal(
    events.length,
    1,
    'Late events from an earlier session should not emit terminal events for its replacement',
  );
  engine.dispose();
});

test('stdin and resize reject unknown, oversized, closed, or inapplicable sessions', () => {
  const { engine, children } = fixture();
  assert.throws(
    () => engine.stdin('unknown', Buffer.from('a')),
    /Unknown/,
    'Input should require an active exec',
  );
  engine.start(execRequest());
  assert.throws(
    () => engine.stdin('exec-1', Buffer.alloc(65537)),
    /Invalid stdin/,
    'Input frames over 64 KiB should be rejected',
  );
  assert.throws(
    () => engine.resize('exec-1', 80, 24),
    /no terminal/,
    'Non-TTY exec should reject terminal resize',
  );
  children[0].stdin.end();
  assert.throws(
    () => engine.stdin('exec-1', Buffer.from('a')),
    /closed/,
    'Closed input should reject writes synchronously',
  );
  engine.start({ operation: 'logs', sessionId: 'logs', container: 'web' });
  assert.throws(() => engine.endStdin('logs'), /Unknown/, 'Logs should not expose exec stdin');
  engine.dispose();
});

test('query result size limits terminate the process without partial results', () => {
  const { engine, children, events } = fixture({ maxResultBytes: 10 });
  engine.start({ operation: 'ps', sessionId: 'ps', projects: ['demo'] });
  children[0].stderr.write('123456');
  children[0].stdout.write('123456');
  assert.equal(
    engine.activeSessions,
    0,
    'Combined stdout and stderr query bytes should respect the result limit',
  );
  assert.deepEqual(children[0].signals, ['SIGKILL'], 'Oversized result should terminate Docker');
  assert.ok(
    events[0].type === 'exit' && events[0].error?.includes('size limit'),
    'Oversized query should emit an actionable failure',
  );
});

test('invalid structured Docker output fails safely', () => {
  for (const output of ['not JSON', '[null]', '{}', '[1]']) {
    const { engine, children, events } = fixture();
    engine.start({ operation: 'inspect', sessionId: 'inspect', container: 'web' });
    children[0].stdout.write(output);
    children[0].emit('close', 0, null);
    assert.ok(
      events.length === 1 &&
        events[0].type === 'exit' &&
        events[0].error?.startsWith('Invalid Docker result'),
      'Malformed inspect JSON should emit only an error exit',
    );
  }
});

test('spawn errors release session and emit one terminal event', () => {
  const { engine, children, events } = fixture();
  engine.start(execRequest());
  children[0].emit('error', new Error('Docker unavailable'));
  children[0].emit('close', -1, null);
  assert.ok(
    events.length === 1 && events[0].type === 'exit' && events[0].error === 'Docker unavailable',
    'Process errors should emit one explanatory terminal event',
  );
  assert.equal(engine.activeSessions, 0, 'Process errors should release active sessions');
  const fail = fixture({
    spawn: () => {
      throw new Error('spawn failed');
    },
  });
  assert.throws(
    () => fail.engine.start(execRequest()),
    /spawn failed/,
    'Synchronous spawn failure should propagate',
  );
  assert.equal(
    fail.engine.activeSessions,
    0,
    'Synchronous spawn failure should not reserve a session',
  );
});

test('query and stream timeouts terminate and clean up', async () => {
  const { engine, children, events } = fixture({ queryTimeoutMs: 5, maxSessionMs: 5 });
  engine.start({ operation: 'ps', sessionId: 'ps', projects: ['demo'] });
  engine.start(execRequest());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(engine.activeSessions, 0, 'All operation types should have a maximum lifetime');
  assert.equal(events.length, 2, 'Each timed-out session should emit a terminal event');
  for (const child of children)
    assert.deepEqual(child.signals, ['SIGKILL'], 'Timeout should kill every timed-out process');
});

test('dispose cancels all operations and validates engine bounds', () => {
  const { engine, children, events } = fixture();
  engine.start(execRequest());
  engine.start({ operation: 'logs', sessionId: 'logs', container: 'web' });
  engine.dispose();
  assert.equal(engine.activeSessions, 0, 'Disposal should release all active sessions');
  assert.equal(
    events.filter((event) => event.type === 'exit' && event.cancelled).length,
    2,
    'Disposal should notify each session of cancellation',
  );
  for (const child of children) {
    assert.equal(child.stdout.listenerCount('data'), 0, 'Disposal should remove output listeners');
    child.emit('error', new Error('late spawn error'));
    child.stdin.emit('error', new Error('late input error'));
    child.emit('close', null, 'SIGKILL');
    assert.equal(
      child.stdin.listenerCount('error'),
      0,
      'Process close after disposal should remove input error listeners',
    );
    assert.equal(
      child.listenerCount('error'),
      0,
      'Process close after disposal should remove process error listeners',
    );
  }
  for (const key of ['maxSessions', 'maxResultBytes', 'maxSessionMs', 'queryTimeoutMs'])
    assert.throws(
      () => fixture({ [key]: 0 }),
      /Invalid/,
      'Engine resource limits should require positive integers',
    );
});

test('noninteractive exec omits Docker stdin attachment and sends EOF', () => {
  const { engine, calls, children } = fixture();
  engine.start({ ...execRequest(), interactive: false });
  assert.equal(
    calls[0].args.includes('-i'),
    false,
    'Noninteractive exec should not attach Docker stdin',
  );
  assert.equal(
    children[0].stdin.writableEnded,
    true,
    'Noninteractive exec should close the child stdin immediately',
  );
  engine.dispose();
});

test('stdin buffering remains bounded even if a transport ignores backpressure', () => {
  const { engine } = fixture();
  engine.start(execRequest());
  for (let i = 0; i < 4; i++) engine.stdin('exec-1', Buffer.alloc(65536));
  assert.throws(
    () => engine.stdin('exec-1', Buffer.alloc(65536)),
    /queue exceeds/,
    'Exec input should reject unbounded writable buffering',
  );
  engine.dispose();
});

test('ps aggregates only exact project-label queries into one bounded session', () => {
  const { engine, children, calls, events } = fixture();
  engine.start({
    operation: 'ps',
    sessionId: 'ps',
    projects: ['demo', 'demo-web-active', 'demo-web-active'],
  });
  assert.equal(engine.activeSessions, 1, 'Multiple project queries should occupy one live session');
  assert.equal(children.length, 1, 'Project queries should run sequentially');
  children[0].stdout.write('{"ID":"base","State":"running"}');
  children[0].emit('close', 0, null);
  assert.equal(
    children.length,
    2,
    'The active revision query should start after the base project query exits',
  );
  assert.equal(
    events.length,
    0,
    'Partial project query results should stay buffered until aggregation completes',
  );
  children[1].stdout.write('{"ID":"active","State":"running"}\n');
  children[1].emit('close', 0, null);
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    ['label=com.docker.compose.project=demo', 'label=com.docker.compose.project=demo-web-active'],
    'Each unique project should receive exactly one precise label filter',
  );
  assert.deepEqual(
    events[0],
    {
      sessionId: 'ps',
      type: 'result',
      result: [
        { ID: 'base', State: 'running' },
        { ID: 'active', State: 'running' },
      ],
    },
    'PS should combine base and active revision rows into one result',
  );
  assert.equal(
    events.length,
    2,
    'Aggregated PS should emit exactly one result and one terminal event',
  );
  assert.ok(
    events[1].type === 'exit' && events[1].code === 0,
    'Aggregated PS should emit one successful terminal event',
  );
  assert.equal(engine.activeSessions, 0, 'Completed aggregation should release its session');
});

test('cancelling aggregated ps kills the current child and never starts remaining projects', () => {
  const { engine, children, events } = fixture();
  engine.start({ operation: 'ps', sessionId: 'ps', projects: ['demo', 'demo-web-active'] });
  engine.cancel('ps');
  children[0].emit('close', null, 'SIGKILL');
  assert.deepEqual(
    children[0].signals,
    ['SIGKILL'],
    'Aggregated PS cancellation should terminate its current Docker child',
  );
  assert.equal(children.length, 1, 'Cancellation should suppress remaining project queries');
  assert.ok(
    events.length === 1 && events[0].type === 'exit' && events[0].cancelled,
    'Aggregated cancellation should emit a single terminal event',
  );
});

test('failed aggregated ps suppresses partial rows and remaining project queries', () => {
  const { engine, children, events } = fixture();
  engine.start({
    operation: 'ps',
    sessionId: 'ps',
    projects: ['demo', 'demo-web-active', 'demo-api-active'],
  });
  children[0].stdout.write('{"ID":"base"}\n');
  children[0].emit('close', 0, null);
  children[1].stderr.write('Docker unavailable');
  children[1].emit('close', 1, null);
  assert.equal(children.length, 2, 'Failed aggregation should not query remaining projects');
  assert.ok(
    events.length === 1 && events[0].type === 'exit' && events[0].error === 'Docker unavailable',
    'Failed aggregation should emit only the explanatory terminal error',
  );
});

test('ps project scopes reject empty or malformed arrays before spawning', () => {
  const { engine, calls } = fixture();
  for (const projects of [
    undefined,
    [],
    ['demo', '--foreign'],
    ['demo', 1],
    Array(257).fill('demo'),
  ])
    assert.throws(
      () => engine.start({ operation: 'ps', sessionId: 'ps', projects }),
      /Invalid projects/,
      'Every PS request should require a bounded explicit list of valid projects',
    );
  assert.equal(calls.length, 0, 'Invalid project scopes should never create Docker processes');
});

test('structured ps and inspect reject oversized serialized frames before emitting results', () => {
  for (const operation of ['ps', 'inspect'] as const) {
    const sessionId = 'x'.repeat(255);
    const overhead = Buffer.byteLength(
      JSON.stringify({ v: 1, type: 'live.result', sessionId, result: [{ value: '' }] }),
    );
    const result = [{ value: 'x'.repeat(LIVE_MAX_FRAME_BYTES - overhead + 1) }];
    const { engine, children, events } = fixture();
    engine.start(
      operation === 'ps'
        ? { operation, sessionId, projects: ['demo'] }
        : { operation, sessionId, container: 'web' },
    );
    children[0].stdout.write(
      operation === 'ps' ? JSON.stringify(result[0]) + '\n' : JSON.stringify(result),
    );
    children[0].emit('close', 0, null);
    assert.equal(
      events.filter((event) => event.type === 'result').length,
      0,
      'A result exceeding the shared frame limit after envelope serialization should never be emitted',
    );
    assert.ok(
      events.length === 1 &&
        events[0].type === 'exit' &&
        events[0].error?.includes('serialized frame size limit'),
      'Oversized structured results should produce one actionable terminal error',
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(events[0])) < LIVE_MAX_FRAME_BYTES,
      'Size-limit errors should remain safe to send on the shared agent socket',
    );
  }
});

test('structured results exactly at the serialized frame limit remain deliverable', () => {
  const sessionId = 'inspect';
  const overhead = Buffer.byteLength(
    JSON.stringify({ v: 1, type: 'live.result', sessionId, result: [{ value: '' }] }),
  );
  const result = [{ value: 'x'.repeat(LIVE_MAX_FRAME_BYTES - overhead) }];
  const { engine, children, events } = fixture();
  engine.start({ operation: 'inspect', sessionId, container: 'web' });
  children[0].stdout.write(JSON.stringify(result));
  children[0].emit('close', 0, null);
  assert.ok(
    events[0].type === 'result',
    'Structured results at the exact serialized byte boundary should be allowed',
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify({ v: 1, type: 'live.result', sessionId, result })),
    LIVE_MAX_FRAME_BYTES,
    'Boundary fixture should include the complete live.result envelope',
  );
});
