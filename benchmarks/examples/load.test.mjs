import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoad, summarize } from './load.mjs';

const list = { type: 'file-list', id: 'seed-id', name: 'seed.txt' };

test('summary reports successful throughput and nearest-rank percentiles', () => {
  const result = summarize([5, 1, 4, 2, 3], 2000, 2, 1);
  assert.equal(result.requestsPerSecond, 2.5, 'throughput must count successful responses');
  assert.equal(result.p50Ms, 3, 'p50 must use nearest rank');
  assert.equal(result.p95Ms, 5, 'p95 must use nearest rank');
  assert.equal(result.errors, 2, 'errors must remain separate from successful requests');
  assert.equal(summarize([], 1000, 0, 0).p99Ms, null, 'empty samples must not fabricate latency');
});

test('closed-loop HTTPS validates every response, handles failures, and reuses TLS connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'example-load-test-'));
  let server;
  const protocols = new Set();
  const counts = new Map();
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
    server = https.createServer(
      {
        key: await readFile(join(dir, 'key.pem')),
        cert: await readFile(join(dir, 'cert.pem')),
        minVersion: 'TLSv1.3',
      },
      (req, res) => {
        protocols.add(req.socket.getProtocol());
        counts.set(req.url, (counts.get(req.url) ?? 0) + 1);
        if (req.url === '/abort') {
          res.writeHead(200, { 'content-length': '100' });
          res.write('x');
          res.socket.destroy();
          return;
        }
        if (req.url === '/timeout') return;
        if (req.url === '/large') {
          res.end(Buffer.alloc(4 * 1024 * 1024 + 1));
          return;
        }
        if (req.url === '/status') res.statusCode = 500;
        if (req.url === '/download') return res.end('seed contents\n');
        if (req.url === '/wordpress')
          return res.end('<title>Benchmark Site</title><p>Seeded marker</p>');
        if (req.url === '/malformed') return res.end('{oops');
        if (req.url === '/wrong') return res.end('[{"id":"seed-id","name":"wrong"}]');
        res.end('[ { "name": "seed.txt", "extra": true, "id": "seed-id" } ]');
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `https://127.0.0.1:${server.address().port}`;
    const valid = await runLoad(base, 2, 0.12, list);
    assert.ok(valid.requests > 2, 'workers must repeatedly send valid requests');
    assert.equal(valid.errors, 0, 'semantically equivalent JSON must succeed');
    assert.equal(valid.connections, 2, 'workers must reuse keep-alive connections');
    assert.ok(Number.isFinite(valid.clientCpuPercent), 'client CPU usage must be recorded');
    assert.deepEqual([...protocols], ['TLSv1.3'], 'connections must use TLS 1.3');
    for (const [path, expectation] of [
      ['/download', { type: 'download', body: 'seed contents\n' }],
      ['/wordpress', { type: 'wordpress', title: 'Benchmark Site', marker: 'Seeded marker' }],
    ]) {
      const result = await runLoad(base + path, 1, 0.03, expectation);
      assert.ok(
        result.requests > 0 && result.errors === 0,
        'matching workload bodies must succeed',
      );
    }
    for (const [path, expectation] of [
      ['/status', list],
      ['/malformed', list],
      ['/wrong', list],
      ['/abort', list],
      ['/large', list],
      ['/timeout', { ...list, timeoutMs: 30 }],
      ['/download', { type: 'download', body: 'wrong' }],
      ['/wordpress', { type: 'wordpress', title: 'Benchmark Site', marker: 'missing' }],
    ]) {
      const result = await runLoad(base + path, 1, 0.02, expectation);
      assert.equal(result.requests, 0, `${path} must never count as a success`);
      assert.ok(result.errors > 0, `${path} must count an error`);
      if (path === '/timeout' || path === '/abort')
        assert.equal(
          result.errors,
          counts.get(path),
          'each aborted or timed out request must be counted once',
        );
    }
    const cli = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('./load.mjs', import.meta.url)),
        `${base}/wrong`,
        '1',
        '0.03',
        JSON.stringify(list),
      ]);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('close', (code) => resolve({ code, stdout }));
    });
    assert.equal(cli.code, 1, 'CLI must exit nonzero for invalid responses');
    assert.ok(JSON.parse(cli.stdout).errors > 0, 'CLI must report its error count as JSON');
    await assert.rejects(
      runLoad(base, 0, 1, list),
      /positive integer/,
      'zero concurrency must be rejected',
    );
    await assert.rejects(
      runLoad(base, 1, Infinity, list),
      /finite/,
      'infinite duration must be rejected',
    );
    await assert.rejects(
      runLoad('http://localhost', 1, 1, list),
      /HTTPS/,
      'non-HTTPS URLs must be rejected',
    );
    await assert.rejects(
      runLoad(base, 1, 1, {}),
      /expectation/,
      'unknown workloads must be rejected',
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
