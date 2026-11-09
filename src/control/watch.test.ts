import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AgentWakeChannel } from '../agent/agent.ts';
import type { AgentContext } from '../agent/agent.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { LiveHub, attachAgentStream, createApp } from './control.ts';
import { WatchHub } from './watch.ts';
import { json, testControlUrl, testIdentity, testImageResolver } from '../../tests/helpers.ts';
import type { WatchFrame } from '../protocol.ts';

const OPERATOR = 'op-watch-test';
const idHeaders = (token: string): Record<string, string> =>
  token === OPERATOR
    ? { 'x-tug-test-operator': 'operator' }
    : token.length > 200
      ? { 'x-tug-test-credential': token }
      : { 'x-tug-test-node': token };

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-watch-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
  });
  const httpServer = http.createServer(app);
  attachAgentStream(app, httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const call = (method: string, route: string, body?: unknown, token = OPERATOR) =>
    fetch(`${base}${route}`, {
      method,
      headers: { ...idHeaders(token), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const registered = await json(
    await call('POST', '/api/v1/nodes/register', { name: 'n1', address: '10.0.0.1' }),
  );
  const mint = async (name: string, role: string, projects?: string[]) =>
    (await json(await call('POST', '/api/v1/credentials', { name, role, projects })))
      .credential as string;
  const sockets: WebSocket[] = [];
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return { base, call, registered, mint, sockets, close };
}
type Fixture = Awaited<ReturnType<typeof server>>;

/** A socket whose frames are queued, so a test can wait for one, or for none. */
async function open(s: Fixture, route: string, token: string) {
  const ws = new WebSocket(s.base.replace(/^http/, 'ws') + route, { headers: idHeaders(token) });
  s.sockets.push(ws);
  const queue: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('message', (data) => {
    queue.push(JSON.parse(data.toString()));
    waiters.shift()?.();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  /** The next frame of this type, skipping others. */
  const next = async (type: string, ms = 2000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const at = queue.findIndex((frame) => frame.type === type);
      if (at >= 0) return queue.splice(at, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, left);
      });
    }
  };
  /** True when no frame of this type arrives within `ms`. */
  const none = async (type: string, ms = 200): Promise<boolean> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return !queue.some((frame) => frame.type === type);
  };
  return {
    ws,
    next,
    none,
    closed,
    queue,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
  };
}

async function rejected(base: string, route: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + route, { headers: idHeaders(token) });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('expected the upgrade to be rejected'));
    });
    ws.once('error', () => {});
  });
}

const deployWeb = (s: Fixture, project = 'site') =>
  s.call('POST', '/api/v1/deployments', {
    project,
    version: 'v1',
    compose: {
      services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } },
    },
  });
const report = (state: string, health = 'serving') => ({
  node: 'n1',
  projects: [
    {
      project: 'site',
      observedVersion: 'v1',
      health,
      services: ['web'],
      serviceStates: { web: { rolloutState: state } },
    },
  ],
  commandResults: [],
});
const event = (over: Record<string, unknown> = {}) => ({
  projectId: 'site',
  level: 'info',
  type: 'service.serving',
  message: 'web serving',
  metadata: {},
  ...over,
});

test('the watch upgrade needs an operator credential of any role, and says WebSocket on a plain GET', async () => {
  const s = await server();
  try {
    const read = await s.mint('reader', 'read');
    assert.equal(
      await rejected(s.base, '/api/v1/watch', 'wrong'),
      401,
      'an unknown credential is unauthorized',
    );
    assert.equal(
      await rejected(s.base, '/api/v1/watch', s.registered.nodeId),
      403,
      'an agent credential is not an operator',
    );
    assert.equal(
      (await s.call('GET', '/api/v1/watch')).status,
      426,
      'a plain GET explains that an upgrade is required',
    );
    const watcher = await open(s, '/api/v1/watch', read);
    const ready = (await watcher.next('watch.ready')) as unknown as Extract<
      WatchFrame,
      { type: 'watch.ready' }
    >;
    assert.equal(ready.v, 1, 'frames are versioned');
    assert.match(ready.version, /^\d+\.\d+\.\d+/, 'ready carries control’s version');
    assert.ok(Number.isInteger(ready.cursor), 'ready carries the end of the event log as a cursor');
  } finally {
    await s.close();
  }
});

