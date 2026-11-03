import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { cases } from './cases.mjs';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
const seedBody = 'pad-launch benchmark fixture\n';
const seedName = 'benchmark.txt';

export function configFromEnv(env = process.env) {
  const seconds = Number(env.BENCH_SECONDS ?? 10);
  const rounds = Number(env.BENCH_ROUNDS ?? 3);
  const concurrency = (env.BENCH_CONCURRENCY ?? '1,16').split(',').map(Number);
  const stacks = (env.BENCH_STACKS ?? Object.keys(cases).join(',')).split(',').map((s) => s.trim());
  if (
    !Number.isFinite(seconds) ||
    seconds < 2 ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    concurrency.some((n) => !Number.isInteger(n) || n < 1) ||
    new Set(concurrency).size !== concurrency.length
  )
    throw new Error(
      'BENCH_SECONDS must be at least 2; BENCH_ROUNDS and unique BENCH_CONCURRENCY values must be positive integers',
    );
  if (stacks.some((s) => !cases[s]) || new Set(stacks).size !== stacks.length)
    throw new Error('BENCH_STACKS must contain unique known stack names');
  return { seconds, rounds, concurrency, stacks };
}

export function composeArgs(project, stack, args) {
  return ['compose', '-p', project, '-f', 'compose.yml', '-f', `compose.${stack}.yml`, ...args];
}

export function workloadDefinitions(stack, id) {
  if (stack === 'wordpress')
    return [
      {
        name: 'homepage',
        path: '/',
        expectation: { type: 'wordpress', title: 'Benchmark Site', marker: 'Hello world!' },
      },
    ];
  return [
    {
      name: 'cached-files',
      path: '/files',
      expectation: { type: 'file-list', id, name: seedName },
    },
    { name: 'download', path: `/files/${id}`, expectation: { type: 'download', body: seedBody } },
  ];
}

function* measurementOrder(config, workloads) {
  for (const concurrency of config.concurrency) {
    for (let round = 1; round <= config.rounds; round++) {
      for (const workload of round % 2 ? workloads : [...workloads].reverse()) {
        yield { concurrency, round, workload };
      }
    }
  }
}

const seedScript = `
const https = require('node:https');
const request = (method, path, body, headers={}) => new Promise((resolve, reject) => {
  const req = https.request('https://caddy'+path, {method, rejectUnauthorized:false, headers}, res => {
    const chunks=[]; res.on('data', c=>chunks.push(c)); res.on('error', reject);
    res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  }); req.on('error',reject); req.setTimeout(5000,()=>req.destroy(new Error('request timeout'))); req.end(body);
});
(async()=>{
  const boundary='pad-launch-benchmark-boundary';
  const body='--'+boundary+'\\r\\nContent-Disposition: form-data; name="file"; filename="benchmark.txt"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\npad-launch benchmark fixture\\n\\r\\n--'+boundary+'--\\r\\n';
  const upload=await request('POST','/files',body,{'content-type':'multipart/form-data; boundary='+boundary,'content-length':Buffer.byteLength(body)});
  if(upload.status!==201) throw new Error('upload: '+JSON.stringify(upload));
  const row=JSON.parse(upload.body); if(typeof row.id!=='string' || !/^[a-f0-9-]{36}$/i.test(row.id) || row.name!=='benchmark.txt') throw new Error('unexpected upload: '+upload.body);
  const list=await request('GET','/files'); if(list.status!==200 || !JSON.parse(list.body).some(x=>x.id===row.id && x.name===row.name)) throw new Error('list: '+JSON.stringify(list));
  const download=await request('GET','/files/'+row.id); if(download.status!==200 || download.body!=='pad-launch benchmark fixture\\n') throw new Error('download: '+JSON.stringify(download));
  process.stdout.write(JSON.stringify(row));
})().catch(e=>{console.error(e);process.exitCode=1});`;
const readinessScript = `const https=require('node:https'); const r=https.get('https://caddy'+process.argv[1],{rejectUnauthorized:false},s=>{s.resume();s.on('end',()=>{if(s.statusCode!==200)process.exitCode=1})});r.setTimeout(3000,()=>r.destroy());r.on('error',e=>{console.error(e.message);process.exitCode=1});`;

async function command(file, args, options = {}) {
  return (
    await exec(file, args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout ?? 600_000,
    })
  ).stdout.trim();
}
function defaultStart(args) {
  const child = spawn('docker', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`load exited ${code}: ${stdout}\n${stderr}`)),
    );
  });
  return { finished, kill: () => child.kill('SIGTERM') };
}

