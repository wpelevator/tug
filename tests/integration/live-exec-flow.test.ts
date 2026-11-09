// Real Docker: CLI runner -> control relay -> real agent live code -> Docker Engine API exec in a real container.
// The in-process twin with a scripted container is src/control/live-flow.test.ts; this one proves the Engine side
// (hijacked exec socket, demux, pipe backpressure) holds the same guarantees.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AgentLiveOperations, AgentWakeChannel } from '../../src/agent/agent.ts';
import type { AgentContext } from '../../src/agent/agent.ts';
import { parseLiveRequest, runCliLive } from '../../src/cli/live.ts';
import { liveSocketTransport } from '../../src/cli/live-transport.ts';
import { attachAgentStream, createApp } from '../../src/control/control.ts';
import { DockerEngine } from '../../src/docker-api.ts';
import { LIVE_MAX_FRAME_BYTES } from '../../src/protocol.ts';
import { json, testControlUrl, testIdentity, testImageResolver } from '../helpers.ts';

const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const MB = 1024 * 1024;
const TOTAL = 100 * MB;
const CHUNK = 64 * 1024;
const IMAGE = 'alpine:3.20';
const PROJECT = `lflow${randomBytes(3).toString('hex')}`;
// Docker Desktop and rootless setups listen elsewhere than /var/run/docker.sock: use the active context's socket.
if (dockerUp && !process.env.DOCKER_HOST) {
  const endpoint = docker('context', 'inspect', '-f', '{{.Endpoints.docker.Host}}').stdout.trim();
  if (endpoint.startsWith('unix://')) process.env.DOCKER_HOST = endpoint;
}
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deterministic pseudo-random chunks (xorshift32): the source is hashed without keeping 100 MB in memory. */
function* randomChunks(total: number): Generator<Buffer> {
  let state = 0x2545f491;
  for (let left = total; left > 0;) {
    const size = Math.min(CHUNK, left);
    const words = new Uint32Array(Math.ceil(size / 4));
    for (let i = 0; i < words.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      words[i] = state >>> 0;
    }
    left -= size;
    yield Buffer.from(words.buffer, 0, size);
  }
}

/** A local output stream that hashes what it receives and delays every `delayEvery`th write by `delayMs`. */
function sink(delayEvery = 0, delayMs = 0) {
  const hash = createHash('sha256');
  const state = { bytes: 0, writes: 0, text: '' };
  const stream = new Writable({
    highWaterMark: 16 * 1024,
    async write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      state.bytes += chunk.length;
      if (state.text.length < 4096) state.text += chunk.toString('latin1');
      if (delayEvery && ++state.writes % delayEvery === 0) await tick(delayMs);
      callback();
    },
  });
  return { stream, state, digest: () => hash.digest('hex') };
}

let container = '';

test.before(() => {
  if (!dockerUp) return;
  if (docker('image', 'inspect', IMAGE).status !== 0)
    assert.equal(docker('pull', IMAGE).status, 0, `${IMAGE} should pull for the live exec test`);
  const started = docker(
    'run',
    '-d',
    '--name',
    `tug-${PROJECT}-web-1`,
    '--label',
    `tug.project=${PROJECT}`,
    '--label',
    'tug.service=web',
    IMAGE,
    'sleep',
    '900',
  );
  assert.equal(started.status, 0, `the test container should start: ${started.stderr}`);
  container = started.stdout.trim();
});
test.after(() => {
  if (container) docker('rm', '-f', container);
});

/** Plain-HTTP control with the identity seam, plus the real agent live code driving the local Docker Engine. */
async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-docker-flow-'));
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
    project: PROJECT,
    version: 'v1',
    compose: { services: { web: { image: IMAGE, 'x-tug': { placement: { nodes: ['n1'] } } } } },
  });
  assert.equal(deployed.status, 200, 'the desired state for the live exec test should publish');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-docker-flow-agent-'));
  const ctx: AgentContext = {
    stateDir,
    nodeName: 'n1',
    apply: true,
    controlUrl: base,
    http: fetch,
    docker: new DockerEngine(),
  };
  const wake: AgentWakeChannel = new AgentWakeChannel(
    ctx,
    (url) =>
      new WebSocket(url.replace(/^wss:/, 'ws:'), {
        headers: { 'x-tug-test-node': registered.nodeId },
        maxPayload: LIVE_MAX_FRAME_BYTES,
      }),
    { onLive: (frame) => live.handle(frame), onDisconnect: () => live.dispose() },
  );
  const live: AgentLiveOperations = new AgentLiveOperations(ctx, (frame) => {
    wake.send(frame);
  });
  void wake.wait(600_000);
  await tick(300);
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
  const exec = async (
    command: string[],
    io: { stdin?: Readable; stdout: Writable; interactive: boolean; oneOff?: boolean },
  ) => {
    const stderr = sink();
    const started = Date.now();
    const code = await runCliLive(
      parseLiveRequest('exec', {
        project: PROJECT,
        service: 'web',
        command,
        interactive: io.interactive,
        ...(io.oneOff ? { oneOff: true } : {}),
      }),
      liveSocketTransport(new URL(`${base.replace(/^http/, 'ws')}/api/v1/live`), {
        headers: { 'x-tug-test-operator': 'operator' },
      }),
      {
        stdin: (io.stdin ?? Readable.from([])) as never,
        stdout: io.stdout as never,
        stderr: stderr.stream,
        signals: new EventEmitter(),
      },
    );
    return { code, stderr: stderr.state.text, seconds: (Date.now() - started) / 1000 };
  };
  return { exec };
}

