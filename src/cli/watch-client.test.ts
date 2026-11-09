import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../tests/helpers.ts';
import type WebSocket from 'ws';
import type { Credential } from '../pki.ts';
import type { WatchFrame } from '../protocol.ts';
import { WatchClient, parseWatchFrame } from './watch-client.ts';

class FakeSocket extends EventEmitter {
  terminated = false;
  terminate() {
    this.terminated = true;
    this.emit('close', 1006);
  }
  say(frame: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
}
const credential = {} as Credential;
const ready = { v: 1, type: 'watch.ready', cursor: 7, version: '1.2.0' };

function client(over: { initialBackoffMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const frames: WatchFrame[] = [];
  const states: boolean[] = [];
  const instance = new WatchClient({
    credential,
    controlUrl: 'https://control.test:8443/base',
    onFrame: (frame) => frames.push(frame),
    onState: (connected) => states.push(connected),
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    initialBackoffMs: over.initialBackoffMs ?? 5,
    maxBackoffMs: 20,
  });
  return { instance, sockets, urls, frames, states };
}
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('frames are validated: unknown, malformed and unversioned frames are dropped', () => {
  assert.deepEqual(parseWatchFrame(JSON.stringify(ready)), ready, 'a ready frame parses');
  assert.equal(parseWatchFrame('not json'), undefined, 'garbage is dropped');
  assert.equal(
    parseWatchFrame(JSON.stringify({ ...ready, v: 2 })),
    undefined,
    'another protocol version is dropped',
  );
  assert.equal(
    parseWatchFrame(JSON.stringify({ v: 1, type: 'watch.changed', changes: [{ topic: 'bogus' }] })),
    undefined,
    'an unknown topic is dropped',
  );
  assert.equal(
    parseWatchFrame(JSON.stringify({ v: 1, type: 'watch.events', events: [{}], cursor: 1 })),
    undefined,
    'an event without an id is dropped',
  );
  assert.ok(
    parseWatchFrame(
      JSON.stringify({
        v: 1,
        type: 'watch.changed',
        changes: [{ topic: 'status', project: 'site' }, { topic: 'nodes' }],
      }),
    ),
    'a valid change list parses',
  );
});

test('it connects to /api/v1/watch under the control URL, and reports connected only once control says ready', async () => {
  const c = client();
  c.instance.start();
  assert.deepEqual(
    c.urls,
    ['wss://control.test:8443/base/api/v1/watch'],
    'the URL is the control address with the watch path and a WebSocket scheme',
  );
  assert.deepEqual(c.states, [], 'an open socket is not yet a working channel');
  c.sockets[0].say({ v: 1, type: 'watch.changed', changes: [{ topic: 'status' }] });
  assert.deepEqual(c.frames, [], 'frames before ready are ignored');
  c.sockets[0].say(ready);
  assert.deepEqual(c.states, [true], 'ready makes it connected');
  c.sockets[0].say({
    v: 1,
    type: 'watch.changed',
    changes: [{ topic: 'status', project: 'site' }],
  });
  assert.deepEqual(
    c.frames.map((frame: WatchFrame) => frame.type),
    ['watch.ready', 'watch.changed'],
    'ready and later frames are delivered',
  );
  c.instance.stop();
});

test('after the socket drops it reports disconnected and reconnects with backoff until stopped', async () => {
  const c = client();
  c.instance.start();
  c.sockets[0].say(ready);
  c.sockets[0].emit('close', 1006);
  assert.deepEqual(c.states, [true, false], 'a lost socket is reported');
  await until(() => c.sockets.length === 2, 'the reconnect');
  c.sockets[1].emit('error', new Error('refused'));
  assert.equal(c.states.length, 2, 'a connection that never became ready is not reported as lost');
  await until(() => c.sockets.length === 3, 'a retry after a failed attempt');
  c.sockets[2].say(ready);
  assert.deepEqual(c.states, [true, false, true], 'it is connected again after a new ready');
  c.instance.stop();
  const count = c.sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(c.sockets.length, count, 'stopping ends the retries');
  assert.equal(c.sockets[2].terminated, true, 'and closes the socket');
});

test('over real mTLS the client connects with its operator certificate and hears about a new node', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-watch-mtls-'));
  const control = await startMtlsControl(dir);
  const frames: WatchFrame[] = [];
  const states: boolean[] = [];
  const watcher = new WatchClient({
    credential: control.root,
    controlUrl: control.url,
    onFrame: (frame) => frames.push(frame),
    onState: (connected) => states.push(connected),
  });
  try {
    watcher.start();
    await until(() => states[0] === true, 'the channel to open');
    assert.equal(frames[0]?.type, 'watch.ready', 'control greets with ready over TLS');
    assert.equal((await control.registerNode('web')).status, 200, 'a node registers');
    await until(
      () =>
        frames.some(
          (frame) =>
            frame.type === 'watch.changed' &&
            frame.changes.some((change) => change.topic === 'nodes'),
        ),
      'the nodes change',
    );
  } finally {
    watcher.stop();
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