export async function runBenchmark(config, options = {}) {
  const run = options.command ?? command;
  const start = options.start ?? defaultStart;
  const pause = options.sleep ?? sleep;
  const log = options.log ?? console.log;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const project = `tug-examples-bench-${process.pid}-${Date.now()}`;
  const output = `${cwd}results/${timestamp.replace(/[:.]/g, '-')}.json`;
  const report = { timestamp, settings: config, workloads: {}, runs: [], status: 'running' };
  let activeStack, activeLoad, interrupted, persistError;
  let context = { stack: null, workload: null, concurrency: null, round: null, phase: 'setup' };
  const onSignal = (signal) => {
    interrupted = new Error(`Interrupted by ${signal}`);
    activeLoad?.kill();
  };
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = Object.fromEntries(signals.map((signal) => [signal, () => onSignal(signal)]));
  for (const signal of signals) process.on(signal, handlers[signal]);
  const check = () => {
    if (interrupted) throw interrupted;
  };
  const docker = (args) => {
    check();
    return run('docker', args);
  };
  const compose = (stack, args) => docker(composeArgs(project, stack, args));
  const loadArgs = (stack, workload, concurrency, seconds) =>
    composeArgs(project, stack, [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'load',
      `https://caddy${workload.path}`,
      String(concurrency),
      String(seconds),
      JSON.stringify(workload.expectation),
    ]);
  const resources = async (stack) =>
    Object.fromEntries(
      await Promise.all(
        cases[stack].services.map(async (service) => {
          const raw = await compose(stack, [
            'exec',
            '-T',
            service,
            'cat',
            '/sys/fs/cgroup/cpu.stat',
            '/sys/fs/cgroup/memory.current',
          ]);
          const cpu = raw.match(/^usage_usec (\d+)/m),
            memory = raw.match(/(?:^|\n)(\d+)\s*$/);
          if (!cpu || !memory)
            throw new Error(`Cannot read cgroup metrics for ${stack}/${service}: ${raw}`);
          return [service, { cpuUsec: Number(cpu[1]), memoryBytes: Number(memory[1]) }];
        }),
      ),
    );
  const persist = async () => {
    await mkdir(`${cwd}results`, { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  };
  try {
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    report.docker = Object.fromEntries(
      [
        'ServerVersion',
        'OperatingSystem',
        'Architecture',
        'NCPU',
        'MemTotal',
        'ContainersRunning',
        'KernelVersion',
      ].map((key) => [key, info[key]]),
    );
    await mkdir(`${cwd}certs`, { recursive: true });
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'certs/server.key',
      '-out',
      'certs/server.crt',
      '-days',
      '2',
      '-subj',
      '/CN=caddy',
      '-addext',
      'subjectAltName=DNS:caddy',
    ]);
    report.images = {};
    for (const stack of config.stacks) {
      check();
      activeStack = stack;
      context = { stack, workload: null, concurrency: null, round: null, phase: 'setup' };
      log(`Starting ${stack}`);
      await compose(stack, ['--profile', 'setup', 'build']);
      await compose(stack, ['up', '-d', '--wait']);
      for (const service of cases[stack].setup)
        await run('docker', composeArgs(project, stack, ['run', '--rm', '-T', service]), {
          timeout: 120_000,
        });
      const path = stack === 'wordpress' ? '/' : '/health';
      for (let attempt = 0; ; attempt++) {
        try {
          await compose(stack, [
            'run',
            '--rm',
            '--no-deps',
            '-T',
            '--entrypoint',
            'node',
            'load',
            '-e',
            readinessScript,
            path,
          ]);
          break;
        } catch (error) {
          check();
          if (attempt === 29)
            throw new Error(`${stack} did not become ready: ${error.message}`, { cause: error });
          await pause(1000);
        }
      }
      const id =
        stack === 'wordpress'
          ? undefined
          : JSON.parse(
              await compose(stack, [
                'run',
                '--rm',
                '--no-deps',
                '-T',
                '--entrypoint',
                'node',
                'load',
                '-e',
                seedScript,
              ]),
            ).id;
      const workloads = workloadDefinitions(stack, id);
      report.workloads[stack] = workloads;
      const ids = (
        await compose(stack, ['--profile', 'setup', '--profile', 'load', 'config', '--images'])
      )
        .split(/\s+/)
        .filter(Boolean);
      report.images[stack] = ids.length
        ? JSON.parse(await docker(['image', 'inspect', ...new Set(ids)])).map(
            ({ Id, RepoTags, RepoDigests }) => ({ Id, RepoTags, RepoDigests }),
          )
        : [];
      for (const { concurrency, round, workload } of measurementOrder(config, workloads)) {
        check();
        context = { stack, workload: workload.name, concurrency, round, phase: 'warmup' };
        await docker(loadArgs(stack, workload, concurrency, 2));
        context.phase = 'measurement';
        const before = await resources(stack);
        activeLoad = start(loadArgs(stack, workload, concurrency, config.seconds));
        const finished = activeLoad.finished;
        // Attach a rejection handler immediately while sampling to avoid unhandled rejections.
        const outcome = finished.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await pause(config.seconds * 500);
        const middle = await resources(stack);
        const result = await outcome;
        activeLoad = undefined;
        if (result.error) throw result.error;
        check();
        const after = await resources(stack);
        const metrics = JSON.parse(result.value);
        if (metrics.errors || !metrics.requests)
          throw new Error(`Invalid load result: ${result.value}`);
        metrics.services = Object.fromEntries(
          cases[stack].services.map((service) => [
            service,
            {
              cpuSeconds: (after[service].cpuUsec - before[service].cpuUsec) / 1e6,
              sampledMemoryMiB: middle[service].memoryBytes / 1024 ** 2,
            },
          ]),
        );
        metrics.cpuUsecPerRequest =
          Object.values(metrics.services).reduce(
            (sum, service) => sum + service.cpuSeconds * 1e6,
            0,
          ) / metrics.requests;
        report.runs.push({ stack, workload: workload.name, concurrency, round, ...metrics });
        await persist();
        log(
          `${stack}/${workload.name} c=${concurrency} round=${round}: ${metrics.requestsPerSecond.toFixed(0)} req/s`,
        );
      }
      context = { stack, workload: null, concurrency: null, round: null, phase: 'setup' };
      await compose(stack, ['down', '--volumes', '--remove-orphans']);
      activeStack = undefined;
    }
    report.status = 'complete';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack ?? String(error);
    report.failure = { ...context };
    if (activeStack) {
      try {
        report.logs = await run(
          'docker',
          composeArgs(project, activeStack, ['logs', '--no-color', '--tail', '200']),
          { timeout: 10_000 },
        );
      } catch (logError) {
        report.logError = logError.message;
      }
    }
    if (activeStack) {
      // Each diagnostic is independent: stopped or unavailable containers must not hide the load error.
      report.diagnostics = Object.fromEntries(
        await Promise.all(
          cases[activeStack].services.map(async (service) => {
            const diagnostic = {};
            try {
              const id = (
                await run(
                  'docker',
                  composeArgs(project, activeStack, ['ps', '--all', '-q', service]),
                  { timeout: 10_000 },
                )
              ).trim();
              if (!id) throw new Error('container not found');
              const [container] = JSON.parse(
                await run('docker', ['inspect', id], { timeout: 10_000 }),
              );
              diagnostic.container = {
                id: container.Id,
                oomKilled: container.State?.OOMKilled,
                restartCount: container.RestartCount,
                memoryLimitBytes: container.HostConfig?.Memory,
              };
            } catch (diagnosticError) {
              diagnostic.inspectError = diagnosticError.message;
            }
            try {
              const events = await run(
                'docker',
                composeArgs(project, activeStack, [
                  'exec',
                  '-T',
                  service,
                  'cat',
                  '/sys/fs/cgroup/memory.events',
                ]),
                { timeout: 10_000 },
              );
              diagnostic.memoryEvents = Object.fromEntries(
                events
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => {
                    const [key, value] = line.trim().split(/\s+/);
                    return [key, Number(value)];
                  }),
              );
            } catch (diagnosticError) {
              diagnostic.memoryEventsError = diagnosticError.message;
            }
            return [service, diagnostic];
          }),
        ),
      );
    }
    throw error;
  } finally {
    activeLoad?.kill();
    if (activeStack) {
      try {
        await run(
          'docker',
          composeArgs(project, activeStack, ['down', '--volumes', '--remove-orphans']),
        );
      } catch (error) {
        report.cleanupError = error.message;
        console.error(`Cleanup failed: ${error.message}`);
      }
    }
    for (const signal of signals) process.removeListener(signal, handlers[signal]);
    try {
      await persist();
    } catch (error) {
      persistError = error;
      console.error(`Could not write report: ${error.message}`);
    }
    log(`Report: ${output}`);
  }
  if (persistError) throw persistError;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBenchmark(configFromEnv()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
