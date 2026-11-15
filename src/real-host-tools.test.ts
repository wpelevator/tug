import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// The measurement scripts in tools/scripts (bench-ingress, sample-docker-stats, probe-loop) are plain Node.js. The
// parsing and reporting are tested on sample output. ab-clean.txt and ab-failed.txt are real ApacheBench 2.3 runs
// against a local server (the second one closes connections and varies the body length); docker-stats.jsonl follows
// the `docker stats --format '{{json .}}'` shape and was written by hand. The SSH parts take their runner as an argument.

const lib = await import(new URL('../tools/scripts/real-host-lib.mjs', import.meta.url).href);
const bench = await import(new URL('../tools/scripts/bench-ingress.mjs', import.meta.url).href);
const probeScript = await import(new URL('../tools/scripts/probe-loop.mjs', import.meta.url).href);

const fixture = (name: string) =>
  fs.readFileSync(new URL(`../tests/fixtures/real-host/${name}`, import.meta.url), 'utf8');

type Run = { status: number; stdout: string; stderr: string };
const ok = (stdout: string): Run => ({ status: 0, stdout, stderr: '' });

test('parseAb reads throughput, latency and percentiles from an ab report', () => {
  const clean = lib.parseAb(fixture('ab-clean.txt'));
  assert.equal(clean.complete, 2000, 'complete requests should be read');
  assert.equal(clean.failed, 0, 'a clean run should report no failed requests');
  assert.equal(clean.breakdown, undefined, 'ab prints no breakdown when nothing failed');
  assert.equal(clean.requestsPerSecond, 6610.46, 'requests per second should be the mean figure');
  assert.equal(
    clean.meanMs,
    1.513,
    'mean latency should be the per-request figure, not the across-concurrency one',
  );
  assert.equal(clean.p99Ms, 16, 'p99 should come from the percentile table');
  assert.equal(clean.longestMs, 67, 'the longest request should come from the 100% row');
});

test('parseAb keeps the failure breakdown so failed requests can be classified', () => {
  const failed = lib.parseAb(fixture('ab-failed.txt'));
  assert.equal(failed.failed, 1346, 'failed requests should be counted');
  assert.deepEqual(
    failed.breakdown,
    { connect: 0, receive: 0, length: 1346, exceptions: 0 },
    'the Connect, Receive, Length and Exceptions counts should be kept',
  );
});

test('the ingress benchmark drives ab on the load host for every direct and proxied URL and saves each output', async () => {
  const calls: { host: string; command: string }[] = [];
  const saved: Record<string, string> = {};
  const rows = await lib.benchmarkIngress({
    runner: async (host: string, command: string) => {
      calls.push({ host, command });
      return ok(command.includes('proxy') ? fixture('ab-failed.txt') : fixture('ab-clean.txt'));
    },
    loadHost: '203.0.113.10',
    targets: [
      { name: 'app', direct: 'http://10.0.0.4:8080/health', proxied: 'https://proxy.test/health' },
    ],
    concurrencies: [10, 50],
    requests: 20000,
    onOutput: (name: string, raw: string) => (saved[name] = raw),
  });
  assert.deepEqual(
    calls.map((c) => c.host),
    Array(4).fill('203.0.113.10'),
    'every ab run should go to the load host',
  );
  assert.equal(
    calls[0].command,
    "ab -k -n 20000 -c 10 'http://10.0.0.4:8080/health'",
    'ab should run with keep-alive, the request count, the concurrency and the quoted URL',
  );
  assert.deepEqual(
    Object.keys(saved),
    ['app-c10-direct', 'app-c10-proxied', 'app-c50-direct', 'app-c50-proxied'],
    'the full output of every run should be handed over for saving',
  );
  assert.equal(
    saved['app-c10-proxied'],
    fixture('ab-failed.txt'),
    'the saved output should be ab untouched',
  );
  assert.equal(rows[0].direct.output, undefined, 'summary rows should not carry the raw output');
  const table = lib.formatIngressTable(rows);
  assert.match(
    table,
    /6,610 rps/,
    'the table should show direct throughput with thousands separators',
  );
  assert.match(table, /7,386 rps/, 'the table should show proxied throughput');
  assert.match(table, /1\.5 → 1\.4/, 'the table should show mean latency direct then proxied');
  assert.match(table, /16 → 18/, 'the table should show p99 direct then proxied');
  assert.deepEqual(
    lib.classifyFailures(rows),
    [
      'app c10 proxied: 1346 failed of 2000 (connect 0, receive 0, length 1346, exceptions 0), 0 non-2xx',
      'app c50 proxied: 1346 failed of 2000 (connect 0, receive 0, length 1346, exceptions 0), 0 non-2xx',
    ],
    'failed requests should be classified from the breakdown, per run',
  );
});

