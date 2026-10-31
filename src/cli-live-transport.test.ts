import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createCliLiveTransport } from './cli-live-transport.ts';
import { parseLiveRequest, runCliLive } from './cli-live.ts';

const execFileAsync = promisify(execFile);
async function serverFixture() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, url, close };
}
const request = parseLiveRequest('exec', {
  project: 'site',
  service: 'web',
  command: ['sh', '-c', 'printf x'],
});
const frame = (socket: WebSocket, value: object) =>
  socket.send(JSON.stringify({ v: 1, sessionId: 's', ...value }));

test('WebSocket transport authenticates the upgrade and frames exact request and binary input', async () => {
  const f = await serverFixture();
  const received: Record<string, unknown>[] = [];
  let authorization: string | undefined;
  let route: string | undefined;
  f.server.on('connection', (socket, upgrade) => {
    authorization = upgrade.headers.authorization;
    route = upgrade.url;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.type === 'live.open') {
        frame(socket, { type: 'live.started', sessionId: 's', node: 'n' });
        frame(socket, {
          type: 'live.output',
          stream: 'stdout',
          data: Buffer.from([0, 255]).toString('base64'),
        });
      }
      if (message.type === 'live.stdin-end') frame(socket, { type: 'live.exit', code: 9 });
    });
  });
  try {
    const session = await createCliLiveTransport(f.url, 'secret-token').open(
      request,
      new AbortController().signal,
    );
    await session.send({ type: 'stdin', data: Buffer.from([1, 255]) });
    await session.send({ type: 'resize', columns: 100, rows: 30 });
    await session.send({ type: 'stdin-end' });
    const events = [];
    for await (const event of session.events) events.push(event);
    await session.close();
    assert.equal(
      authorization,
      'Bearer secret-token',
      'operator credentials must be sent as an upgrade authorization header',
    );
    assert.equal(
      route,
      '/api/v1/live',
      'operator credentials must never appear in the WebSocket URL',
    );
    assert.deepEqual(
      received[0],
      { v: 1, type: 'live.open', request },
      'the first frame must open the exact validated operation',
    );
    assert.deepEqual(
      received[1],
      { v: 1, type: 'live.stdin', data: 'Af8=' },
      'binary stdin must use lossless base64 framing',
    );
    assert.deepEqual(
      received[2],
      { v: 1, type: 'live.resize', columns: 100, rows: 30 },
      'terminal resize dimensions must be forwarded',
    );
    assert.deepEqual(
      events,
      [
        { type: 'stdout', data: Buffer.from([0, 255]) },
        { type: 'exit', code: 9 },
      ],
      'output decoding and nonzero remote exit codes must be lossless',
    );
  } finally {
    await f.close();
  }
});

test('transport rejects malformed, binary, unknown and oversized remote frames', async () => {
  for (const invalid of [
    '{',
    JSON.stringify({ v: 2, type: 'live.exit', code: 0 }),
    JSON.stringify({ v: 1, type: 'other' }),
    JSON.stringify({ v: 1, type: 'live.output', stream: 'stdout', data: '!!!!' }),
    JSON.stringify({ v: 1, type: 'live.exit', code: -1 }),
    Buffer.from('binary'),
    'x'.repeat(256 * 1024 + 1),
  ]) {
    const f = await serverFixture();
    f.server.on('connection', (socket) => {
      socket.once('message', () => socket.send(invalid));
    });
    try {
      await assert.rejects(
        createCliLiveTransport(f.url).open(request, new AbortController().signal),
        'invalid frames before startup must reject the session before input can be forwarded',
      );
    } finally {
      await f.close();
    }
  }
});

test('transport waits for live.started before exposing a session', async () => {
  const f = await serverFixture();
  let remote!: WebSocket;
  const openedFrame = new Promise<void>((resolve) =>
    f.server.on('connection', (socket) => {
      remote = socket;
      socket.once('message', () => resolve());
    }),
  );
  try {
    let resolved = false;
    const opening = createCliLiveTransport(f.url)
      .open(request, new AbortController().signal)
      .then((session) => {
        resolved = true;
        return session;
      });
    await openedFrame;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      resolved,
      false,
      'the client must not forward interactive input while control is still resolving the target',
    );
    frame(remote, { type: 'live.started', node: 'n' });
    const session = await opening;
    assert.equal(resolved, true, 'a validated live.started frame must make the session usable');
    await session.close();
  } finally {
    await f.close();
  }
});

test('event queue bounds a remote sender while the consumer is paused', async () => {
  const f = await serverFixture();
  const disconnected = new Promise<void>((resolve) =>
    f.server.on('connection', (socket) => {
      socket.once('close', () => resolve());
      socket.once('message', () => {
        frame(socket, { type: 'live.started', node: 'n' });
        for (let index = 0; index < 1100; index++)
          frame(socket, { type: 'live.result', value: index });
      });
    }),
  );
  try {
    const session = await createCliLiveTransport(f.url).open(request, new AbortController().signal);
    await disconnected;
    const event = await session.events[Symbol.asyncIterator]().next();
    assert.equal(
      event.value?.type,
      'error',
      'overflow must replace the backlog with an explicit receive buffer error',
    );
    assert.ok(
      event.value?.type === 'error' && /buffer limit/.test(event.value.message),
      'overflow errors must explain which bounded buffer failed',
    );
    await session.close();
  } finally {
    await f.close();
  }
});

