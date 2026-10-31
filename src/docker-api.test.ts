import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DockerEngine, DockerError, demux, splitImageRef } from './docker-api.ts';

async function daemon(handler: http.RequestListener) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-sock-'));
  const socket = path.join(dir, 'd.sock');
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(socket, r));
  return { engine: new DockerEngine(socket), close: () => server.close() };
}

test('requests are versioned, filters are JSON and errors carry the daemon message', async () => {
  const seen: string[] = [];
  const d = await daemon((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.includes('missing')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'No such container: missing' }));
    } else res.end('[]');
  });
  try {
    await d.engine.listContainers({ label: ['tug.project=p'] });
    assert.match(
      seen[0],
      /^GET \/v1\.41\/containers\/json\?all=1&filters=%7B%22label%22%3A%5B%22tug\.project%3Dp%22%5D%7D$/,
    );
    await assert.rejects(
      d.engine.inspectContainer('missing'),
      (e) => e instanceof DockerError && e.status === 404 && /No such container/.test(e.message),
    );
    assert.equal(await d.engine.inspectNetwork('missing'), null, 'a missing network is null');
  } finally {
    d.close();
  }
});

test('pull reports stream errors and splits references', async () => {
  const d = await daemon((req, res) => {
    res.end('{"status":"Pulling"}\n{"error":"manifest unknown"}\n');
    assert.match(req.url!, /fromImage=nginx&tag=1\.2/);
  });
  try {
    await assert.rejects(d.engine.pullImage('nginx:1.2'), /pull nginx:1\.2: manifest unknown/);
  } finally {
    d.close();
  }
  assert.deepEqual(splitImageRef('reg:5000/a/b:t'), { fromImage: 'reg:5000/a/b', tag: 't' });
  assert.deepEqual(splitImageRef('a/b@sha256:abc'), { fromImage: 'a/b', tag: 'sha256:abc' });
  assert.deepEqual(splitImageRef('nginx'), { fromImage: 'nginx', tag: 'latest' });
});

test('demux splits the multiplexed stream into stdout and stderr across chunk boundaries', async () => {
  const frame = (type: number, text: string) => {
    const body = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = type;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const src = new PassThrough();
  const out = new PassThrough();
  const err = new PassThrough();
  const o: string[] = [];
  const e: string[] = [];
  out.on('data', (b) => o.push(String(b)));
  err.on('data', (b) => e.push(String(b)));
  demux(src, out, err);
  const all = Buffer.concat([frame(1, 'hello'), frame(2, 'oops')]);
  src.write(all.subarray(0, 10));
  src.end(all.subarray(10));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([o.join(''), e.join('')], ['hello', 'oops']);
});

test('digest pulls strip display tags, preserve registry ports and carry credentials in the Engine header', async () => {
  const credential = { username: 'user', password: 'private-password' };
  const digest = `sha256:${'a'.repeat(64)}`;
  const d = await daemon((req, res) => {
    const url = new URL(req.url!, 'http://docker');
    assert.equal(
      url.searchParams.get('fromImage'),
      'registry.example:5000/team/app',
      'Engine pull repository must exclude the display tag while preserving the registry port',
    );
    assert.equal(
      url.searchParams.get('tag'),
      digest,
      'Engine pulls must address the pinned manifest digest',
    );
    assert.deepEqual(
      JSON.parse(Buffer.from(String(req.headers['x-registry-auth']), 'base64url').toString()),
      credential,
      'private pulls must carry credentials in the Engine auth header',
    );
    assert.ok(
      !req.url!.includes('private-password'),
      'registry credentials must stay out of request URLs',
    );
    res.end('{"status":"Downloaded"}\n');
  });
  try {
    await d.engine.pullImage(`registry.example:5000/team/app:latest@${digest}`, credential);
  } finally {
    d.close();
  }
});

test('registry auth uses padded base64url for every credential byte length', async () => {
  for (const length of [1, 2, 3]) {
    const auth = { username: 'tester', password: '🔐' + 'a'.repeat(length) };
    const expected = Buffer.from(JSON.stringify(auth))
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_');
    const d = await daemon((req, res) => {
      const encoded = String(req.headers['x-registry-auth']);
      assert.equal(
        encoded,
        expected,
        'Engine registry auth must preserve the padding required by Go base64.URLEncoding',
      );
      assert.equal(
        encoded.length % 4,
        0,
        'registry auth must contain complete four-character base64 groups',
      );
      assert.deepEqual(
        JSON.parse(Buffer.from(encoded, 'base64url').toString()),
        auth,
        'padded registry auth must preserve Unicode credentials',
      );
      res.end('{"status":"Downloaded"}\n');
    });
    try {
      await d.engine.pullImage('private.example/app:latest', auth);
    } finally {
      d.close();
    }
  }
});
