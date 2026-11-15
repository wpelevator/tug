// Shared parts of the real-host measurement scripts (bench-ingress.mjs, sample-docker-stats.mjs, probe-loop.mjs): a
// command runner over SSH or the local shell, and parsers and reports for ApacheBench and `docker stats` output.
// Every function that touches a machine takes its runner as an argument, so tests replace it with a fake.
import { spawn } from 'node:child_process';

/** @typedef {{ status: number, stdout: string, stderr: string }} RunResult */
/** @typedef {(host: string, command: string) => Promise<RunResult>} Runner */

export const LOCAL = 'local';

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * A runner for `host`: the literal `local` runs the command in the local shell, anything else runs it over `ssh`.
 * @param {{ key?: string, user?: string, ssh?: string, spawnImpl?: typeof spawn }} [options]
 * @returns {Runner}
 */
export function createRunner({ key, user = 'root', ssh = 'ssh', spawnImpl = spawn } = {}) {
  return (host, command) =>
    new Promise((resolve, reject) => {
      const [file, args] =
        host === LOCAL
          ? ['sh', ['-c', command]]
          : [
              ssh,
              [
                '-o',
                'BatchMode=yes',
                '-o',
                'ConnectTimeout=10',
                ...(key ? ['-i', key] : []),
                host.includes('@') ? host : `${user}@${host}`,
                command,
              ],
            ];
      const child = spawnImpl(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const number = (text) => (text === undefined ? undefined : Number(text.replaceAll(',', '')));

/**
 * The figures of one ApacheBench report. `failed` is "Failed requests"; `breakdown` is its parenthesized
 * "(Connect: 0, Receive: 3, Length: 4, Exceptions: 3)" split, present only when ab printed it.
 */
export function parseAb(text) {
  const field = (label) => new RegExp(`^${label}:\\s+([\\d.]+)`, 'm').exec(text)?.[1];
  const breakdownText =
    /\(Connect:\s*(\d+),\s*Receive:\s*(\d+),\s*Length:\s*(\d+),\s*Exceptions:\s*(\d+)\)/.exec(text);
  const percentile = (p) => number(new RegExp(`^\\s*${p}%\\s+(\\d+)`, 'm').exec(text)?.[1]);
  return {
    concurrency: number(field('Concurrency Level')),
    complete: number(field('Complete requests')),
    failed: number(field('Failed requests')) ?? 0,
    breakdown: breakdownText
      ? {
          connect: Number(breakdownText[1]),
          receive: Number(breakdownText[2]),
          length: Number(breakdownText[3]),
          exceptions: Number(breakdownText[4]),
        }
      : undefined,
    non2xx: number(field('Non-2xx responses')) ?? 0,
    requestsPerSecond: number(field('Requests per second')),
    meanMs: number(/^Time per request:\s+([\d.]+) \[ms\] \(mean\)$/m.exec(text)?.[1]),
    p50Ms: percentile(50),
    p99Ms: percentile(99),
    longestMs: number(/^\s*100%\s+(\d+)/m.exec(text)?.[1]),
  };
}

/** Fixed-width text table; numbers and text are left as given. */
export function formatTable(headers, rows) {
  const all = [headers, ...rows].map((row) => row.map(String));
  const widths = headers.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(all[0]), line(widths.map((w) => '-'.repeat(w))), ...all.slice(1).map(line)].join(
    '\n',
  );
}

const fixed = (value, digits) => (value === undefined ? 'n/a' : value.toFixed(digits));
const thousands = (value) =>
  value === undefined ? 'n/a' : Math.round(value).toLocaleString('en-US');

/**
 * Drive `ab` on `loadHost` once for a URL and return the parsed figures with ab's full output. A non-zero exit is an
 * error that carries ab's stderr and stdout.
 */
export async function runAb(runner, loadHost, { url, requests, concurrency, keepAlive = true }) {
  const command = ['ab', keepAlive ? '-k' : '', '-n', requests, '-c', concurrency, shellQuote(url)]
    .filter((part) => part !== '')
    .join(' ');
  const result = await runner(loadHost, command);
  if (result.status !== 0)
    throw new Error(
      `ab failed for ${url} (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return { ...parseAb(result.stdout), url, output: result.stdout };
}

/**
 * Run each target's direct and proxied URL at each concurrency and collect the results. `onOutput(name, raw)` receives
 * ab's full output, so a failed request can be classified later.
 */
export async function benchmarkIngress({
  runner,
  loadHost,
  targets,
  concurrencies,
  requests,
  onOutput = () => {},
}) {
  const rows = [];
  for (const target of targets) {
    for (const concurrency of concurrencies) {
      const row = { name: target.name, concurrency };
      for (const kind of ['direct', 'proxied']) {
        const run = await runAb(runner, loadHost, { url: target[kind], requests, concurrency });
        onOutput(`${target.name}-c${concurrency}-${kind}`, run.output);
        row[kind] = { ...run, output: undefined };
      }
      rows.push(row);
    }
  }
  return rows;
}

/** The evaluation's table: throughput, mean latency and p99, direct then through the proxy. */
export function formatIngressTable(rows) {
  const pair = (a, b) => `${a} → ${b}`;
  return formatTable(
    [
      'Target',
      'Concurrency',
      'Direct',
      'Proxied',
      'Mean ms',
      'p99 ms',
      'Failed (direct / proxied)',
    ],
    rows.map(({ name, concurrency, direct, proxied }) => [
      name,
      concurrency,
      `${thousands(direct.requestsPerSecond)} rps`,
      `${thousands(proxied.requestsPerSecond)} rps`,
      pair(fixed(direct.meanMs, 1), fixed(proxied.meanMs, 1)),
      pair(direct.p99Ms ?? 'n/a', proxied.p99Ms ?? 'n/a'),
      `${direct.failed} / ${proxied.failed}`,
    ]),
  );
}

/** One line per run with failed requests, using ab's own breakdown so the cause is named. */
export function classifyFailures(rows) {
  const lines = [];
  for (const { name, concurrency, direct, proxied } of rows)
    for (const [kind, run] of [
      ['direct', direct],
      ['proxied', proxied],
    ]) {
      if (!run.failed && !run.non2xx) continue;
      const b = run.breakdown;
      const detail = b
        ? `connect ${b.connect}, receive ${b.receive}, length ${b.length}, exceptions ${b.exceptions}`
        : 'ab printed no breakdown';
      lines.push(
        `${name} c${concurrency} ${kind}: ${run.failed} failed of ${run.complete} (${detail}), ${run.non2xx} non-2xx`,
      );
    }
  return lines;
}

const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1e3, mb: 1e6, gb: 1e9 };

/** `49.5MiB` to bytes. */
export function parseSize(text) {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  if (!match) throw new Error(`cannot read size ${JSON.stringify(text)}`);
  const unit = UNITS[match[2].toLowerCase()];
  if (unit === undefined) throw new Error(`unknown size unit in ${JSON.stringify(text)}`);
  return Number(match[1]) * unit;
}

/** The tug container a `docker stats` name belongs to, as `docker run --name` and `control setup` create them. */
export function classifyContainer(name) {
  if (name === 'tug-agent') return 'agent';
  if (name === 'tug-caddy') return 'caddy';
  if (name.startsWith('tug-control')) return 'control';
  return undefined;
}

/** Parse `docker stats --no-stream --format '{{json .}}'` output into {name, component, cpu, memBytes} rows. */
export function parseDockerStats(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      const row = JSON.parse(line);
      return {
        name: row.Name,
        component: classifyContainer(row.Name),
        cpu: Number.parseFloat(row.CPUPerc),
        memBytes: parseSize(row.MemUsage.split('/')[0]),
      };
    });
}

export const STATS_COMMAND = "docker stats --no-stream --format '{{json .}}'";

/** Take `samples` readings `intervalMs` apart on each host and return the tug containers' readings. */
export async function sampleStats({ runner, hosts, samples, intervalMs, wait = sleep }) {
  const readings = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await wait(intervalMs);
    await Promise.all(
      hosts.map(async (host) => {
        const result = await runner(host, STATS_COMMAND);
        if (result.status !== 0)
          throw new Error(
            `docker stats failed on ${host} (exit ${result.status}): ${result.stderr.trim()}`,
          );
        for (const row of parseDockerStats(result.stdout))
          if (row.component) readings.push({ host, sample: i, ...row });
      }),
    );
  }
  return readings;
}

/** Average and peak CPU and memory per host and component. */
export function summarizeStats(readings) {
  const groups = new Map();
  for (const reading of readings) {
    const key = `${reading.host}\u0000${reading.component}`;
    if (!groups.has(key))
      groups.set(key, { host: reading.host, component: reading.component, rows: [] });
    groups.get(key).rows.push(reading);
  }
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  return [...groups.values()]
    .map(({ host, component, rows }) => ({
      host,
      component,
      samples: rows.length,
      cpuAvg: mean(rows.map((r) => r.cpu)),
      cpuPeak: Math.max(...rows.map((r) => r.cpu)),
      memAvgMiB: mean(rows.map((r) => r.memBytes)) / 1024 ** 2,
      memPeakMiB: Math.max(...rows.map((r) => r.memBytes)) / 1024 ** 2,
    }))
    .sort((a, b) => a.component.localeCompare(b.component) || a.host.localeCompare(b.host));
}

export function formatStatsTable(summary) {
  return formatTable(
    ['Component', 'Host', 'Samples', 'CPU avg %', 'CPU peak %', 'Mem avg MiB', 'Mem peak MiB'],
    summary.map((s) => [
      s.component,
      s.host,
      s.samples,
      s.cpuAvg.toFixed(2),
      s.cpuPeak.toFixed(2),
      s.memAvgMiB.toFixed(1),
      s.memPeakMiB.toFixed(1),
    ]),
  );
}

/**
 * Request `url` every `intervalMs` through `probe` while `work` runs, then take one more probe. `probe(url)` returns
 * {status, body, ms}; a thrown error counts as status 0. `version` extracts a version label from a response body.
 */
export async function probeWhile({
  work,
  probe,
  url,
  intervalMs,
  version = (body) => body.trim().slice(0, 40),
  wait = sleep,
}) {
  const probes = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const started = Date.now();
      try {
        const reply = await probe(url);
        probes.push({
          status: reply.status,
          ms: reply.ms,
          version: reply.status === 200 ? version(reply.body) : undefined,
        });
      } catch (error) {
        probes.push({
          status: 0,
          ms: Date.now() - started,
          error: String(error?.message ?? error),
        });
      }
      await wait(intervalMs);
    }
  })();
  let result;
  let failure;
  try {
    result = await work();
  } catch (error) {
    failure = error;
  }
  running = false;
  await loop;
  return { probes, work: result, failure };
}

/** Probe count, non-200 count, version distribution and maximum latency. */
export function summarizeProbes(probes) {
  const versions = {};
  for (const p of probes)
    if (p.version !== undefined) versions[p.version] = (versions[p.version] ?? 0) + 1;
  const statuses = {};
  for (const p of probes) if (p.status !== 200) statuses[p.status] = (statuses[p.status] ?? 0) + 1;
  return {
    probes: probes.length,
    non200: probes.filter((p) => p.status !== 200).length,
    statuses,
    versions,
    maxMs: probes.length ? Math.max(...probes.map((p) => p.ms)) : 0,
  };
}

export function formatProbeSummary(summary) {
  const versions = Object.entries(summary.versions)
    .map(([v, n]) => `${v}: ${n}`)
    .join(', ');
  const statuses = Object.entries(summary.statuses)
    .map(([s, n]) => `${s}: ${n}`)
    .join(', ');
  return [
    `probes: ${summary.probes}`,
    `non-200: ${summary.non200}${statuses ? ` (${statuses})` : ''}`,
    `versions: ${versions || 'none'}`,
    `max latency: ${summary.maxMs} ms`,
  ].join('\n');
}
