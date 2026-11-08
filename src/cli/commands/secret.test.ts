import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl } from '../../../tests/helpers.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

test('secret set exits after reading stdin even when the input stays open', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-secret-exit-'));
  const control = await startMtlsControl(dir);
  const run = (...args: string[]) =>
    exec(process.execPath, [entry, 'secret', 'set', 'DB_PASSWORD', ...args], {
      cwd: dir,
      env: { ...process.env, ...control.env, TUG_CREDENTIAL: '', TUG_PROJECT: 'site' },
      timeout: 5000,
    });
  try {
    const entered = run();
    entered.child.stdin!.write('test-password\n');
    const result = await entered;
    assert.deepEqual(
      JSON.parse(result.stdout.replace(/^DB_PASSWORD: /, '')),
      { ok: true, name: 'DB_PASSWORD', version: 1 },
      'reading a secret should print success and exit without waiting for stdin to close',
    );
    assert.ok(
      !result.stdout.includes('test-password'),
      'the CLI should not print the secret value',
    );

    const refused = run('--project', '_reserved');
    refused.child.stdin!.write('test-password\n');
    await assert.rejects(
      refused,
      (error: Error & { code?: number; stderr?: string }) => {
        assert.equal(
          error.code,
          1,
          'an API failure should exit with code 1 while stdin stays open',
        );
        assert.match(error.stderr ?? '', /400/, 'the CLI should report the API rejection');
        return true;
      },
      'an API failure after reading stdin should exit without waiting for EOF',
    );

    const explicit = await run('--value', 'explicit-password');
    assert.deepEqual(
      JSON.parse(explicit.stdout),
      { ok: true, name: 'DB_PASSWORD', version: 2 },
      '--value should set the secret and exit without reading stdin',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
