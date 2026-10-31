import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CliLiveError, formatLiveResult, parseLiveRequest, runCliLive } from './cli-live.ts';
import type {
  CliLiveSession,
  CliLiveStdin,
  CliLiveStdout,
  LiveClientMessage,
  LiveEvent,
  LiveRequest,
} from './cli-live.ts';

function fixture(events: LiveEvent[] = []) {
  const stdin = new PassThrough() as PassThrough & CliLiveStdin;
  const stdout = new PassThrough() as CliLiveStdout;
  const stderr = new PassThrough();
  const signals = new EventEmitter();
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  stdout.on('data', (data) => output.push(Buffer.from(data)));
  stderr.on('data', (data) => errors.push(Buffer.from(data)));
  const sent: LiveClientMessage[] = [];
  const raw: boolean[] = [];
  stdin.isTTY = true;
  stdin.setRawMode = (value) => {
    raw.push(value);
    stdin.isRaw = value;
  };
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 24;
  let closed = 0;
  let opened: LiveRequest | undefined;
  let onOpen: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    onOpen = resolve;
  });
  const session: CliLiveSession = {
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    send(message) {
      sent.push(message);
    },
    close() {
      closed++;
    },
  };
  const transport = {
    async open(request: LiveRequest) {
      opened = request;
      onOpen?.();
      return session;
    },
  };
  return {
    stdin,
    stdout,
    stderr,
    signals,
    output,
    errors,
    sent,
    raw,
    ready,
    session,
    transport,
    io: { stdin, stdout, stderr, signals },
    closed: () => closed,
    opened: () => opened,
  };
}
const exec = (options: { tty?: boolean; interactive?: boolean } = {}) =>
  parseLiveRequest('exec', {
    project: 'site',
    service: 'web',
    command: ['printf', '%s', 'a b'],
    ...options,
  });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('live request parsing preserves argv and supplies explicit operation defaults', () => {
  assert.deepEqual(
    exec(),
    {
      operation: 'exec',
      project: 'site',
      service: 'web',
      command: ['printf', '%s', 'a b'],
      interactive: false,
      tty: false,
    },
    'exec must preserve argument boundaries and disable interactive input by default',
  );
  assert.deepEqual(
    parseLiveRequest('exec', { project: 'site', service: 'web' }).operation,
    'exec',
    'exec must accept a default shell',
  );
  const shell = parseLiveRequest('exec', { project: 'site', service: 'web' });
  assert.ok(
    shell.operation === 'exec' && shell.command[0] === 'sh',
    'missing exec argv must select sh',
  );
  assert.deepEqual(
    parseLiveRequest('logs', { project: 'site', service: 'web', tail: '0', node: 'node-1' }),
    { operation: 'logs', project: 'site', service: 'web', tail: 0, follow: true, node: 'node-1' },
    'followed logs must preserve zero tail and node selection',
  );
  assert.deepEqual(
    parseLiveRequest('ps', { project: 'site' }),
    { operation: 'ps', project: 'site' },
    'ps must not require a service',
  );
  assert.deepEqual(
    parseLiveRequest('inspect', { project: 'site', service: 'web' }),
    { operation: 'inspect', project: 'site', service: 'web' },
    'inspect must require and preserve its service',
  );
});

test('live request parsing rejects malformed names, tail values and argv', () => {
  for (const project of ['', '../site', '-site', 'site\n'])
    assert.throws(
      () => parseLiveRequest('ps', { project }),
      /project/,
      'unsafe project names must fail before connecting',
    );
  assert.throws(
    () => parseLiveRequest('inspect', { project: 'site' }),
    /service/,
    'inspect must require a service',
  );
  assert.throws(
    () => parseLiveRequest('ps', { project: 'site', node: '../node' }),
    /node/,
    'unsafe node names must fail before connecting',
  );
  for (const tail of ['-1', '1.5', '1e3', 'Infinity', '9007199254740992', ''])
    assert.throws(
      () => parseLiveRequest('logs', { project: 'site', service: 'web', tail }),
      /tail/,
      'tail must be a nonnegative safe integer',
    );
  for (const command of [[''], ['sh\0'], ['sh', 'a\0b']])
    assert.throws(
      () => parseLiveRequest('exec', { project: 'site', service: 'web', command }),
      /command/,
      'exec argv must reject empty executables and NUL bytes',
    );
});

