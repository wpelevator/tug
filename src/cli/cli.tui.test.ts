import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMtlsControl } from '../../tests/helpers.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

async function withControl<T>(
  run: (
    env: NodeJS.ProcessEnv,
    dir: string,
    control: Awaited<ReturnType<typeof startMtlsControl>>,
  ) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-tui-'));
  const control = await startMtlsControl(dir);
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...control.env };
    delete env.TUG_CONFIG;
    return await run(env, dir, control);
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const tug = (args: string[], env: NodeJS.ProcessEnv, cwd: string) =>
  exec(process.execPath, [entry, ...args], { cwd, env }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );

test('tui --once prints the counters and attention list, and its exit code agrees with the list', async () => {
  await withControl(async (env, dir) => {
    const result = await tug(['tui', '--once'], env, dir);
    assert.match(result.stdout, /^Nodes 0\/0 online/, 'the summary starts with the counters');
    assert.doesNotMatch(
      result.stdout,
      /node |backup |deployment /,
      'a control with no nodes, projects or backups flags none of them',
    );
    // A test machine without Docker fails control's own docker check, which is a real finding the summary must report.
    assert.equal(
      result.code,
      /All clear/.test(result.stdout) ? 0 : 1,
      'the exit code is zero exactly when nothing needs attention',
    );
  });
});

test('tui --json prints the summary as JSON with the credential’s role and the control version', async () => {
  await withControl(async (env, dir, control) => {
    assert.equal((await control.registerNode('web')).status, 200, 'the test node registers');
    const ok = await tug(['tui', '--json'], env, dir);
    const report = JSON.parse(ok.stdout) as {
      ok: boolean;
      control: { role: string; version: string };
      counters: { nodesTotal: number };
      attention: unknown[];
    };
    assert.equal(
      report.control.role,
      'admin',
      'the summary says which role this credential has, from whoami',
    );
    assert.match(report.control.version, /^\d+\.\d+\.\d+/, 'and which control version answered');
    assert.equal(report.counters.nodesTotal, 1, 'the registered node is counted');
    assert.ok(Array.isArray(report.attention), 'attention is a list');
  });
});

test('tui without a terminal explains how to get a summary instead of drawing', async () => {
  await withControl(async (env, dir) => {
    const result = await tug(['tui'], env, dir);
    assert.equal(result.code, 1, 'a piped tui refuses');
    assert.match(result.stderr, /needs a terminal.*--once/, 'the error names the alternative');
  });
});

test('tui rejects an unknown starting view and lists the valid ones', async () => {
  await withControl(async (env, dir) => {
    const result = await tug(['tui', 'bogus'], env, dir);
    assert.equal(result.code, 1, 'an unknown view is an error');
    assert.match(
      result.stderr,
      /unknown view "bogus".*overview, projects, nodes/,
      'the error lists the views',
    );
  });
});

test('tui --once exits nonzero and says why when control cannot be reached', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-tui-down-'));
  const control = await startMtlsControl(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...control.env,
    TUG_CONTROL_URL: 'https://127.0.0.1:1',
  };
  delete env.TUG_CONFIG;
  try {
    const result = await tug(['tui', '--once'], env, dir);
    assert.equal(result.code, 1, 'an unreachable control is a failure for a monitor');
    assert.match(
      result.stderr,
      /could not reach control/,
      'the error says control could not be reached',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
