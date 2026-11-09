// End to end: CLI runner -> control relay -> real agent live code, in one process over real WebSockets.
// The container is scripted; everything between it and the CLI's streams is the production code path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AgentLiveOperations, AgentWakeChannel } from '../agent/agent.ts';
import type { AgentContext } from '../agent/agent.ts';
import { parseLiveRequest, runCliLive } from '../cli/live.ts';
import type { CliLiveIO } from '../cli/live.ts';
import { liveSocketTransport } from '../cli/live-transport.ts';
import type { AttachedProcess } from '../docker-api.ts';
import { LIVE_MAX_FRAME_BYTES, LIVE_WINDOW_BYTES } from '../protocol.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { testControlUrl, testIdentity, testImageResolver, json } from '../../tests/helpers.ts';
import { attachAgentStream, createApp } from './control.ts';

const MB = 1024 * 1024;
const CHUNK = 64 * 1024;
const TOTAL = 100 * MB;
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deterministic pseudo-random chunks (xorshift32), so source and sink hashes are comparable without storing 100 MB. */
function* randomChunks(total: number, onChunk?: (chunk: Buffer) => void): Generator<Buffer> {
  let state = 0x9e3779b9;
  for (let left = total; left > 0;) {
    const size = Math.min(CHUNK, left);
    const words = new Uint32Array(Math.ceil(size / 4));
    for (let i = 0; i < words.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      words[i] = state >>> 0;
    }
    const chunk = Buffer.from(words.buffer, 0, size);
    onChunk?.(chunk);
    left -= size;
    yield chunk;
  }
}
const sourceHash = (): string => {
  const hash = createHash('sha256');
  for (const chunk of randomChunks(TOTAL)) hash.update(chunk);
  return hash.digest('hex');
};

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

