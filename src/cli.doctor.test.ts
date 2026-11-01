import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMtlsControl } from '../tests/helpers.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

test('doctor waits for the node diagnostic instead of returning the queued command id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-doctor-'));
  const control = await startMtlsControl(dir);
  try {
    const registered = await control.registerNode('n1');
    assert.equal(registered.status, 200, 'the diagnostic target should register');
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, ...control.env };
    delete env.TUG_CONFIG;
    await assert.rejects(
      exec(process.execPath, [entry, 'doctor', '--node', 'n1', '--timeout', '1'], {
        cwd: dir,
        env,
      }),
      (error: Error & { stderr?: string }) => {
        assert.match(
          error.stderr || '',
          /timed out waiting for command/,
          'doctor should wait for the agent result and time out when the node never polls',
        );
        return true;
      },
    );
    assert.ok(
      Date.now() - started >= 900,
      'doctor should wait about the requested timeout instead of returning as soon as the command is queued',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