test('an event an agent reports reaches a watcher as a frame, with its seq and without another request', async () => {
  const s = await server();
  try {
    assert.equal((await deployWeb(s)).status, 200, 'the project places a service on the node');
    const watcher = await open(s, '/api/v1/watch', OPERATOR);
    const ready = (await watcher.next('watch.ready')) as { cursor: number };
    const posted = await s.call(
      'POST',
      '/agent/v1/events',
      event({ message: 'first' }),
      s.registered.nodeId,
    );
    assert.equal(posted.status, 200, 'the agent’s event is accepted');
    const frame = (await watcher.next('watch.events')) as {
      events: { seq: number; message: string; type: string; node_id: string }[];
      cursor: number;
    };
    assert.deepEqual(
      frame.events.map((e) => e.message),
      ['first'],
      'the new event is pushed',
    );
    assert.ok(frame.events[0].seq > ready.cursor, 'it is positioned after the cursor in ready');
    assert.equal(frame.cursor, frame.events[0].seq, 'the frame’s cursor is the last event’s seq');
    assert.equal(
      frame.events[0].node_id,
      s.registered.nodeId,
      'the event is attributed to the reporting node',
    );
  } finally {
    await s.close();
  }
});

test('a scoped credential never receives other projects’ events or control-level events', async () => {
  const s = await server();
  try {
    await deployWeb(s, 'a');
    await deployWeb(s, 'b');
    const scoped = await s.mint('only-a', 'read', ['a']);
    const watcher = await open(s, '/api/v1/watch', scoped);
    await watcher.next('watch.ready');
    await s.call(
      'POST',
      '/agent/v1/events',
      event({ projectId: 'b', message: 'other project' }),
      s.registered.nodeId,
    );
    await s.call(
      'POST',
      '/agent/v1/events',
      event({ projectId: null, message: 'node level' }),
      s.registered.nodeId,
    );
    await s.call(
      'POST',
      '/agent/v1/events',
      event({ projectId: 'a', message: 'mine' }),
      s.registered.nodeId,
    );
    const frame = (await watcher.next('watch.events')) as { events: { message: string }[] };
    assert.deepEqual(
      frame.events.map((e) => e.message),
      ['mine'],
      'only the credential’s own project’s event arrives',
    );
    assert.ok(await watcher.none('watch.events'), 'nothing else follows');
  } finally {
    await s.close();
  }
});

test('a changed status report is announced for its project, and an identical one is not', async () => {
  const s = await server();
  try {
    assert.equal((await deployWeb(s)).status, 200, 'the project deploys');
    const watcher = await open(s, '/api/v1/watch', OPERATOR);
    await watcher.next('watch.ready');
    await s.call('POST', '/agent/v1/status', report('starting'), s.registered.nodeId);
    const first = (await watcher.next('watch.changed')) as {
      changes: { topic: string; project?: string }[];
    };
    assert.ok(
      first.changes.some((c) => c.topic === 'status' && c.project === 'site'),
      'the changed report marks the project’s status',
    );
    await watcher.next('watch.changed', 100).catch(() => undefined);
    watcher.queue.length = 0;
    await s.call('POST', '/agent/v1/status', report('starting'), s.registered.nodeId);
    assert.ok(
      await watcher.none('watch.changed', 300),
      'the same report again changes nothing, so it is not announced',
    );
    await s.call('POST', '/agent/v1/status', report('serving'), s.registered.nodeId);
    const again = (await watcher.next('watch.changed')) as { changes: { topic: string }[] };
    assert.ok(
      again.changes.some((c) => c.topic === 'status'),
      'a real change is announced',
    );
  } finally {
    await s.close();
  }
});