async function fixture(t: test.TestContext, script: (child: Child) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-flow-'));
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
  const call = (method: string, route: string, body?: unknown) =>
    fetch(`${base}${route}`, {
      method,
      headers: { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const registered = await json(
    await call('POST', '/api/v1/nodes/register', { name: 'n1', address: '10.0.0.1' }),
  );
  const deployed = await call('POST', '/api/v1/deployments', {
    project: 'site',
    version: 'v1',
    compose: {
      services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } } },
    },
  });
  assert.equal(deployed.status, 200, 'the flow test desired state should publish');

  const docker = new FakeDocker();
  docker.addImage('app');
  const id = await docker.createContainer('tug-site-web-1', {
    Image: 'app',
    Labels: { 'tug.project': 'site', 'tug.service': 'web' },
  });
  await docker.startContainer(id);
  docker.execStart = async () => {
    const child = new Child();
    script(child);
    return child as unknown as AttachedProcess;
  };
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-flow-agent-'));
  const ctx: AgentContext = {
    stateDir,
    nodeName: 'n1',
    apply: true,
    controlUrl: base,
    http: fetch,
    docker,
  };
  const wake: AgentWakeChannel = new AgentWakeChannel(
    ctx,
    (url) => {
      const ws = new WebSocket(url.replace(/^wss:/, 'ws:'), {
        headers: { 'x-tug-test-node': registered.nodeId },
        maxPayload: LIVE_MAX_FRAME_BYTES,
      });
      return ws;
    },
    { onLive: (frame) => live.handle(frame), onDisconnect: () => live.dispose() },
  );
  const live: AgentLiveOperations = new AgentLiveOperations(ctx, (frame) => {
    wake.send(frame);
  });
  void wake.wait(120_000);
  await tick(200); // the control registers the agent socket when the upgrade completes
  t.after(async () => {
    wake.close();
    live.dispose();
    await new Promise<void>((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    });
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const wsBase = base.replace(/^http/, 'ws');
  const run = (io: CliLiveIO) =>
    runCliLive(
      parseLiveRequest('exec', {
        project: 'site',
        service: 'web',
        command: ['sh'],
        interactive: true,
      }),
      liveSocketTransport(new URL(`${wsBase}/api/v1/live`), {
        headers: { 'x-tug-test-operator': 'operator' },
      }),
      io,
    );
  return { run };
}

/** A local output stream that hashes what it receives and delays every write callback. */
function slowSink(delayEvery: number, delayMs: number, gate?: Promise<void>) {
  const hash = createHash('sha256');
  const state = { bytes: 0, writes: 0 };
  const stream = new Writable({
    highWaterMark: 16 * 1024,
    async write(chunk: Buffer, _encoding, callback) {
      if (state.writes === 0 && gate) await gate;
      hash.update(chunk);
      state.bytes += chunk.length;
      if (++state.writes % delayEvery === 0) await tick(delayMs);
      callback();
    },
  });
  return { stream, state, digest: () => hash.digest('hex') };
}

const errors = (stderr: string) => stderr.match(/buffer limit|exceeded/i);

test(
  '100 MB upload through the whole live path reaches a slow container intact',
  { timeout: 180_000 },
  async (t) => {
    const received = { bytes: 0, hash: '' };
    const f = await fixture(t, (child) => {
      void (async () => {
        const hash = createHash('sha256');
        for await (const chunk of child.stdin) {
          hash.update(chunk as Buffer);
          received.bytes += (chunk as Buffer).length;
          await tick(1); // a slow reader: about 64 KiB per millisecond at best
        }
        received.hash = hash.digest('hex');
        child.stdout.end(`${received.hash}\n`);
        child.emit('close', 0, null);
      })();
    });
    const stdout = slowSink(1, 0);
    const stderrChunks: Buffer[] = [];
    const stderr = new Writable({
      write(chunk, _e, cb) {
        stderrChunks.push(chunk);
        cb();
      },
    });
    const started = Date.now();
    const code = await f.run({
      stdin: Readable.from(randomChunks(TOTAL), { objectMode: false }) as CliLiveIO['stdin'],
      stdout: stdout.stream,
      stderr,
      signals: new EventEmitter(),
    });
    const errText = Buffer.concat(stderrChunks).toString();
    t.diagnostic(`upload of ${TOTAL / MB} MB took ${Date.now() - started} ms`);
    const expected = sourceHash();
    assert.equal(
      code,
      0,
      `the upload should exit 0 without a buffer-limit failure (stderr: ${errText})`,
    );
    assert.equal(errors(errText), null, 'no buffer-limit error should be reported');
    assert.equal(received.bytes, TOTAL, 'the container should receive every uploaded byte');
    assert.equal(
      received.hash,
      expected,
      'the container should see exactly the bytes the CLI read',
    );
    assert.equal(
      stdout.digest(),
      createHash('sha256').update(`${expected}\n`).digest('hex'),
      'the container hash should reach the CLI stdout',
    );
  },
);

test('100 MB download to a slow local writer arrives intact', { timeout: 180_000 }, async (t) => {
  const f = await fixture(t, (child) => {
    child.stdin.resume();
    const source = Readable.from(randomChunks(TOTAL), { objectMode: false });
    source.pipe(child.stdout);
    child.stdout.once('end', () => setImmediate(() => child.emit('close', 0, null)));
  });
  // Every fourth write takes 1 ms: far slower than the producer, so the window must throttle it.
  const sink = slowSink(4, 1);
  const started = Date.now();
  const code = await f.run({
    stdin: new PassThrough() as unknown as CliLiveIO['stdin'],
    stdout: sink.stream,
    stderr: new PassThrough(),
    signals: new EventEmitter(),
  });
  t.diagnostic(`download of ${TOTAL / MB} MB took ${Date.now() - started} ms`);
  assert.equal(code, 0, 'the download should exit 0 without a buffer-limit failure');
  assert.equal(sink.state.bytes, TOTAL, 'the CLI should write every downloaded byte');
  assert.equal(sink.digest(), sourceHash(), 'the downloaded bytes should match the source hash');
});

test(
  'the agent pauses the container when the CLI stops consuming output',
  { timeout: 60_000 },
  async (t) => {
    let produced = 0;
    const f = await fixture(t, (child) => {
      child.stdin.resume();
      const source = Readable.from(
        randomChunks(TOTAL, (chunk) => {
          produced += chunk.length;
        }),
        { objectMode: false },
      );
      source.pipe(child.stdout);
      child.stdout.once('end', () => setImmediate(() => child.emit('close', 0, null)));
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = slowSink(1, 0, gate);
    const running = f.run({
      stdin: new PassThrough() as unknown as CliLiveIO['stdin'],
      stdout: sink.stream,
      stderr: new PassThrough(),
      signals: new EventEmitter(),
    });
    await tick(1500); // plenty of time for an unthrottled producer to emit far more
    const stalled = produced;
    t.diagnostic(`container wrote ${stalled} bytes while the CLI stdout was stalled`);
    assert.ok(stalled > 0, 'the container should have started writing');
    // Window of credit plus stream buffers on each hop; a producer that ignored backpressure writes all 100 MB.
    assert.ok(
      stalled <= LIVE_WINDOW_BYTES + 2 * MB,
      `output should pause near the ${LIVE_WINDOW_BYTES}-byte window while the CLI is stalled, but the container wrote ${stalled}`,
    );
    release();
    assert.equal(await running, 0, 'the session should finish once the CLI resumes consuming');
    assert.equal(sink.state.bytes, TOTAL, 'no output should be lost across the stall');
    assert.equal(sink.digest(), sourceHash(), 'the stalled download should still match the source');
  },
);
