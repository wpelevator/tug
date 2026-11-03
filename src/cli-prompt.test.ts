import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

test('repeated visible and hidden prompts release stdin after answering without EOF', async () => {
  const promptUrl = pathToFileURL(path.resolve('src/cli-prompt.ts')).href;
  const running = exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { ask } from ${JSON.stringify(promptUrl)};
      import assert from 'node:assert/strict';
      const events = ['keypress', 'end', 'error'];
      const before = events.map(event => process.stdin.listenerCount(event));
      const first = await ask('First answer: ');
      const hidden = await ask('Hidden answer: ', true);
      assert.deepEqual(events.map(event => process.stdin.listenerCount(event)), before, 'completed prompts must remove their input listeners');
      console.log(JSON.stringify({ first, hiddenLength: hidden.length }));`,
    ],
    { timeout: 10000 },
  );
  let output = '';
  let firstAnswered = false;
  let hiddenAnswered = false;
  running.child.stdout!.on('data', (data) => {
    output += String(data);
    if (!firstAnswered && output.includes('First answer: ')) {
      firstAnswered = true;
      running.child.stdin!.write('visible-value\n');
    }
    if (!hiddenAnswered && output.includes('Hidden answer: ')) {
      hiddenAnswered = true;
      running.child.stdin!.write('hidden-value\n');
    }
  });
  const result = await running;
  assert.match(
    result.stdout,
    /\{"first":"visible-value","hiddenLength":12\}/,
    'successive prompts should read both answers and exit without closing the input pipe',
  );
  assert.ok(!result.stdout.includes('hidden-value'), 'hidden prompts should not echo the answer');
});

test('a prompt rejects and exits when stdin closes before an answer', async () => {
  const promptUrl = pathToFileURL(path.resolve('src/cli-prompt.ts')).href;
  const running = exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { ask } from ${JSON.stringify(promptUrl)};
      await ask('Answer: ');`,
    ],
    { timeout: 10000 },
  );
  running.child.stdin!.end();
  await assert.rejects(
    running,
    (error: Error & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1, 'an unanswered prompt should fail and exit after EOF');
      assert.match(
        error.stderr ?? '',
        /input closed before an answer/,
        'EOF should report that no answer was given',
      );
      return true;
    },
    'closing stdin before an answer should reject the prompt without leaking a handle',
  );
});

test('CLI exits after a prompted command fails while stdin stays open', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-prompt-exit-'));
  // Exercise terminal-only prompting with real open pipes, without requiring a local TTY.
  const terminal = `data:text/javascript,${encodeURIComponent(
    'process.stdin.isTTY = true; process.stdout.isTTY = true;',
  )}`;
  try {
    const running = exec(
      process.execPath,
      ['--import', terminal, path.resolve('src/cli.ts'), 'node', 'add'],
      { cwd: dir, env: { ...process.env, TUG_CONFIG: '', CI: '' }, timeout: 10000 },
    );
    let answered = false;
    running.child.stdout!.on('data', (data) => {
      if (!answered && String(data).includes('Node name')) {
        answered = true;
        running.child.stdin!.write('app1\n');
      }
    });
    await assert.rejects(
      running,
      (error: Error & { code?: number; stderr?: string }) => {
        assert.equal(answered, true, 'node add should ask for a node name');
        assert.equal(error.code, 1, 'a command failure after prompting should exit without EOF');
        assert.match(
          error.stderr ?? '',
          /needs an SSH target/,
          'the command error should be reported',
        );
        return true;
      },
      'a completed prompt should not keep a failed command running',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