test('a scoped credential is told only about its own projects', async () => {
  const s = await server();
  try {
    assert.equal((await deployWeb(s, 'other')).status, 200, 'another project deploys');
    const scoped = await s.mint('only-site', 'read', ['site']);
    const watcher = await open(s, '/api/v1/watch', scoped);
    await watcher.next('watch.ready');
    assert.equal((await deployWeb(s, 'site')).status, 200, 'the credential’s project deploys');
    const frame = (await watcher.next('watch.changed')) as { changes: { project?: string }[] };
    assert.ok(
      frame.changes.every((c) => !c.project || c.project === 'site'),
      'no hint names a project the credential cannot read',
    );
    assert.ok(
      frame.changes.some((c) => c.project === 'site'),
      'its own project is named',
    );
  } finally {
    await s.close();
  }
});

test('a request that changes something is announced at once, without waiting for the sweep', async () => {
  const s = await server();
  try {
    const watcher = await open(s, '/api/v1/watch', OPERATOR);
    await watcher.next('watch.ready');
    const started = Date.now();
    await s.call('POST', '/api/v1/nodes/register', { name: 'n2', address: '10.0.0.2' });
    const frame = (await watcher.next('watch.changed', 800)) as { changes: { topic: string }[] };
    assert.ok(
      frame.changes.some((c) => c.topic === 'nodes'),
      'a new node is a nodes change',
    );
    assert.ok(Date.now() - started < 800, 'it arrives well inside the one-second sweep');
  } finally {
    await s.close();
  }
});

test('an agent connecting or disconnecting is a nodes change and shows as connected in status', async () => {
  const s = await server();
  try {
    const watcher = await open(s, '/api/v1/watch', OPERATOR);
    await watcher.next('watch.ready');
    const connected = async () =>
      (
        (await json(await s.call('GET', '/api/v1/status'))) as {
          nodes: { name: string; connected: boolean }[];
        }
      ).nodes.find((n) => n.name === 'n1')?.connected;
    assert.equal(await connected(), false, 'no stream, not connected');
    const agent = await open(s, '/agent/v1/stream', s.registered.nodeId);
    await agent.next('ready');
    assert.ok(
      ((await watcher.next('watch.changed')) as { changes: { topic: string }[] }).changes.some(
        (c) => c.topic === 'nodes',
      ),
      'connecting is announced',
    );
    assert.equal(
      await connected(),
      true,
      'status says the node is connected while its stream is open',
    );
    watcher.queue.length = 0;
    agent.ws.terminate();
    assert.ok(
      ((await watcher.next('watch.changed')) as { changes: { topic: string }[] }).changes.some(
        (c) => c.topic === 'nodes',
      ),
      'disconnecting is announced',
    );
    assert.equal(await connected(), false, 'and status says it is no longer connected');
  } finally {
    await s.close();
  }
});

test('the channel is read-only, and each credential may hold only a few sockets', async () => {
  const s = await server();
  try {
    const watcher = await open(s, '/api/v1/watch', OPERATOR);
    await watcher.next('watch.ready');
    watcher.send({ v: 1, type: 'watch.subscribe' });
    assert.equal(
      await watcher.closed,
      1008,
      'a frame from the client closes the socket as a protocol error',
    );
    const kept = [];
    for (let i = 0; i < 8; i++) kept.push(await open(s, '/api/v1/watch', OPERATOR));
    assert.equal(
      await rejected(s.base, '/api/v1/watch', OPERATOR),
      429,
      'the ninth socket of one credential is refused',
    );
    kept[0].ws.terminate();
    await kept[0].closed;
    const again = await open(s, '/api/v1/watch', OPERATOR);
    assert.ok(again.ws.readyState === WebSocket.OPEN, 'closing one frees a slot');
  } finally {
    await s.close();
  }
});

test('events can be followed by seq: after returns the newer ones oldest first, with the end of the log as cursor', async () => {
  const s = await server();
  try {
    for (const message of ['one', 'two', 'three'])
      await s.call('POST', '/agent/v1/events', event({ message }), s.registered.nodeId);
    const all = (await json(await s.call('GET', '/api/v1/events'))) as {
      events: { seq: number; message: string }[];
      cursor: number;
    };
    assert.equal(all.events[0].message, 'three', 'without after the newest comes first, as before');
    const [three, two] = [all.events[0].seq, all.events[1].seq];
    const newer = (await json(await s.call('GET', `/api/v1/events?after=${two}`))) as {
      events: { message: string }[];
      cursor: number;
    };
    assert.deepEqual(
      newer.events.map((e) => e.message),
      ['three'],
      'after returns only the events past that seq',
    );
    assert.equal(newer.cursor, three, 'the cursor is the end of the log');
    const ascending = (await json(await s.call('GET', '/api/v1/events?after=0&limit=2'))) as {
      events: { message: string }[];
    };
    assert.deepEqual(
      ascending.events.map((e) => e.message).slice(-2).length,
      2,
      'limit applies to a followed page',
    );
    assert.equal(
      (await s.call('GET', '/api/v1/events?after=nope')).status,
      400,
      'a bad cursor is a 400',
    );
  } finally {
    await s.close();
  }
});

