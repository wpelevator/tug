import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { collect, stopResticGracefully } from '../../src/backup/job.ts';
import { until } from '../wait.ts';

import { ensureResticImage, lockFiles, removeAsRoot } from './restic-support.ts';
const RESTIC = process.env.TUG_RESTIC_IMAGE || 'restic/restic:0.19.1';

ensureResticImage(RESTIC);
const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const cli = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

/** A restic that holds a repository lock for as long as it runs: a backup of an endless stdin stream. */
async function holdingBackup(repo: string, name: string, engine: DockerEngine) {
  cli('rm', '-f', name);
  const id = await engine.createContainer(name, {
    Image: RESTIC,
    Entrypoint: ['sleep'],
    Cmd: ['86400'],
    Env: ['RESTIC_PASSWORD=pw', `RESTIC_REPOSITORY=${repo}`],
    HostConfig: { Binds: [`${repo}:${repo}`] },
  });
  await engine.startContainer(id);
  const init = await engine.execRun(id, ['restic', 'init']);
  assert.equal(init.code, 0, `the repository should be created: ${init.err}`);
  const proc = await engine.execStart(id, { cmd: ['sh', '-c', 'yes | restic backup --stdin'] });
  const done = collect(proc);
  const locks = async () => lockFiles(repo);
  await until(async () => (await locks()) > 0, 'restic to take its repository lock');
  return { id, done, locks };
}

test(
  'stopping a helper gracefully lets restic release its lock, while removing it outright leaves a stale lock',
  { skip: !dockerUp, timeout: 180_000 },
  async () => {
    const engine = new DockerEngine();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-stop-'));
    const forced = path.join(dir, 'forced');
    const graceful = path.join(dir, 'graceful');
    await fs.mkdir(forced);
    await fs.mkdir(graceful);
    try {
      // Control case: the helper is removed while restic runs, as before, so the lock outlives the process.
      const kill = await holdingBackup(forced, 'tug-stop-forced', engine);
      await engine.removeContainer(kill.id);
      assert.equal(
        await kill.locks(),
        1,
        'a restic killed by container removal leaves its lock behind (the failure this guards against)',
      );

      const stop = await holdingBackup(graceful, 'tug-stop-graceful', engine);
      const started = Date.now();
      await stopResticGracefully(engine, stop.id, 15_000);
      assert.ok(
        Date.now() - started < 12_000,
        'restic exits on SIGINT well inside the grace period, so the stop does not wait it out',
      );
      assert.equal(
        await stop.locks(),
        0,
        'restic releases its lock when interrupted, so no later backup is blocked',
      );
      await engine.removeContainer(stop.id);
    } finally {
      cli('rm', '-f', 'tug-stop-forced', 'tug-stop-graceful');
      await removeAsRoot(dir);
    }
  },
);