test('disconnects and aborted connections terminate without leaking sockets', async () => {
  const f = await serverFixture();
  f.server.on('connection', (socket) => {
    socket.once('message', () => {
      frame(socket, { type: 'live.started', node: 'n' });
      setImmediate(() => socket.close());
    });
  });
  try {
    const session = await createCliLiveTransport(f.url).open(request, new AbortController().signal);
    const event = await session.events[Symbol.asyncIterator]().next();
    assert.equal(
      event.value?.type,
      'disconnect',
      'remote closure before exit must produce a disconnect event',
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      createCliLiveTransport(f.url).open(request, abort.signal),
      /cancelled/,
      'pre-aborted connections must fail without opening a socket',
    );
  } finally {
    await f.close();
  }
});

test('CLI commands route through resolved configuration and preserve exec argv including newlines', async () => {
  const f = await serverFixture();
  const requests: any[] = [];
  f.server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'live.open') return;
      requests.push(message.request);
      frame(socket, { type: 'live.started', node: 'n' });
      if (['ps', 'inspect'].includes(message.request.operation))
        frame(socket, { type: 'live.result', value: { containers: ['one'] } });
      else
        frame(socket, {
          type: 'live.output',
          stream: 'stdout',
          data: Buffer.from('stream\n').toString('base64'),
        });
      frame(socket, { type: 'live.exit', code: message.request.operation === 'exec' ? 17 : 0 });
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TUG_CONTROL_URL: f.url,
    TUG_TOKEN: 'token',
    TUG_PROJECT: 'from-env',
  };
  delete env.TUG_CONFIG;
  const cli = (...args: string[]) =>
    execFileAsync(process.execPath, [path.resolve('src/cli.ts'), ...args], { env, cwd: '/tmp' });
  try {
    const ps = await cli('ps', '--node', 'node-a', '--project', 'selected');
    assert.deepEqual(
      JSON.parse(ps.stdout),
      { containers: ['one'] },
      'ps must print a structured JSON document',
    );
    await cli('inspect', 'web', '--node', 'node-a');
    const logs = await cli('logs', 'web', '--follow', '--tail', '0');
    assert.equal(logs.stdout, 'stream\n', 'followed logs must print decoded remote output');
    await assert.rejects(
      cli('exec', 'web', '--node', 'node-a', '--', 'sh', '-c', 'printf "a\nb"', '--remote-flag'),
      (error: any) => {
        assert.equal(error.code, 17, 'exec must exit with the remote process exit status');
        assert.equal(
          error.stdout,
          'stream\n',
          'exec must stream output before returning a nonzero status',
        );
        return true;
      },
      'nonzero remote exec must fail the CLI with the remote code',
    );
    assert.deepEqual(
      requests[0],
      { operation: 'ps', project: 'selected', node: 'node-a' },
      'explicit project and node must reach the live session',
    );
    assert.equal(
      requests[1].project,
      'from-env',
      'live operations must use the same environment project resolution as other commands',
    );
    assert.deepEqual(
      requests[3].command,
      ['sh', '-c', 'printf "a\nb"', '--remote-flag'],
      'exec argv after -- must preserve newlines and remote flags verbatim',
    );
    await assert.rejects(
      cli('inspect', 'web\n'),
      /line breaks/,
      'non-exec arguments must retain single-line validation',
    );
  } finally {
    await f.close();
  }
});

test('transport maps remote adapter errors into CLI failures', async () => {
  const f = await serverFixture();
  f.server.on('connection', (socket) => {
    socket.once('message', () =>
      frame(socket, { type: 'live.error', message: 'TTY adapter is unavailable' }),
    );
  });
  try {
    await assert.rejects(
      runCliLive(request, createCliLiveTransport(f.url)),
      /TTY adapter is unavailable/,
      'agent capability errors must surface without claiming remote TTY success',
    );
  } finally {
    await f.close();
  }
});

test('large stdin is split into bounded frames and cancel remains an explicit wire message', async () => {
  const f = await serverFixture();
  const chunks: Buffer[] = [];
  const cancelled = new Promise<void>((resolve) =>
    f.server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'live.open') frame(socket, { type: 'live.started', node: 'n' });
        if (message.type === 'live.stdin') {
          assert.ok(
            Buffer.byteLength(data.toString()) < 256 * 1024,
            'each stdin wire frame must stay below the protocol frame limit',
          );
          chunks.push(Buffer.from(message.data, 'base64'));
        }
        if (message.type === 'live.cancel') resolve();
      }),
    ),
  );
  try {
    const session = await createCliLiveTransport(f.url).open(request, new AbortController().signal);
    const input = Buffer.alloc(180 * 1024, 255);
    await session.send({ type: 'stdin', data: input });
    await session.send({ type: 'cancel' });
    await cancelled;
    assert.ok(chunks.length > 1, 'large stdin chunks must be split before transmission');
    assert.deepEqual(
      Buffer.concat(chunks),
      input,
      'splitting stdin must preserve every input byte',
    );
    await session.close();
  } finally {
    await f.close();
  }
});
