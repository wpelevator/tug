import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../tests/helpers.ts';
import { execCli } from '../../tests/cli-inprocess.ts';

test('status is human-readable by default and prints JSON with --json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-status-'));
  const control = await startMtlsControl(dir);
  try {
    const node = await control.registerNode('web');
    assert.equal(node.status, 200, 'the status test node must register');
    const env: NodeJS.ProcessEnv = { ...process.env, ...control.env };
    delete env.TUG_CONFIG;
    const json = await execCli(['status', '--json'], { cwd: dir, env });
    assert.ok(
      Array.isArray(JSON.parse(json.stdout).nodes),
      'status --json must print the raw JSON for scripts',
    );
    const human = await execCli(['status'], { cwd: dir, env });
    assert.match(
      human.stdout,
      /No projects/,
      'the human summary must describe the empty project list',
    );
    assert.match(
      human.stdout,
      /web: registered; last seen never/,
      'the human summary must show the registered node',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
