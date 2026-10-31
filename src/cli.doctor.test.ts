import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

test('doctor waits for the node diagnostic instead of returning the queued command id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-doctor-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = 'op-doctor-wait';
  const app = await createApp();
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const registered = await fetch(`${base}/api/v1/nodes/register`, {
      method: 'POST',
      headers: { Authorization: 'Bearer op-doctor-wait', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'n1' }),
    });
    assert.equal(registered.status, 200, 'the diagnostic target should register');
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TUG_CONTROL_URL: base,
      TUG_TOKEN: 'op-doctor-wait',
    };
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
    await new Promise((resolve) => srv.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