test('exec preserves binary channels and returns the remote process exit code', async () => {
  const f = fixture([
    { type: 'stdout', data: Buffer.from([0, 255, 1]) },
    { type: 'stderr', data: Buffer.from('failure') },
    { type: 'exit', code: 42 },
  ]);
  assert.equal(
    await runCliLive(exec(), f.transport, f.io),
    42,
    'exec must return a nonzero remote exit code without rewriting it',
  );
  assert.deepEqual(
    Buffer.concat(f.output),
    Buffer.from([0, 255, 1]),
    'stdout bytes must pass through without text decoding',
  );
  assert.equal(
    Buffer.concat(f.errors).toString(),
    'failure',
    'stderr must remain separate from stdout',
  );
  assert.deepEqual(
    f.sent,
    [],
    'noninteractive exec must not send input frames that control rejects',
  );
  assert.equal(f.closed(), 1, 'successful execution must close its transport');
  assert.equal(f.signals.listenerCount('SIGINT'), 0, 'execution must remove its SIGINT listener');
});

test('structured operations emit one pretty JSON document only after successful exit', async () => {
  for (const operation of ['ps', 'inspect'] as const) {
    const value = { containers: [{ id: 'one', state: 'running' }] };
    const f = fixture([
      { type: 'result', value },
      { type: 'exit', code: 0 },
    ]);
    const request = parseLiveRequest(operation, { project: 'site', service: 'web' });
    assert.equal(
      await runCliLive(request, f.transport, f.io),
      0,
      'structured operations must return a successful exit status',
    );
    assert.equal(
      Buffer.concat(f.output).toString(),
      `${JSON.stringify(value, null, 2)}\n`,
      'ps and inspect must use the existing JSON-default output convention',
    );
  }
  assert.throws(
    () => formatLiveResult(undefined),
    /no JSON result/,
    'undefined must not silently produce invalid JSON output',
  );
});

test('remote errors, missing results and disconnects fail and always close sessions', async () => {
  for (const events of [
    [{ type: 'error', message: 'node unavailable' }],
    [{ type: 'disconnect' }],
    [],
    [{ type: 'exit', code: 999 }],
  ] as LiveEvent[][]) {
    const f = fixture(events);
    await assert.rejects(
      runCliLive(exec(), f.transport, f.io),
      CliLiveError,
      'remote failures and premature closure must produce a CLI error',
    );
    assert.equal(f.closed(), 1, 'remote failures must close the session exactly once');
  }
  const f = fixture([{ type: 'exit', code: 0 }]);
  await assert.rejects(
    runCliLive(parseLiveRequest('ps', { project: 'site' }), f.transport, f.io),
    /without a JSON result/,
    'ps success without structured data must fail explicitly',
  );
});

test('interactive TTY exec forwards input, EOF and resize and restores terminal state', async () => {
  const f = fixture();
  let finish!: () => void;
  f.session.events = (async function* () {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    yield { type: 'exit', code: 0 } as LiveEvent;
  })();
  const running = runCliLive(exec({ interactive: true, tty: true }), f.transport, f.io);
  await tick();
  f.stdin.write(Buffer.from('hello'));
  f.stdout.columns = 120;
  f.stdout.rows = 40;
  f.stdout.emit('resize');
  f.stdin.end();
  await tick();
  finish();
  assert.equal(await running, 0, 'interactive exec must finish with the remote exit status');
  assert.deepEqual(f.raw, [true, false], 'raw mode must be enabled then restored on exit');
  assert.ok(
    f.sent.some(
      (message) => message.type === 'stdin' && Buffer.from(message.data).toString() === 'hello',
    ),
    'stdin bytes must reach the remote process',
  );
  assert.ok(
    f.sent.some((message) => message.type === 'stdin-end'),
    'stdin EOF must reach the remote process',
  );
  assert.ok(
    f.sent.some(
      (message) => message.type === 'resize' && message.columns === 120 && message.rows === 40,
    ),
    'terminal resizes must reach the remote process',
  );
  const opened = f.opened();
  assert.ok(
    opened?.operation === 'exec' && opened.columns === 80 && opened.rows === 24,
    'initial terminal dimensions must be included when opening TTY exec',
  );
  assert.equal(
    f.stdin.listenerCount('data'),
    0,
    'interactive completion must remove stdin listeners',
  );
  assert.equal(
    f.stdout.listenerCount('resize'),
    0,
    'interactive completion must remove resize listeners',
  );
  assert.ok(
    f.stdin.readableEnded || f.stdin.isPaused(),
    'stdin must be ended or restored to its original nonflowing state',
  );
});

test('SIGINT cancels a quiet session and restores an existing raw terminal', async () => {
  const f = fixture();
  f.stdin.isRaw = true;
  f.session.events = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<LiveEvent>>(() => {}),
    }),
  };
  const running = runCliLive(exec({ interactive: true, tty: true }), f.transport, f.io);
  await tick();
  f.signals.emit('SIGINT');
  assert.equal(
    await running,
    130,
    'SIGINT must promptly return the conventional interrupted exit code',
  );
  assert.deepEqual(f.raw, [], 'a terminal that was already raw must retain its original state');
  assert.ok(
    f.sent.some((message) => message.type === 'cancel'),
    'SIGINT must request remote cancellation',
  );
  assert.equal(f.closed(), 1, 'SIGINT must close the transport even when no events arrive');
});

