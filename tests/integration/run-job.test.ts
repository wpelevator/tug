import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { startOneOff } from '../../src/agent/live.ts';

const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

/** Container ids from `docker ps` with the given filter; `all` includes stopped containers. */
const containers = (filter: string, all = false) =>
  docker('ps', all ? '-aq' : '-q', '--filter', filter)
    .stdout.trim()
    .split('\n')
    .filter(Boolean);

/** Polls until `check` holds or `timeoutMs` passes, so a slow runner cannot turn a fixed sleep into a failure. */
async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

function finish(proc: Awaited<ReturnType<typeof startOneOff>>) {
  const out: Buffer[] = [];
  proc.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
  proc.stderr!.resume();
  return new Promise<{ code: number | null; out: string }>((resolve) =>
    proc.once('close', (code: number | null) =>
      resolve({ code, out: Buffer.concat(out).toString() }),
    ),
  );
}

test(
  'a one-off run uses the service container environment and mounts, returns the exit code and cleans up',
  { skip: !dockerUp, timeout: 120_000 },
  async () => {
    const engine = new DockerEngine();
    docker('rm', '-f', 'tug-runtest');
    docker('volume', 'rm', '-f', 'tug_runtest_vol');
    docker('volume', 'create', 'tug_runtest_vol');
    try {
      const started = docker(
        'run',
        '-d',
        '--name',
        'tug-runtest',
        '--label',
        'tug.project=runtest',
        '--label',
        'tug.service=web',
        '-e',
        'SECRET_FROM_SERVICE=hunter2',
        '-v',
        'tug_runtest_vol:/d',
        'alpine',
        'sleep',
        '300',
      );
      assert.equal(started.status, 0, started.stderr);

      const done = finish(
        await startOneOff(engine, 'tug-runtest', [
          'sh',
          '-c',
          'echo "env=$SECRET_FROM_SERVICE"; echo kept > /d/f; exit 3',
        ]),
      );
      const result = await done;
      assert.equal(result.code, 3, 'the exit code of the command is returned');
      assert.match(result.out, /env=hunter2/, 'the command sees the service environment');
      assert.match(
        docker('run', '--rm', '-v', 'tug_runtest_vol:/d', 'alpine', 'cat', '/d/f').stdout,
        /kept/,
        'the service volume is mounted and writes persist',
      );
      assert.equal(
        docker('ps', '-aq', '--filter', 'label=tug.job=run').stdout.trim(),
        '',
        'the one-off container is removed',
      );

      // While running, a one-off must not look like a service container to reconciliation.
      const long = await startOneOff(engine, 'tug-runtest', ['sleep', '30']);
      assert.equal(
        await waitFor(() => containers('label=tug.job=run').length === 1),
        true,
        'the one-off container is running',
      );
      assert.equal(
        containers('label=tug.project=runtest').length,
        1,
        'only the service container carries the project label, so reconciliation ignores the one-off',
      );
      long.kill();
      assert.equal(
        await waitFor(() => containers('label=tug.job=run', true).length === 0),
        true,
        'cancelling removes it',
      );
    } finally {
      docker('rm', '-f', 'tug-runtest');
      docker('volume', 'rm', '-f', 'tug_runtest_vol');
    }
  },
);