test('events an agent sends over its stream socket land in the same log, and a malformed frame closes the socket', async () => {
  const s = await server();
  try {
    const agent = await open(s, '/agent/v1/stream', s.registered.nodeId);
    await agent.next('ready');
    agent.send({
      v: 1,
      type: 'agent.event',
      events: [
        event({
          message: 'over the socket',
          type: 'container.exited',
          level: 'warn',
          metadata: { exitCode: 2 },
        }),
        'not an event',
      ],
    });
    const deadline = Date.now() + 2000;
    let found:
      { message: string; node_id: string; level: string; metadata_json: string } | undefined;
    while (!found && Date.now() < deadline) {
      const list = (await json(await s.call('GET', '/api/v1/events'))) as {
        events: { message: string; node_id: string; level: string; metadata_json: string }[];
      };
      found = list.events.find((e) => e.message === 'over the socket');
      if (!found) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(found, 'the socket event is stored');
    assert.equal(
      found?.node_id,
      s.registered.nodeId,
      'it is attributed to the node whose socket sent it, not to a name in the frame',
    );
    assert.equal(found?.level, 'warn', 'level and metadata are kept');
    assert.deepEqual(
      JSON.parse(found!.metadata_json),
      { exitCode: 2 },
      'metadata is stored as sent',
    );
    agent.send({ v: 1, type: 'agent.event', events: [], extra: true });
    assert.equal(
      await agent.closed,
      1008,
      'a frame with unknown fields is a protocol error and closes the socket',
    );
  } finally {
    await s.close();
  }
});

/** The smallest socket the hub needs, to drive it without a network. */
function fakeSocket(bufferedAmount = 0) {
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount,
    sent: [] as string[],
    closedWith: undefined as number | undefined,
    terminated: false,
    pings: 0,
    send(data: string) {
      socket.sent.push(data);
    },
    close(code?: number) {
      socket.closedWith = code;
      socket.readyState = WebSocket.CLOSED;
      socket.emit('close', code);
    },
    terminate() {
      socket.terminated = true;
      socket.readyState = WebSocket.CLOSED;
      socket.emit('close', 1006);
    },
    ping() {
      socket.pings += 1;
    },
  });
  return socket;
}
const stubDb = {
  get: () => ({ seq: 0 }),
  all: () => [],
} as unknown as import('../db/db.ts').Db;
const actor = { name: 'op', role: 'read' as const, projects: null };

test('a watcher that cannot keep up is disconnected instead of buffered without bound', () => {
  const hub = new WatchHub({ db: stubDb, nodes: () => [], version: '1.0.0', tickMs: 1e6 });
  const slow = fakeSocket(2 * 1024 * 1024);
  hub.subscribe(actor, slow as unknown as WebSocket);
  assert.equal(
    slow.closedWith,
    1013,
    'a socket with a full buffer is closed with 1013 (try again) so it reconnects and refetches',
  );
  assert.equal(hub.size, 0, 'and it is no longer a subscriber');
});

test('a socket that stops answering pings is terminated, and the timers stop when the last watcher leaves', async () => {
  const hub = new WatchHub({
    db: stubDb,
    nodes: () => [],
    version: '1.0.0',
    tickMs: 1e6,
    pingMs: 15,
  });
  const dead = fakeSocket();
  hub.subscribe(actor, dead as unknown as WebSocket);
  assert.equal(dead.sent.length, 1, 'the ready frame is sent on subscribe');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(dead.pings >= 1, 'the hub pings its watchers');
  assert.equal(dead.terminated, true, 'a watcher that never answers is terminated');
  assert.equal(hub.size, 0, 'and removed');
});

