import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, runLocal, runProcess, runStep, STAGE_MARKER } from './process.ts';
import { createProgress } from './progress.ts';
import { RUN_OUTPUT_LIMIT } from '../images/build.ts';
import { testRuntime } from '../../tests/cli-runtime.ts';

test('child processes keep progress timers running and capture stdin/stdout/stderr separately', async () => {
  const { rt } = testRuntime();
  const lines: string[] = [];
  const progress = createProgress(rt, {
    intervalMs: 10,
    write: (line) => {
      lines.push(line);
    },
  });
  progress.stage('Installing');
  try {
    const result = await runProcess(
      rt,
      process.execPath,
      [
        '-e',
        "process.stdin.on('data', chunk => setTimeout(() => { process.stdout.write(chunk); process.stderr.write('diagnostic'); }, 80))",
      ],
      { capture: true, input: 'credential' },
    );
    assert.equal(result.status, 0, 'successful children must return exit status zero');
    assert.equal(
      result.stdout,
      'credential',
      'input must reach the child without being mixed with progress',
    );
    assert.equal(
      result.stderr,
      'diagnostic',
      'child diagnostics must remain separate from captured output',
    );
    assert.ok(lines.length > 1, 'heartbeats must run while a child process is pending');
  } finally {
    progress.stop();
  }
});

test('async process helpers preserve errors and bound captured output', async () => {
  const { rt } = testRuntime();
  assert.equal(
    await runCapture(rt, process.execPath, ['-e', "process.stdout.write('csr')"]),
    'csr',
    'capture must return stdout unchanged',
  );
  await assert.rejects(
    runLocal(rt, process.execPath, ['-e', 'process.exit(7)']),
    /exit 7/,
    'inherited-output processes must reject nonzero exits',
  );
  await assert.rejects(
    runCapture(rt, process.execPath, [
      '-e',
      "process.stderr.write('failure detail'); process.exit(8)",
    ]),
    /failure detail/,
    'captured process failures must retain actionable stderr',
  );
  await assert.rejects(
    runLocal(rt, 'tug-missing-install-command', []),
    /ENOENT/,
    'spawn errors must reject instead of hanging',
  );
  const result = await runCapture(rt, process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(2 * 1024 * 1024) + 'END')",
  ]);
  assert.ok(
    result.length <= RUN_OUTPUT_LIMIT && result.endsWith('END'),
    'captured output must retain only a bounded tail',
  );
});

test("a child's output reaches the runtime's streams, and its environment and directory are the runtime's", async () => {
  const run = testRuntime({ env: { ...process.env, TUG_PROBE: 'from-runtime' }, cwd: '/' });
  await runLocal(run.rt, process.execPath, [
    '-e',
    "process.stdout.write(process.env.TUG_PROBE + ' ' + process.cwd()); process.stderr.write('warned')",
  ]);
  assert.equal(
    run.stdout(),
    'from-runtime /',
    'the child should see the runtime environment and working directory and write to its stdout',
  );
  assert.equal(run.stderr(), 'warned', 'the child stderr should reach the runtime stderr');
});

test('runStep hides output, turns markers into stages, and reports the tail on failure', async () => {
  const run = testRuntime();
  const stages: string[] = [];
  const details: string[] = [];
  const script = `
    console.log(${JSON.stringify(STAGE_MARKER)} + 'Pulling image');
    process.stdout.write('layer 1: Downloading\\rlayer 1: Extracting\\n');
    console.error('layer 2: Pull complete');
    console.log(${JSON.stringify(STAGE_MARKER)} + 'Starting');`;
  await runStep(run.rt, process.execPath, ['-e', script], {
    progress: { stage: (label) => stages.push(label), detail: (line) => details.push(line) },
  });
  assert.deepEqual(stages, ['Pulling image', 'Starting'], 'marker lines should become stages');
  assert.ok(
    details.includes('layer 1: Downloading') && details.includes('layer 1: Extracting'),
    'carriage-return redraws should count as separate lines for the status line',
  );
  assert.ok(
    !details.some((line) => line.includes(STAGE_MARKER.trim())),
    'markers should not appear as output lines',
  );
  assert.equal(run.stderr(), '', 'a successful quiet step must print nothing');
  await assert.rejects(
    runStep(run.rt, process.execPath, [
      '-e',
      "console.error('boom: no space left'); process.exit(3)",
    ]),
    /failed \(exit 3\)\nboom: no space left/,
    'a failure should include the lines the step printed',
  );
});

test('runStep streams output under --verbose and accepts stdin', async () => {
  const run = testRuntime();
  run.rt.state.verbose = true;
  await runStep(
    run.rt,
    process.execPath,
    ['-e', "process.stdin.on('data', (d) => console.log('got ' + d))"],
    { input: 'credential' },
  );
  assert.equal(run.stderr(), 'got credential\n', 'verbose mode should stream the step output');
});

test("verbose output goes through the progress line, and only this run's marker starts a stage", async () => {
  const { rt } = testRuntime();
  rt.state.verbose = true;
  const printed: string[] = [];
  const stages: string[] = [];
  await runStep(
    rt,
    process.execPath,
    [
      '-e',
      `console.log(${JSON.stringify(STAGE_MARKER)} + 'Real stage'); console.log('::tug:: Spoofed'); console.log('plain output')`,
    ],
    {
      progress: {
        stage: (label) => stages.push(label),
        print: (line) => printed.push(line),
      },
    },
  );
  assert.deepEqual(
    printed,
    ['::tug:: Spoofed', 'plain output'],
    'verbose lines are printed above the live line; a genuine marker is a stage, not output, and a lookalike is output',
  );
  assert.deepEqual(
    stages,
    ['Real stage'],
    "only the marker with this run's random part becomes a stage; a lookalike from program output is just output",
  );
});

test('a step that never ends its line cannot grow memory without bound', async () => {
  const { rt } = testRuntime();
  await assert.rejects(
    runStep(rt, process.execPath, ['-e', "process.stdout.write('x'.repeat(1e6)); process.exit(4)"]),
    (error: Error) => {
      assert.ok(error.message.length < 10_000, 'the failure message must be bounded');
      return /failed \(exit 4\)/.test(error.message);
    },
    'an endless line is truncated in the failure report',
  );
});
