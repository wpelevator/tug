import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configFromEnv, composeArgs, workloadDefinitions, runBenchmark } from './run.mjs';

test('configuration validates settings and selected stacks', () => {
  assert.deepEqual(
    configFromEnv({}),
    {
      seconds: 10,
      rounds: 3,
      concurrency: [1, 16],
      stacks: ['node', 'django', 'laravel', 'wordpress'],
    },
    'defaults should cover all four stacks with repeated measurements',
  );
  assert.deepEqual(
    configFromEnv({
      BENCH_STACKS: 'django,node',
      BENCH_SECONDS: '2',
      BENCH_ROUNDS: '1',
      BENCH_CONCURRENCY: '2,4',
    }),
    { seconds: 2, rounds: 1, concurrency: [2, 4], stacks: ['django', 'node'] },
    'environment should control stack order and measurement settings',
  );
  for (const env of [
    { BENCH_SECONDS: 'Infinity' },
    { BENCH_ROUNDS: '0' },
    { BENCH_CONCURRENCY: '1,' },
    { BENCH_CONCURRENCY: '2,2' },
    { BENCH_STACKS: 'node,unknown' },
    { BENCH_STACKS: 'node,node' },
  ])
    assert.throws(
      () => configFromEnv(env),
      undefined,
      'invalid or duplicate settings should fail before Docker starts',
    );
});

test('workloads describe seeded API data and installed WordPress', () => {
  assert.deepEqual(
    workloadDefinitions('node', 'seed').map(({ name, path }) => [name, path]),
    [
      ['cached-files', '/files'],
      ['download', '/files/seed'],
    ],
    'API workloads should target the cached list and seeded download',
  );
  assert.equal(
    workloadDefinitions('wordpress')[0].expectation.title,
    'Benchmark Site',
    'homepage should validate the installed benchmark site',
  );
  assert.deepEqual(
    composeArgs('isolated', 'node', ['down']),
    ['compose', '-p', 'isolated', '-f', 'compose.yml', '-f', 'compose.node.yml', 'down'],
    'all Compose operations should use the isolated project and stack files',
  );
});

function fakeRuntime(failSetup = false) {
  const calls = [];
  let sample = 0;
  const command = async (program, args) => {
    calls.push([program, args]);
    if (args.includes('info')) return JSON.stringify({ ServerVersion: 'test', NCPU: 4 });
    if (args.includes('--images')) return 'sha256:image';
    if (args.includes('ps')) return 'container-id';
    if (args.includes('inspect') && !args.includes('image'))
      return JSON.stringify([
        {
          Id: 'container-id',
          State: { OOMKilled: true },
          RestartCount: 2,
          HostConfig: { Memory: 1024 },
        },
      ]);
    if (args.includes('/sys/fs/cgroup/memory.events')) return 'low 0\noom 1\noom_kill 1';
    if (args.includes('inspect'))
      return JSON.stringify([{ Id: 'sha256:image', RepoTags: ['test:latest'], RepoDigests: [] }]);
    if (args.includes('cat')) return `usage_usec ${++sample * 1000}\n1048576`;
    if (args.includes('s3-init') && failSetup) throw new Error('setup failed');
    if (
      args.includes('-e') &&
      args.some((s) => typeof s === 'string' && s.includes('const boundary='))
    )
      return JSON.stringify({ id: 'seed', name: 'benchmark.txt' });
    if (args.includes('logs')) return 'container evidence';
    return '';
  };
  const start = (args) => {
    calls.push(['load', args]);
    return {
      finished: Promise.resolve(
        JSON.stringify({ requests: 10, errors: 0, requestsPerSecond: 5, clientCpuPercent: 1 }),
      ),
      kill() {},
    };
  };
  return { calls, command, start, sleep: async () => {}, log: () => {} };
}

const timestamp = '2001-01-01T00:00:00.000Z';
const output = fileURLToPath(new URL('./results/2001-01-01T00-00-00-000Z.json', import.meta.url));
test('runs stacks sequentially and records measurements and image identities', async () => {
  const runtime = fakeRuntime();
  try {
    const report = await runBenchmark(
      { seconds: 2, rounds: 1, concurrency: [1], stacks: ['node', 'wordpress'] },
      { ...runtime, timestamp },
    );
    assert.equal(report.status, 'complete', 'successful runs should be marked complete');
    assert.deepEqual(
      report.runs.map((r) => `${r.stack}/${r.workload}`),
      ['node/cached-files', 'node/download', 'wordpress/homepage'],
      'each stack should finish its workloads before the next stack',
    );
    assert.equal(
      report.runs[0].services.web.sampledMemoryMiB,
      1,
      'service memory should be recorded in MiB',
    );
    assert.equal(
      report.runs[0].services.web.cpuSeconds,
      0.01,
      'service CPU should be the before/after cgroup delta converted to seconds',
    );
    assert.equal(
      report.runs[0].cpuUsecPerRequest,
      5000,
      'CPU per request should sum all five stack services and divide by successful requests',
    );
    assert.equal(report.images.node[0].Id, 'sha256:image', 'reports should include image IDs');
    assert.equal(
      JSON.parse(await readFile(output, 'utf8')).status,
      'complete',
      'the persisted report should contain the final status',
    );
    const down = runtime.calls.findIndex(([, args]) => args.includes('down'));
    const wordpressBuild = runtime.calls.findIndex(([, args]) =>
      args.includes('compose.wordpress.yml'),
    );
    assert.ok(
      down >= 0 && down < wordpressBuild,
      'the first project should be removed before the next stack starts',
    );
  } finally {
    await rm(output, { force: true });
  }
});