test('abort during connection establishment closes a late session', async () => {
  const f = fixture();
  const abort = new AbortController();
  let connected!: (session: CliLiveSession) => void;
  const running = runCliLive(
    exec(),
    {
      open: () =>
        new Promise((resolve) => {
          connected = resolve;
        }),
    },
    { ...f.io, signal: abort.signal },
  );
  abort.abort();
  assert.equal(await running, 130, 'cancelling connection establishment must return promptly');
  connected(f.session);
  await tick();
  assert.equal(f.closed(), 1, 'a connection completing after cancellation must be closed');
});

test('TTY validation, transport send failures and stdin overflow clean up', async () => {
  const noTty = fixture();
  noTty.stdin.isTTY = false;
  await assert.rejects(
    runCliLive(exec({ tty: true }), noTty.transport, noTty.io),
    /requires a local terminal/,
    'TTY exec must reject piped input explicitly',
  );
  assert.equal(
    noTty.opened(),
    undefined,
    'invalid terminal setup must fail before starting a remote operation',
  );
  for (const overflow of [false, true]) {
    const f = fixture();
    f.session.events = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<LiveEvent>>(() => {}),
      }),
    };
    if (!overflow)
      f.session.send = async () => {
        throw new Error('send failed');
      };
    const running = runCliLive(exec({ interactive: true }), f.transport, f.io);
    await tick();
    f.stdin.write(Buffer.alloc(overflow ? 1024 * 1024 + 1 : 1));
    await assert.rejects(
      running,
      overflow ? /buffer limit/ : /send failed/,
      'input failures must stop the operation instead of leaking or buffering indefinitely',
    );
    assert.equal(f.closed(), 1, 'input failures must close the session');
  }
});

test('followed logs forward channels and support cancellation without stdin listeners', async () => {
  const f = fixture([
    { type: 'stdout', data: Buffer.from('log\n') },
    { type: 'exit', code: 0 },
  ]);
  assert.equal(
    await runCliLive(
      parseLiveRequest('logs', { project: 'site', service: 'web' }),
      f.transport,
      f.io,
    ),
    0,
    'a completed log stream must return its exit status',
  );
  assert.equal(
    Buffer.concat(f.output).toString(),
    'log\n',
    'followed logs must preserve log bytes',
  );
  assert.deepEqual(f.sent, [], 'followed logs must not send stdin messages');
  assert.equal(f.stdin.listenerCount('data'), 0, 'followed logs must leave local stdin untouched');
});

test('connection failures and pre-aborted calls remove all local handlers', async () => {
  const f = fixture();
  await assert.rejects(
    runCliLive(
      exec(),
      {
        async open() {
          throw new Error('connection refused');
        },
      },
      f.io,
    ),
    /connection refused/,
    'connection rejection must propagate to the CLI',
  );
  assert.equal(
    f.signals.listenerCount('SIGINT'),
    0,
    'connection rejection must remove its signal listener',
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await runCliLive(exec(), f.transport, { ...f.io, signal: controller.signal }),
    130,
    'pre-aborted requests must return the interrupted exit status',
  );
  assert.equal(f.opened(), undefined, 'pre-aborted requests must not open a remote operation');
});

test('local stream errors stop quiet sessions and restore terminal mode', async () => {
  const f = fixture();
  f.session.events = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<LiveEvent>>(() => {}),
    }),
  };
  const running = runCliLive(exec({ tty: true, interactive: true }), f.transport, f.io);
  await tick();
  f.stdin.emit('error', new Error('input failed'));
  await assert.rejects(
    running,
    /input failed/,
    'local input errors must reject the live operation',
  );
  assert.deepEqual(f.raw, [true, false], 'input failure must restore terminal raw mode');
  assert.equal(f.closed(), 1, 'input failure must close the remote session');
  assert.ok(
    f.sent.some((message) => message.type === 'cancel'),
    'input failure must request remote cancellation',
  );
});

test('failed structured operations emit no partial JSON document', async () => {
  const f = fixture([
    { type: 'result', value: { partial: true } },
    { type: 'exit', code: 7 },
  ]);
  assert.equal(
    await runCliLive(
      parseLiveRequest('inspect', { project: 'site', service: 'web' }),
      f.transport,
      f.io,
    ),
    7,
    'structured operation failures must preserve the remote exit code',
  );
  assert.equal(
    Buffer.concat(f.output).length,
    0,
    'failed structured operations must not emit a success document',
  );
});
