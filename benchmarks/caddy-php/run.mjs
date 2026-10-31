import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { cases } from './cases.mjs';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('.', import.meta.url));
const duration = Number(process.env.BENCH_SECONDS ?? 10);
const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
const concurrencyLevels = (process.env.BENCH_CONCURRENCY ?? '1,32,128').split(',').map(Number);
if (
  !(duration >= 2) ||
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  concurrencyLevels.some((n) => !Number.isInteger(n) || n < 1)
) {
  throw new Error(
    'Use BENCH_SECONDS >= 2, positive integer BENCH_ROUNDS and positive integer BENCH_CONCURRENCY values',
  );
}
const names = (process.env.BENCH_CASES ?? Object.keys(cases).join(',')).split(',');
if (names.some((name) => !cases[name]))
  throw new Error('BENCH_CASES must name known benchmark cases');
const stacks = [...new Set(names.map((name) => cases[name].stack))];
const assetVolume = `tug-caddy-bench-${process.pid}-assets`;
process.env.BENCH_ASSET_VOLUME = assetVolume;
const projects = Object.fromEntries(
  stacks.map((name) => [name, `tug-caddy-bench-${process.pid}-${name}`]),
);
const args = (name, rest) => [
  'compose',
  '-p',
  projects[name],
  '-f',
  `compose.${name}.yml`,
  ...rest,
];
async function command(file, params) {
  return (await exec(file, params, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}
const compose = (name, rest) => command('docker', args(name, rest));
const services = (name) => cases[name].services;
async function resources(name) {
  return Object.fromEntries(
    await Promise.all(
      services(name).map(async (service) => {
        const output = await compose(cases[name].stack, [
          'exec',
          '-T',
          service,
          'cat',
          '/sys/fs/cgroup/cpu.stat',
          '/sys/fs/cgroup/memory.current',
        ]);
        return [
          service,
          {
            cpuUsec: Number(output.match(/^usage_usec (\d+)/m)[1]),
            memoryBytes: Number(output.split('\n').at(-1)),
          },
        ];
      }),
    ),
  );
}
function load(name, concurrency, seconds) {
  const { target, stack } = cases[name];
  return args(stack, [
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'load',
    `https://${target}/`,
    String(concurrency),
    String(seconds),
  ]);
}
async function measuredLoad(name, concurrency) {
  const before = await resources(name);
  const child = spawn('docker', load(name, concurrency, duration), {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} load failed: ${stdout}\n${stderr}`)),
    );
  });
  const middle = await Promise.race([
    setTimeout(duration * 500).then(() => resources(name)),
    finished.then(() => resources(name)),
  ]);
  await finished;
  const after = await resources(name);
  const result = JSON.parse(stdout.trim());
  result.services = Object.fromEntries(
    services(name).map((service) => [
      service,
      {
        cpuSeconds: (after[service].cpuUsec - before[service].cpuUsec) / 1e6,
        sampledMemoryMiB: middle[service].memoryBytes / 1024 ** 2,
      },
    ]),
  );
  result.cpuUsecPerRequest =
    Object.values(result.services).reduce((sum, value) => sum + value.cpuSeconds * 1e6, 0) /
    result.requests;
  return result;
}

const report = {
  timestamp: new Date().toISOString(),
  duration,
  rounds,
  concurrencyLevels,
  cases: Object.fromEntries(names.map((name) => [name, cases[name]])),
  assetStorage: 'shared native Docker volume, mounted read-only in application containers',
  docker: JSON.parse(await command('docker', ['info', '--format', '{{json .}}'])),
  runs: [],
};
// Keep only environment details relevant to interpreting the results.
report.docker = Object.fromEntries(
  [
    'ServerVersion',
    'OperatingSystem',
    'Architecture',
    'NCPU',
    'MemTotal',
    'ContainersRunning',
    'KernelVersion',
  ].map((key) => [key, report.docker[key]]),
);
try {
  await command('docker', ['volume', 'create', assetVolume]);
  await command('docker', [
    'run',
    '--rm',
    '--mount',
    `type=volume,source=${assetVolume},target=/app`,
    '--mount',
    `type=bind,source=${cwd}index.php,target=/input.php,readonly`,
    '--mount',
    `type=bind,source=${cwd}index.html,target=/input.html,readonly`,
    '--entrypoint',
    'node',
    'node:24-alpine',
    '-e',
    "const fs=require('node:fs');fs.copyFileSync('/input.php','/app/index.php');fs.copyFileSync('/input.html','/app/index.html')",
  ]);
  await mkdir(`${cwd}certs`, { recursive: true });
  await command('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'certs/key.pem',
    '-out',
    'certs/cert.pem',
    '-days',
    '2',
    '-subj',
    '/CN=benchmark',
    '-addext',
    'subjectAltName=DNS:benchmark',
  ]);
  for (const name of stacks) {
    console.log(`Starting ${name}`);
    await compose(name, ['--profile', 'load', 'pull']);
    await compose(name, ['up', '-d', '--wait']);
  }
  for (const name of names) {
    for (let attempt = 0; ; attempt++) {
      try {
        await command('docker', load(name, 1, 0.2));
        break;
      } catch (error) {
        if (attempt >= 9) throw error;
        await setTimeout(1000);
      }
    }
  }
  report.images = JSON.parse(
    await command('docker', [
      'image',
      'inspect',
      'nginx:stable-alpine',
      'php:8.4-fpm-alpine',
      'caddy:2-alpine',
      'node:24-alpine',
    ]),
  ).map(({ Id, RepoTags, RepoDigests }) => ({ Id, RepoTags, RepoDigests }));
  report.versions = {
    nginx: await command('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      'nginx:stable-alpine',
      '-c',
      'nginx -v 2>&1',
    ]),
    php: await command('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'php',
      'php:8.4-fpm-alpine',
      '-v',
    ]),
    caddy: await command('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'caddy',
      'caddy:2-alpine',
      'version',
    ]),
    load: await compose(stacks[0], [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      'load',
      '--version',
    ]),
  };
  for (const concurrency of concurrencyLevels) {
    for (let round = 1; round <= rounds; round++) {
      for (const name of round % 2 ? names : [...names].reverse()) {
        await command('docker', load(name, concurrency, 2));
        const result = await measuredLoad(name, concurrency);
        report.runs.push({ name, concurrency, round, ...result });
        console.log(
          `${name} c=${concurrency} round=${round}: ${result.requestsPerSecond.toFixed(0)} req/s, p50=${result.p50Ms.toFixed(3)}ms p95=${result.p95Ms.toFixed(3)}ms, CPU=${result.cpuUsecPerRequest.toFixed(0)}us/req, clientCPU=${result.clientCpuPercent.toFixed(0)}%, errors=${result.errors}`,
        );
      }
    }
  }
  await mkdir(`${cwd}results`, { recursive: true });
  const output = `${cwd}results/${report.timestamp.replace(/[:.]/g, '-')}.json`;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${output}`);
} finally {
  for (const name of stacks)
    await compose(name, ['down', '--volumes', '--remove-orphans']).catch((error) =>
      console.error(error.message),
    );
  await command('docker', ['volume', 'rm', assetVolume]).catch((error) =>
    console.error(error.message),
  );
}