const eventsAfter = async (s: Fixture, query: string, token = OPERATOR) =>
  (await json(await s.call('GET', `/api/v1/events${query}`, undefined, token))) as {
    events: {
      seq: number;
      message: string;
      project_id: string | null;
      deployment_id: string | null;
    }[];
    cursor: number;
  };

test('following the log with cursor skips nothing, even when a page is smaller than what is waiting', async () => {
  const s = await server();
  try {
    for (let i = 1; i <= 7; i++)
      await s.call('POST', '/agent/v1/events', event({ message: `e${i}` }), s.registered.nodeId);
    const seen: string[] = [];
    let cursor = 0;
    for (let page = 0; page < 5; page++) {
      const result = await eventsAfter(s, `?after=${cursor}&limit=3`);
      seen.push(...result.events.map((e) => e.message));
      assert.ok(
        result.events.length === 0 || result.cursor === result.events[result.events.length - 1].seq,
        'the cursor is the last row of the page, not the end of the log',
      );
      cursor = result.cursor;
    }
    assert.deepEqual(
      seen,
      ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      'passing cursor as the next after returns every event once, in order',
    );
    const idle = await eventsAfter(s, `?after=${cursor}`);
    assert.deepEqual(
      [idle.events.length, idle.cursor],
      [0, cursor],
      'a caught-up follower gets nothing and the same cursor',
    );
    const newest = await eventsAfter(s, '');
    assert.equal(
      newest.cursor,
      cursor,
      'the newest-first view reports the newest seq it can see, to start following from',
    );
    assert.equal(
      (await eventsAfter(s, '?after=999999')).cursor,
      cursor,
      'a cursor ahead of the log is pulled back to the end of it, so a client can notice',
    );
  } finally {
    await s.close();
  }
});

test('a scoped credential is never told the global end of the log, by events or by watch.ready', async () => {
  const s = await server();
  try {
    await deployWeb(s, 'a');
    await deployWeb(s, 'b');
    await s.call(
      'POST',
      '/agent/v1/events',
      event({ projectId: 'a', message: 'mine' }),
      s.registered.nodeId,
    );
    for (let i = 0; i < 5; i++)
      await s.call(
        'POST',
        '/agent/v1/events',
        event({ projectId: 'b', message: `other${i}` }),
        s.registered.nodeId,
      );
    const scoped = await s.mint('only-a', 'read', ['a']);
    const own = (await eventsAfter(s, '', scoped)).events;
    assert.ok(
      own.some((e) => e.message === 'mine'),
      'its own event is listed',
    );
    assert.ok(
      own.every((e) => !e.message.startsWith('other')),
      'the other project’s events are not',
    );
    const ownEnd = Math.max(...own.map((e) => e.seq));
    const global = (await eventsAfter(s, '')).cursor;
    assert.equal(
      (await eventsAfter(s, '', scoped)).cursor,
      ownEnd,
      'its cursor is its own newest event',
    );
    assert.ok(
      ownEnd < global,
      'which is behind the global end, so the other project’s activity is not revealed',
    );
    const watcher = await open(s, '/api/v1/watch', scoped);
    assert.equal(
      ((await watcher.next('watch.ready')) as { cursor: number }).cursor,
      ownEnd,
      'watch.ready tells it the same',
    );
  } finally {
    await s.close();
  }
});