const expectedHash = (() => {
  const hash = createHash('sha256');
  for (const chunk of randomChunks(TOTAL)) hash.update(chunk);
  return hash.digest('hex');
})();

test(
  'real Docker: a 100 MB upload through tug exec -i arrives intact in the container',
  { skip: !dockerUp, timeout: 300_000 },
  async (t) => {
    const f = await fixture(t);
    const stdout = sink();
    const result = await f.exec(['sha256sum'], {
      stdin: Readable.from(randomChunks(TOTAL)),
      stdout: stdout.stream,
      interactive: true,
    });
    t.diagnostic(`upload took ${result.seconds}s`);
    assert.equal(result.code, 0, `exec should exit 0, stderr: ${result.stderr}`);
    assert.equal(
      stdout.state.text.split(/\s/)[0],
      expectedHash,
      'the container must hash exactly the 100 MB the CLI sent',
    );
  },
);

test(
  'real Docker: an upload waits for a container that does not read for three seconds instead of failing',
  { skip: !dockerUp, timeout: 300_000 },
  async (t) => {
    const f = await fixture(t);
    const stdout = sink();
    const result = await f.exec(['sh', '-c', 'sleep 3; sha256sum'], {
      stdin: Readable.from(randomChunks(TOTAL)),
      stdout: stdout.stream,
      interactive: true,
    });
    t.diagnostic(`stalled upload took ${result.seconds}s`);
    assert.equal(result.code, 0, `exec should exit 0, stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /buffer limit|exceeded/i, 'no buffer limit is hit');
    assert.equal(
      stdout.state.text.split(/\s/)[0],
      expectedHash,
      'input sent while the container was not reading must arrive complete and in order',
    );
  },
);

test(
  'real Docker: a 100 MB download through tug exec reaches a slow local reader intact',
  { skip: !dockerUp, timeout: 300_000 },
  async (t) => {
    const prepared = docker(
      'exec',
      container,
      'sh',
      '-c',
      'head -c 104857600 /dev/urandom > /tmp/blob && sha256sum /tmp/blob',
    );
    assert.equal(
      prepared.status,
      0,
      `the container should write a 100 MB file: ${prepared.stderr}`,
    );
    const containerHash = prepared.stdout.split(/\s/)[0];
    const f = await fixture(t);
    const stdout = sink(4, 1);
    const result = await f.exec(['cat', '/tmp/blob'], {
      stdout: stdout.stream,
      interactive: false,
    });
    t.diagnostic(`download took ${result.seconds}s`);
    assert.equal(result.code, 0, `exec should exit 0, stderr: ${result.stderr}`);
    assert.equal(stdout.state.bytes, TOTAL, 'every byte of the file reaches the CLI');
    assert.equal(stdout.digest(), containerHash, 'the download matches the file in the container');
  },
);

test(
  'real Docker: tug run (a one-off container) streams 8 MB to a slow reader and returns its exit code',
  { skip: !dockerUp, timeout: 300_000 },
  async (t) => {
    const f = await fixture(t);
    const stdout = sink(4, 1);
    const result = await f.exec(['sh', '-c', 'head -c 8388608 /dev/zero; exit 7'], {
      stdout: stdout.stream,
      interactive: false,
      oneOff: true,
    });
    assert.equal(
      result.code,
      7,
      `run should return the command's exit code, stderr: ${result.stderr}`,
    );
    assert.equal(stdout.state.bytes, 8 * MB, 'all output arrives before the exit code');
  },
);
