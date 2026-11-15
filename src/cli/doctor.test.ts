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

test('enabling ingress tells the operator to open ports 80 and 443 and that tug will not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-ingress-hint-'));
  const control = await startMtlsControl(dir);
  try {
    assert.equal((await control.registerNode('n1')).status, 200, 'the node should register');
    const env: NodeJS.ProcessEnv = { ...process.env, ...control.env };
    delete env.TUG_CONFIG;
    const enabled = await exec(process.execPath, [entry, 'node', 'ingress', 'n1'], {
      cwd: dir,
      env,
    });
    assert.match(
      enabled.stderr,
      /Ports 80 and 443 must be open on n1/,
      'enabling prints the port hint',
    );
    assert.match(
      enabled.stderr,
      /tug does not change firewalls/,
      'the hint says tug leaves firewalls alone',
    );
    const disabled = await exec(process.execPath, [entry, 'node', 'ingress', 'n1', '--disable'], {
      cwd: dir,
      env,
    });
    assert.equal(disabled.stderr, '', 'removing the role prints no port hint');
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor prints a missing local Docker daemon as skipped and does not count it as a problem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-doctor-nodocker-'));
  const control = await startMtlsControl(dir);
  try {
    // A PATH holding only `node` leaves `docker` unrunnable, like a laptop without Docker.
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    const env: NodeJS.ProcessEnv = { ...process.env, ...control.env, PATH: bin };
    delete env.TUG_CONFIG;
    const run = async (args: string[]) =>
      exec(process.execPath, [entry, 'doctor', ...args], { cwd: dir, env }).then(
        (r) => ({ ...r, code: 0 }),
        (e: { stdout: string; stderr: string; code: number }) => e,
      );
    const human = await run([]);
    assert.match(
      human.stdout,
      /^ {2}skip {2}docker {2}needed only for --build-local$/m,
      'a missing local Docker daemon should print as skipped with its reason',
    );
    const thisMachine = human.stdout.split('\nControl')[0];
    assert.ok(!thisMachine.includes('FAIL'), 'no check under This machine should print FAIL');
    const json = JSON.parse((await run(['--json'])).stdout);
    assert.deepEqual(
      json.local.find((c: { name: string }) => c.name === 'docker'),
      { name: 'docker', ok: true, skipped: 'needed only for --build-local' },
      'the JSON document marks the check skipped and ok so scripts do not count it',
    );
    assert.equal(
      json.local.every((c: { ok: boolean }) => c.ok),
      true,
      'no local check fails when only Docker is missing',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
