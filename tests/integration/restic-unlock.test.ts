import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { collect, lockCount } from '../../src/backup/job.ts';
import { until } from '../wait.ts';

const RESTIC = process.env.TUG_RESTIC_IMAGE || 'restic/restic:0.19.1';
const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const cli = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

test(
  'restic unlock, as backup.unlock runs it, removes the lock of a killed restic and keeps the lock of a running one',
  { skip: !dockerUp, timeout: 180_000 },
  async () => {
    const engine = new DockerEngine();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-unlock-'));
    const name = 'tug-unlock-it';
    cli('rm', '-f', name);
    const locks = async () => (await fs.readdir(path.join(repo, 'locks')).catch(() => [])).length;
    try {
      const id = await engine.createContainer(name, {
        Image: RESTIC,
        Entrypoint: ['sleep'],
        Cmd: ['86400'],
        Env: ['RESTIC_PASSWORD=pw', `RESTIC_REPOSITORY=${repo}`],
        HostConfig: { Binds: [`${repo}:${repo}`] },
      });
      await engine.startContainer(id);
      assert.equal((await engine.execRun(id, ['restic', 'init'])).code, 0, 'the repository exists');

      // A restic killed outright leaves its lock; its process is gone on the same host, so restic counts it stale.
      const doomed = await engine.execStart(id, {
        cmd: ['sh', '-c', 'yes | restic backup --stdin --stdin-filename doomed'],
      });
      const doomedDone = collect(doomed);
      await until(async () => (await locks()) === 1, 'the first restic to take its lock');
      await engine.execRun(id, ['pkill', '-KILL', '-x', 'restic']);
      await doomedDone;
      assert.equal(await locks(), 1, 'a killed restic leaves its lock behind');

      // A restic that is still running holds a live lock.
      const live = await engine.execStart(id, {
        cmd: ['sh', '-c', 'yes | restic backup --stdin --stdin-filename live'],
      });
      const liveDone = collect(live);
      await until(async () => (await locks()) === 2, 'the second restic to take its lock');
      const listed = await engine.execRun(id, ['restic', 'list', 'locks', '--no-lock']);
      assert.equal(lockCount(listed.out), 2, 'lockCount reads the ids restic lists');

      const unlocked = await engine.execRun(id, ['restic', 'unlock']);
      assert.equal(unlocked.code, 0, `restic unlock should succeed: ${unlocked.err}`);
      assert.equal(await locks(), 1, 'the stale lock is removed and the live one is kept');
      const after = await engine.execRun(id, ['restic', 'list', 'locks', '--no-lock']);
      assert.equal(lockCount(after.out), 1, 'the listing agrees with the repository');

      await engine.execRun(id, ['pkill', '-INT', '-x', 'restic']);
      await liveDone;
      await engine.removeContainer(id);
    } finally {
      cli('rm', '-f', name);
      await fs.rm(repo, { recursive: true, force: true });
    }
  },
);
