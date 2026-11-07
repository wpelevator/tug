import test from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, runLocal, runProcess } from './cli-process.ts';
import { createProgress } from './cli-progress.ts';
import { RUN_OUTPUT_LIMIT } from './build.ts';

test('child processes keep progress timers running and capture stdin/stdout/stderr separately', async () => {
  const lines: string[] = [];
  const progress = createProgress({
    intervalMs: 10,
    write: (line) => {
      lines.push(line);
    },
  });
  progress.stage('Installing');
  try {
    const result = await runProcess(
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
  assert.equal(
    await runCapture(process.execPath, ['-e', "process.stdout.write('csr')"]),
    'csr',
    'capture must return stdout unchanged',
  );
  await assert.rejects(
    runLocal(process.execPath, ['-e', 'process.exit(7)']),
    /exit 7/,
    'inherited-output processes must reject nonzero exits',
  );
  await assert.rejects(
    runCapture(process.execPath, ['-e', "process.stderr.write('failure detail'); process.exit(8)"]),
    /failure detail/,
    'captured process failures must retain actionable stderr',
  );
  await assert.rejects(
    runLocal('tug-missing-install-command', []),
    /ENOENT/,
    'spawn errors must reject instead of hanging',
  );
  const result = await runCapture(process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(2 * 1024 * 1024) + 'END')",
  ]);
  assert.ok(
    result.length <= RUN_OUTPUT_LIMIT && result.endsWith('END'),
    'captured output must retain only a bounded tail',
  );
});

test('runStep hides output, turns markers into stages, and reports the tail on failure', async () => {
  const { setVerbose } = await import('./cli-process.ts');
  setVerbose(false);
  const stages: string[] = [];
  const details: string[] = [];
  const seen: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (seen.push(String(chunk)), true)) as typeof write;
  try {
    const { runStep, STAGE_MARKER } = await import('./cli-process.ts');
    const script = `
      console.log(${JSON.stringify(STAGE_MARKER)} + 'Pulling image');
      process.stdout.write('layer 1: Downloading\\rlayer 1: Extracting\\n');
      console.error('layer 2: Pull complete');
      console.log(${JSON.stringify(STAGE_MARKER)} + 'Starting');`;
    await runStep(process.execPath, ['-e', script], {
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
    assert.deepEqual(seen, [], 'a successful quiet step must print nothing');
    await assert.rejects(
      runStep(process.execPath, ['-e', "console.error('boom: no space left'); process.exit(3)"]),
      /failed \(exit 3\)\nboom: no space left/,
      'a failure should include the lines the step printed',
    );
  } finally {
    process.stderr.write = write;
  }
});

test('runStep streams output under --verbose and accepts stdin', async () => {
  const { runStep, setVerbose } = await import('./cli-process.ts');
  const seen: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (seen.push(String(chunk)), true)) as typeof write;
  try {
    setVerbose(true);
    await runStep(
      process.execPath,
      ['-e', "process.stdin.on('data', (d) => console.log('got ' + d))"],
      { input: 'credential' },
    );
  } finally {
    process.stderr.write = write;
    setVerbose(false);
  }
  assert.deepEqual(seen, ['got credential\n'], 'verbose mode should stream the step output');
});

test("verbose output goes through the progress line, and only this run's marker starts a stage", async () => {
  const { runStep, setVerbose, STAGE_MARKER } = await import('./cli-process.ts');
  const printed: string[] = [];
  const stages: string[] = [];
  try {
    setVerbose(true);
    await runStep(
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
  } finally {
    setVerbose(false);
  }
  assert.deepEqual(
    printed,
    [`${STAGE_MARKER}Real stage`, '::tug:: Spoofed', 'plain output'],
    'verbose lines are printed above the live line, markers included',
  );
  assert.deepEqual(
    stages,
    ['Real stage'],
    "only the marker with this run's random part becomes a stage; a lookalike from program output is just output",
  );
});

test('a step that never ends its line cannot grow memory without bound', async () => {
  const { runStep, setVerbose } = await import('./cli-process.ts');
  setVerbose(false);
  await assert.rejects(
    runStep(process.execPath, ['-e', "process.stdout.write('x'.repeat(1e6)); process.exit(4)"]),
    (error: Error) => {
      assert.ok(error.message.length < 10_000, 'the failure message must be bounded');
      return /failed \(exit 4\)/.test(error.message);
    },
    'an endless line is truncated in the failure report',
  );
});