test('an ab failure is reported with its stderr instead of an empty table', async () => {
  await assert.rejects(
    lib.runAb(async () => ({ status: 127, stdout: '', stderr: 'ab: command not found' }), 'h', {
      url: 'http://x/',
      requests: 1,
      concurrency: 1,
    }),
    /exit 127\): ab: command not found/,
    'a missing ab binary should surface its message',
  );
});

test('parseTarget splits name, direct URL and proxied URL', () => {
  assert.deepEqual(
    bench.parseTarget('express=http://10.0.0.4:8080/health,https://e.example.com/health'),
    {
      name: 'express',
      direct: 'http://10.0.0.4:8080/health',
      proxied: 'https://e.example.com/health',
    },
    'a target should carry both URLs',
  );
  assert.throws(
    () => bench.parseTarget('express=http://only-one'),
    /name=directUrl,proxiedUrl/,
    'a target needs two URLs',
  );
});

test('docker stats parsing keeps only the tug agent, Caddy and control containers', () => {
  const rows = lib.parseDockerStats(fixture('docker-stats.jsonl'));
  assert.equal(rows.length, 4, 'every line should be parsed');
  assert.deepEqual(
    rows.map((r: { name: string; component?: string }) => [r.name, r.component]),
    [
      ['tug-agent', 'agent'],
      ['tug-caddy', 'caddy'],
      ['express-web-1', undefined],
      ['tug-control-control-1', 'control'],
    ],
    'only the three tug containers should be classified',
  );
  assert.equal(rows[0].cpu, 0.52, 'CPU percent should be a number');
  assert.equal(
    rows[0].memBytes,
    50.5 * 1024 ** 2,
    'memory should be the used part of MemUsage in bytes',
  );
  assert.equal(lib.parseSize('1.5GiB'), 1.5 * 1024 ** 3, 'GiB should be binary');
  assert.equal(lib.parseSize('2MB'), 2e6, 'MB should be decimal');
});

test('stats sampling reads every host each interval and summarizes average and peak per component', async () => {
  const seen: string[] = [];
  const waits: number[] = [];
  let tick = 0;
  const readings = await lib.sampleStats({
    runner: async (host: string, command: string) => {
      seen.push(`${host}: ${command}`);
      const cpu = tick++ % 2 === 0 ? '1.00%' : '3.00%';
      return ok(
        `{"Name":"tug-agent","CPUPerc":"${cpu}","MemUsage":"50MiB / 2GiB"}\n{"Name":"other","CPUPerc":"9%","MemUsage":"1MiB / 2GiB"}\n`,
      );
    },
    hosts: ['n1'],
    samples: 2,
    intervalMs: 500,
    wait: async (ms: number) => void waits.push(ms),
  });
  assert.deepEqual(waits, [500], 'one wait should separate two samples');
  assert.equal(seen.length, 2, 'each sample should run docker stats once per host');
  assert.match(
    seen[0],
    /docker stats --no-stream/,
    'the sampler should run docker stats without streaming',
  );
  const [summary] = lib.summarizeStats(readings);
  assert.deepEqual(
    [
      summary.host,
      summary.component,
      summary.samples,
      summary.cpuAvg,
      summary.cpuPeak,
      summary.memAvgMiB,
      summary.memPeakMiB,
    ],
    ['n1', 'agent', 2, 2, 3, 50, 50],
    'average and peak CPU and memory should be computed per host and component',
  );
  assert.match(
    lib.formatStatsTable([summary]),
    /agent\s+n1\s+2\s+2\.00\s+3\.00\s+50\.0\s+50\.0/,
    'the table should list the figures',
  );
  await assert.rejects(
    lib.sampleStats({
      runner: async () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
      hosts: ['n1'],
      samples: 1,
      intervalMs: 0,
    }),
    /docker stats failed on n1 \(exit 1\): permission denied/,
    'a failing host should be named in the error',
  );
});

