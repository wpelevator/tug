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

test('scoped progress stops heartbeats on success, early return and rejection', async (t) => {
  const { withProgress } = await import('./cli-progress.ts');
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (line: string) => {
    lines.push(line);
    return true;
  });
  for (const fails of [false, true]) {
    const operation = withProgress('Waiting', async () => {
      t.mock.timers.tick(10_000);
      if (fails) throw new Error('operation failed');
      return 42;
    });
    if (fails)
      await assert.rejects(
        operation,
        /operation failed/,
        'progress must preserve the original operation error',
      );
    else assert.equal(await operation, 42, 'progress must preserve the operation result');
    const count = lines.length;
    t.mock.timers.tick(30_000);
    assert.equal(
      lines.length,
      count,
      'completed or failed operations must leave no heartbeat timer',
    );
  }
});

test('a terminal gets one live line and finished stages stay as lines', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  let screen = '';
  const progress = createProgress({
    live: { write: (text) => (screen += text), columns: () => 60 },
  });
  progress.stage('Pulling image');
  progress.detail('abc123: Pull complete');
  t.mock.timers.tick(2_000);
  assert.match(
    screen,
    /\[2s\] Pulling image · abc123: Pull complete/,
    'the live line shows elapsed time and the latest output',
  );
  progress.suspend();
  const suspended = screen;
  t.mock.timers.tick(2_000);
  assert.equal(screen, suspended, 'a suspended line must not draw over another process');
  progress.resume();
  progress.stage('Starting');
  progress.stop();
  assert.match(
    screen,
    /\[4s\] Pulling image\n/,
    'a finished stage should remain with its elapsed time',
  );
  assert.match(screen, /\[0s\] Starting\n$/, 'stopping keeps the last stage as a finished line');
  assert.ok(!screen.includes('[10s]'), 'a terminal does not need the ten-second heartbeat lines');
  // eslint-disable-next-line no-control-regex
  for (const text of screen.split(/\r\x1b\[K/))
    assert.ok(text.replace('\n', '').length <= 60, 'live lines must fit the terminal width');
});

test('printing above the live line clears it first and draws it again', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  let screen = '';
  const progress = createProgress({
    live: { write: (text) => (screen += text), columns: () => 80 },
  });
  progress.stage('Installing');
  screen = '';
  progress.print('apt output');
  assert.equal(
    screen,
    '\r\x1b[Kapt output\n\r\x1b[K[0s] Installing',
    'the line is cleared, the output printed on its own line and the status drawn again below it',
  );
  progress.stop();
});
