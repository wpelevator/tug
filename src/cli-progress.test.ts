import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from './cli-progress.ts';

test('progress reports stages immediately and elapsed time while work is pending', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const lines: string[] = [];
  const progress = createProgress({ write: (line) => lines.push(line) });
  try {
    progress.stage('Building images');
    assert.deepEqual(lines, ['[0s] Building images'], 'a stage must be visible before work starts');
    t.mock.timers.tick(10_000);
    progress.stage('Building images');
    t.mock.timers.tick(10_000);
    assert.deepEqual(
      lines,
      ['[0s] Building images', '[10s] Building images', '[20s] Building images'],
      'slow work must report elapsed time every ten seconds without resetting on repeated states',
    );
    progress.stage('Rolling out');
    t.mock.timers.tick(10_000);
    assert.deepEqual(
      lines.slice(-2),
      ['[0s] Rolling out', '[10s] Rolling out'],
      'changing stages must immediately report the new stage and reset its elapsed time',
    );
  } finally {
    progress.stop();
  }
  const count = lines.length;
  t.mock.timers.tick(30_000);
  assert.equal(lines.length, count, 'stopping progress must cancel all future heartbeat output');
});