test('the runner passes the key, user and command to ssh, and runs `local` in the local shell', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const fakeSpawn = (file: string, args: string[]) => {
    calls.push({ file, args });
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', 'out');
      child.emit('close', 0);
    });
    return child;
  };
  const runner = lib.createRunner({ key: '/k', user: 'deploy', spawnImpl: fakeSpawn });
  const result = await runner('203.0.113.9', 'uptime');
  assert.equal(result.stdout, 'out', 'the runner should return the command output');
  assert.deepEqual(
    calls[0].args.slice(-3),
    ['-i', '/k', 'deploy@203.0.113.9', 'uptime'].slice(-3),
    'ssh should get the key, user@host and the command last',
  );
  assert.ok(calls[0].args.includes('BatchMode=yes'), 'ssh should never prompt for a password');
  const local = await lib.createRunner().call(null, 'local', 'echo hi');
  assert.equal(local.stdout.trim(), 'hi', 'the host `local` should run in this machine shell');
  assert.equal(
    lib.shellQuote("a'b"),
    `'a'\\''b'`,
    'single quotes in a value should be escaped for the shell',
  );
});

test('probeWhile counts probes, non-200 responses, versions and maximum latency while the work runs', async () => {
  const replies = [
    { status: 200, body: 'v1', ms: 4 },
    { status: 200, body: 'v1', ms: 9 },
    { status: 502, body: 'bad gateway', ms: 30 },
    { status: 200, body: 'v2', ms: 5 },
  ];
  let i = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const result = await lib.probeWhile({
    work: async () => {
      await gate;
      return 'done';
    },
    probe: async () => {
      const reply = replies[i++];
      if (!reply) throw new Error('connection refused');
      if (i === replies.length) release();
      return reply;
    },
    url: 'http://x/',
    intervalMs: 0,
    wait: async () => {},
  });
  assert.equal(result.work, 'done', 'the work result should be returned');
  const summary = lib.summarizeProbes(result.probes);
  assert.equal(
    summary.non200,
    summary.probes - 3,
    'every probe except the three 200s should be a non-200',
  );
  assert.equal(summary.statuses[502], 1, 'a 502 should be counted by status');
  assert.deepEqual(
    summary.versions,
    { v1: 2, v2: 1 },
    'only 200 responses should count toward the version distribution',
  );
  assert.equal(summary.maxMs, 30, 'the maximum latency should be the slowest probe');
  assert.match(
    lib.formatProbeSummary(summary),
    /versions: v1: 2, v2: 1/,
    'the report should list the version split',
  );
});

test('a thrown probe error is a failed probe with status 0', async () => {
  const result = await lib.probeWhile({
    work: async () => 'x',
    probe: async () => {
      throw new Error('ECONNREFUSED');
    },
    url: 'http://x/',
    intervalMs: 0,
    wait: async () => {},
  });
  assert.ok(result.probes.length >= 1, 'the loop should probe at least once');
  assert.equal(
    lib.summarizeProbes(result.probes).statuses[0],
    result.probes.length,
    'errors should count under status 0',
  );
});

test('probe-loop.mjs probes a local server while its command runs and prints the report', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end(hits < 5 ? 'version: 1' : 'version: 2');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(
      (await probeScript.httpProbe(`http://127.0.0.1:${port}/`)).status,
      200,
      'httpProbe should return the status of a local server',
    );
    const script = new URL('../tools/scripts/probe-loop.mjs', import.meta.url).pathname;
    const result = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const p = spawn(
        process.execPath,
        [
          script,
          '--url',
          `http://127.0.0.1:${port}/`,
          '--interval-ms',
          '20',
          '--version-pattern',
          'version: (\\d+)',
          '--',
          process.execPath,
          '-e',
          'setTimeout(() => {}, 400)',
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let stdout = '';
      p.stdout.on('data', (c) => (stdout += c));
      p.on('close', (status) => resolve({ status, stdout }));
    });
    assert.equal(result.status, 0, 'the script should exit 0 when its command succeeds');
    assert.match(
      result.stdout,
      /command exit status: 0/,
      'the report should state the command status',
    );
    assert.match(
      result.stdout,
      /non-200: 0/,
      'a healthy local server should have no non-200 probes',
    );
    assert.match(
      result.stdout,
      /versions: 1: \d+, 2: \d+/,
      'both versions should be counted when the response changes',
    );
  } finally {
    server.close();
  }
});

test('versionFrom extracts the first capture group and marks other bodies as unmatched', () => {
  assert.equal(
    probeScript.versionFrom('v=(\\w+)')('v=abc'),
    'abc',
    'the capture group should be the version',
  );
  assert.equal(
    probeScript.versionFrom('v=(\\w+)')('nothing'),
    'unmatched',
    'a body without a match should be labelled unmatched',
  );
});
