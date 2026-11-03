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
