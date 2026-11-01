import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad, summarize } from './load.mjs';
import { cases } from './cases.mjs';
import * as yaml from 'js-yaml';

test('summary reports nearest-rank percentiles and successful throughput', () => {
  const result = summarize([5, 1, 4, 2, 3], 2000, 2, 1);
  assert.equal(
    result.requestsPerSecond,
    2.5,
    'throughput must count successful responses over elapsed seconds',
  );
  assert.equal(result.meanMs, 3, 'mean must include every successful response');
  assert.equal(result.p50Ms, 3, 'p50 must be the nearest-rank median');
  assert.equal(result.p95Ms, 5, 'p95 must select the upper observed sample');
  assert.equal(result.errors, 2, 'errors must be preserved independently of successes');
  assert.equal(
    summarize([], 1000, 1, 1).p50Ms,
    null,
    'empty samples must not fabricate latency values',
  );
});

test('HTTPS load validates timestamp responses, reuses connections, and detects HTTP and body errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caddy-load-test-'));
  const hosts = new Set();
  const protocols = new Set();
  let server;
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
        '/CN=benchmark',
      ],
      { stdio: 'ignore' },
    );
    server = https.createServer(
      {
        key: await readFile(join(dir, 'key.pem')),
        cert: await readFile(join(dir, 'cert.pem')),
        minVersion: 'TLSv1.3',
      },
      (request, response) => {
        hosts.add(request.headers.host);
        protocols.add(request.socket.getProtocol());
        if (request.url === '/status') response.statusCode = 500;
        response.end(
          request.url === '/body'
            ? 'invalid'
            : `${new Date().toISOString().replace('Z', '000Z')}\n`,
        );
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${server.address().port}`;
    const valid = await runLoad(`${url}/`, 2, 0.15);
    assert.equal(valid.errors, 0, 'valid HTTPS timestamp responses must have no errors');
    assert.ok(valid.requests > 2, 'workers must issue repeated requests');
    assert.equal(valid.connections, 2, 'each worker must reuse its TLS connection');
    assert.ok(
      Number.isFinite(valid.clientCpuPercent) && valid.clientCpuPercent > 0,
      'client CPU must be measured so load-generator saturation is visible',
    );
    assert.deepEqual(
      [...hosts],
      ['benchmark'],
      'the HTTP Host must match the Caddy virtual host independently of the target address',
    );
    assert.deepEqual([...protocols], ['TLSv1.3'], 'both benchmark paths must use TLS 1.3');
    for (const path of ['/status', '/body']) {
      const invalid = await runLoad(`${url}${path}`, 1, 0.05);
      assert.equal(invalid.requests, 0, 'invalid status or body must never count as success');
      assert.ok(invalid.errors > 0, 'invalid status or body must register errors');
    }
    await assert.rejects(
      runLoad(url, 0, 1),
      /positive integer/,
      'zero concurrency must be rejected',
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('PHP cases share the same backend and static cases have no PHP service in their request path', async () => {
  const compose = {};
  for (const stack of new Set(Object.values(cases).map((entry) => entry.stack))) {
    compose[stack] = yaml.load(
      await readFile(new URL(`compose.${stack}.yml`, import.meta.url), 'utf8'),
    );
  }
  for (const entry of Object.values(cases)) {
    assert.ok(
      compose[entry.stack].services[entry.target],
      'each benchmark target must exist in its Compose stack',
    );
    if (entry.workload === 'static' && entry.target !== 'caddy') {
      assert.ok(
        compose[entry.stack].services[entry.target].volumes.includes('assets:/app:ro'),
        'file servers must read application assets from native Docker storage',
      );
    }
    for (const service of entry.services) {
      assert.ok(
        compose[entry.stack].services[service],
        'each measured service must exist in its Compose stack',
      );
    }
    if (entry.workload === 'php') {
      assert.deepEqual(
        compose[entry.stack].services.php,
        compose.direct.services.php,
        'every PHP case must use identical PHP image and configuration',
      );
      assert.ok(
        compose[entry.stack].services.php.volumes.includes('assets:/app:ro'),
        'PHP must read application assets from native Docker storage',
      );
    } else {
      assert.equal(
        compose[entry.stack].services.php,
        undefined,
        'static stacks must run without PHP-FPM',
      );
    }
  }
  assert.deepEqual(
    compose.direct.services.nginx,
    compose.proxy.services.nginx,
    'direct and proxied PHP cases must share identical nginx configuration',
  );
  const staticBody = await readFile(new URL('index.html', import.meta.url), 'utf8');
  assert.match(
    staticBody,
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z\n$/,
    'the static body must have the same timestamp format and length as PHP responses',
  );
});