test('an event can name only a project that places a service on the reporting node, and a deployment only of that project', async () => {
  const s = await server();
  try {
    const deployed = (await json(await deployWeb(s, 'site'))) as { deployment: { id: string } };
    const other = (await json(await deployWeb(s, 'elsewhere'))) as { deployment: { id: string } };
    await s.call('POST', '/api/v1/nodes/register', { name: 'n2', address: '10.0.0.2' });
    assert.equal(
      (
        await s.call('POST', '/api/v1/deployments', {
          project: 'only-n2',
          version: 'v1',
          compose: {
            services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n2'] } } } },
          },
        })
      ).status,
      200,
      'a project placed only on another node deploys',
    );
    const scoped = await s.mint('only-n2-reader', 'read', ['only-n2']);
    const watcher = await open(s, '/api/v1/watch', scoped);
    await watcher.next('watch.ready');
    const post = (over: Record<string, unknown>) =>
      s.call('POST', '/agent/v1/events', event(over), s.registered.nodeId);
    await post({ projectId: 'site', deploymentId: deployed.deployment.id, message: 'placed here' });
    await post({
      projectId: 'site',
      deploymentId: other.deployment.id,
      message: 'foreign deployment',
    });
    await post({ projectId: 'only-n2', message: 'placed on another node' });
    await post({ projectId: 'does-not-exist', message: 'unknown project' });
    const rows = (await eventsAfter(s, '?after=0&limit=50')).events;
    const byMessage = (message: string) => rows.find((row) => row.message === message);
    assert.equal(
      byMessage('placed here')?.project_id,
      'site',
      'a project placed on this node keeps its events',
    );
    assert.equal(
      byMessage('placed here')?.deployment_id,
      deployed.deployment.id,
      'and its own deployment id',
    );
    assert.equal(
      byMessage('foreign deployment')?.deployment_id,
      null,
      'a deployment of another project is dropped',
    );
    assert.equal(
      byMessage('placed on another node')?.project_id,
      null,
      'a project this node does not serve is stored as a node-level event',
    );
    assert.equal(
      byMessage('unknown project')?.project_id,
      null,
      'so is a project that does not exist',
    );
    assert.ok(
      await watcher.none('watch.events', 300),
      'nothing was attributed to the scoped watcher’s project, so nothing reaches it',
    );
  } finally {
    await s.close();
  }
});

test('a failure to store agent events leaves the agent socket, and the live sessions on it, open', () => {
  let failures = 0;
  const hub = new LiveHub(
    async () => {
      throw new Error('unused');
    },
    1000,
    () => {
      failures += 1;
      throw new Error('database is busy');
    },
  );
  const ws = fakeSocket();
  const quiet = console.error;
  console.error = () => {};
  try {
    hub.agent('node_1', ws as unknown as WebSocket);
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ v: 1, type: 'agent.event', events: [{ message: 'x' }] })),
      false,
    );
  } finally {
    console.error = quiet;
  }
  assert.equal(failures, 1, 'the events were handed to the store, which failed');
  assert.equal(ws.closedWith, undefined, 'the socket was not closed over a lost event');
  ws.emit(
    'message',
    Buffer.from(JSON.stringify({ v: 1, type: 'agent.event', events: [], extra: 1 })),
    false,
  );
  assert.equal(ws.closedWith, 1008, 'a malformed frame still closes it');
});

test('control lists what the agent socket supports in ready, and a real agent channel then sends events over it', async () => {
  const s = await server();
  try {
    assert.equal((await deployWeb(s)).status, 200, 'the project places a service on the node');
    const ready = await open(s, '/agent/v1/stream', s.registered.nodeId);
    assert.deepEqual(
      ((await ready.next('ready')) as { features: string[] }).features,
      ['agent.event'],
      'ready lists agent.event',
    );
    ready.ws.terminate();
    const ctx = {
      docker: new FakeDocker(),
      controlUrl: s.base,
      credential: {},
    } as unknown as AgentContext;
    const channel = new AgentWakeChannel(
      ctx,
      (url) =>
        new WebSocket(url.replace(/^https?/, 'ws'), { headers: idHeaders(s.registered.nodeId) }),
    );
    await channel.wait(150);
    assert.equal(
      channel.sendEvent({
        projectId: 'site',
        level: 'warn',
        type: 'container.exited',
        message: 'sent by a real channel',
      }),
      true,
      'the channel uses the socket because control listed the feature',
    );
    let stored: { message: string; node_id: string } | undefined;
    for (let i = 0; i < 100 && !stored; i++) {
      const list = (await json(await s.call('GET', '/api/v1/events'))) as {
        events: { message: string; node_id: string }[];
      };
      stored = list.events.find((e) => e.message === 'sent by a real channel');
      if (!stored) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      stored?.node_id,
      s.registered.nodeId,
      'the event is stored against the node whose socket carried it',
    );
    channel.close();
  } finally {
    await s.close();
  }
});