test('setup failures retain logs and clean up the scoped project', async () => {
  const runtime = fakeRuntime(true);
  try {
    await assert.rejects(
      runBenchmark(
        { seconds: 2, rounds: 1, concurrency: [1], stacks: ['node'] },
        { ...runtime, timestamp },
      ),
      /setup failed/,
      'setup errors should fail the benchmark',
    );
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.status, 'failed', 'failed runs should retain a partial report');
    assert.deepEqual(
      report.failure,
      { stack: 'node', workload: null, concurrency: null, round: null, phase: 'setup' },
      'setup failures should identify their phase and stack',
    );
    assert.equal(report.logs, 'container evidence', 'failed setup should preserve container logs');
    assert.ok(
      runtime.calls.some(([, args]) => args.includes('down') && args.includes('--volumes')),
      'failed setup should remove the project and its volumes',
    );
  } finally {
    await rm(output, { force: true });
  }
});

test('measured load failures preserve earlier runs and remove the project', async () => {
  for (const failure of ['reject', 'errors', 'empty']) {
    const runtime = fakeRuntime();
    const originalStart = runtime.start;
    let started = 0;
    runtime.start = (args) => {
      if (++started === 1) return originalStart(args);
      const result = failure === 'errors' ? { requests: 1, errors: 1 } : { requests: 0, errors: 0 };
      return {
        finished:
          failure === 'reject'
            ? Promise.reject(new Error('load failed'))
            : Promise.resolve(JSON.stringify(result)),
        kill() {},
      };
    };
    try {
      await assert.rejects(
        runBenchmark(
          { seconds: 2, rounds: 1, concurrency: [1], stacks: ['node'] },
          { ...runtime, timestamp },
        ),
        /load failed|Invalid load result/,
        'a failed or invalid measured load should fail the benchmark',
      );
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(
        report.status,
        'failed',
        'a failed measured load should produce a failed report',
      );
      assert.deepEqual(
        report.failure,
        { stack: 'node', workload: 'download', concurrency: 1, round: 1, phase: 'measurement' },
        'measurement failures should record workload, concurrency, round, stack and phase',
      );
      assert.deepEqual(
        report.diagnostics.web,
        {
          container: {
            id: 'container-id',
            oomKilled: true,
            restartCount: 2,
            memoryLimitBytes: 1024,
          },
          memoryEvents: { low: 0, oom: 1, oom_kill: 1 },
        },
        'failure diagnostics should retain container state and cgroup memory events',
      );
      assert.equal(
        report.runs.length,
        1,
        'completed measurements should remain in the failure report',
      );
      assert.equal(
        report.runs[0].workload,
        'cached-files',
        'the report should retain the earlier successful workload',
      );
      assert.ok(
        runtime.calls.some(([, args]) => args.includes('down') && args.includes('--volumes')),
        'a measured load failure should remove the project and its volumes',
      );
    } finally {
      await rm(output, { force: true });
    }
  }
});

test('SIGTERM stops the active load, cleans up, and removes signal handlers', async () => {
  const runtime = fakeRuntime();
  const previous = Object.fromEntries(
    ['SIGINT', 'SIGTERM'].map((signal) => [signal, process.listeners(signal)]),
  );
  let killed = false;
  runtime.start = () => {
    let rejectLoad;
    const finished = new Promise((resolve, reject) => {
      rejectLoad = reject;
    });
    queueMicrotask(() => process.emit('SIGTERM', 'SIGTERM'));
    return {
      finished,
      kill() {
        killed = true;
        rejectLoad(new Error('terminated load'));
      },
    };
  };
  try {
    await assert.rejects(
      runBenchmark(
        { seconds: 2, rounds: 1, concurrency: [1], stacks: ['node'] },
        { ...runtime, timestamp },
      ),
      /terminated load|Interrupted/,
      'a termination signal should stop the benchmark',
    );
    assert.ok(killed, 'a termination signal should stop the active load process');
    assert.ok(
      runtime.calls.some(([, args]) => args.includes('down') && args.includes('--volumes')),
      'a termination signal should remove the project and volumes',
    );
    assert.equal(
      JSON.parse(await readFile(output, 'utf8')).status,
      'failed',
      'an interrupted benchmark should retain a failed report',
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      assert.deepEqual(
        process.listeners(signal),
        previous[signal],
        'runner signal handlers should be removed after interruption',
      );
  } finally {
    await rm(output, { force: true });
  }
});

test('diagnostic failures preserve the original error and still clean up', async () => {
  const runtime = fakeRuntime(true);
  const originalCommand = runtime.command;
  runtime.command = async (program, args, options) => {
    if (args.includes('ps') || args.includes('/sys/fs/cgroup/memory.events'))
      throw new Error('diagnostic unavailable');
    return originalCommand(program, args, options);
  };
  try {
    await assert.rejects(
      runBenchmark(
        { seconds: 2, rounds: 1, concurrency: [1], stacks: ['node'] },
        { ...runtime, timestamp },
      ),
      /setup failed/,
      'diagnostic failures should not replace the original setup failure',
    );
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.match(report.error, /setup failed/, 'the report should retain the original failure');
    assert.equal(
      report.diagnostics.web.inspectError,
      'diagnostic unavailable',
      'unavailable container inspection should be recorded',
    );
    assert.equal(
      report.diagnostics.web.memoryEventsError,
      'diagnostic unavailable',
      'unavailable memory events should be recorded',
    );
    assert.ok(
      runtime.calls.some(([, args]) => args.includes('down') && args.includes('--volumes')),
      'diagnostic failures should not prevent cleanup',
    );
  } finally {
    await rm(output, { force: true });
  }
});
