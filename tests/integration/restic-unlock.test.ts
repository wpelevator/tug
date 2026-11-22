import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { collect, lockCount, runBackupJob } from '../../src/backup/job.ts';
import { unlockControlRepository } from '../../src/backup/control-backup.ts';
import { RESTIC_EXIT_LOCKED } from '../../src/protocol.ts';
import { until } from '../wait.ts';
import type { DockerApi } from '../../src/docker-api.ts';
import type { BackupJobPayload } from '../../src/protocol.ts';

import { ensureResticImage, lockFiles, removeAsRoot } from './restic-support.ts';
const RESTIC = process.env.TUG_RESTIC_IMAGE || 'restic/restic:0.19.1';

ensureResticImage(RESTIC);
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
    const locks = async () => lockFiles(repo);
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
      await removeAsRoot(repo);
    }
  },
);

/** The hostname the killed restic and the job's helper share, so restic can tell that the locker's process is gone. */
const SAME_HOST = 'tug-stale-lock-host';

/** The job code runs in containers it creates itself; this gives them a fixed hostname and changes nothing else. */
function withHostname(docker: DockerApi, hostname: string): DockerApi {
  return new Proxy(docker, {
    get(target, property, receiver) {
      if (property !== 'createContainer') return Reflect.get(target, property, receiver);
      return (name: string, body: Parameters<DockerApi['createContainer']>[1]) =>
        target.createContainer(name, { ...body, Hostname: hostname });
    },
  });
}

/**
 * Leaves an exclusive lock in `repo` from a restic that was killed: `prune` takes the exclusive lock, and SIGKILL
 * right after its lock file appears means it never releases it, which is what a node reboot or an out-of-memory
 * kill during a prune does. The lock is stale for restic because its host name matches this host and
 * its process is gone (restic's other test for stale, 30 minutes without a refresh, would need a 30 minute wait).
 * The repository holds some data so that the prune is still working when the kill arrives.
 */
async function leaveExclusiveStaleLock(engine: DockerEngine, repo: string, name: string) {
  cli('rm', '-f', name);
  const id = await engine.createContainer(name, {
    Image: RESTIC,
    Entrypoint: ['sleep'],
    Cmd: ['86400'],
    Hostname: SAME_HOST,
    Env: ['RESTIC_PASSWORD=pw', `RESTIC_REPOSITORY=${repo}`],
    HostConfig: { Binds: [`${repo}:${repo}`] },
  });
  await engine.startContainer(id);
  const run = async (...cmd: string[]) => {
    const result = await engine.execRun(id, ['restic', ...cmd]);
    assert.equal(result.code, 0, `restic ${cmd.join(' ')} should succeed: ${result.err}`);
  };
  await run('init');
  // Two snapshots with different content, so that forgetting one leaves packs to prune.
  await run('backup', '--host', 'node1', '/usr/bin');
  await run('backup', '--host', 'node1', '/usr/lib');
  await run('forget', '--keep-last', '1', '--group-by', '');
  // Burn process ids first: the helper that later runs unlock must not hold a process with the killed restic's pid,
  // or restic would take the lock for a live one. `prune` takes the exclusive lock first thing, so the lock file
  // that appears is already the exclusive one (`forget --prune` takes a shared lock before it).
  const script = [
    'i=0; while [ $i -lt 600 ]; do /bin/true; i=$((i+1)); done',
    `restic prune >/dev/null 2>&1 &`,
    'pid=$!',
    // The local backend writes a lock to a `...-tmp-<n>` file and renames it: killing before the rename leaves a stray file.
    `while [ -z "$(ls ${repo}/locks 2>/dev/null | grep -v tmp)" ]; do :; done`,
    'kill -KILL $pid',
    'wait $pid 2>/dev/null; true',
  ].join('\n');
  await engine.execRun(id, ['sh', '-c', script]);
  await engine.removeContainer(id);
  assert.equal(lockFiles(repo), 1, 'the killed prune left its lock behind');
  // Precondition, the defect: a plain read of the repository is refused, so a probe that locks cannot pass.
  const refused = cli(
    'run',
    '--rm',
    '-v',
    `${repo}:${repo}`,
    '-e',
    'RESTIC_PASSWORD=pw',
    RESTIC,
    '-r',
    repo,
    'cat',
    'config',
  );
  assert.equal(
    refused.status,
    RESTIC_EXIT_LOCKED,
    `an exclusive lock refuses even restic cat config (exit ${refused.status}: ${refused.stderr.slice(-200)})`,
  );
}

test(
  'the backup.unlock job, run through the job code, clears an exclusive stale lock that restic cat config is refused by',
  { skip: !dockerUp, timeout: 300_000 },
  async () => {
    const engine = new DockerEngine();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-unlock-excl-'));
    try {
      await leaveExclusiveStaleLock(engine, repo, 'tug-unlock-excl');
      const job: BackupJobPayload = {
        runId: 'unl_1',
        project: 'site',
        target: '',
        type: 'command',
        repository: repo,
        resticImage: RESTIC,
        node: 'node1',
        tags: ['tug', 'project:site'],
        limits: { memory: '512m', timeoutSec: 120 },
      };
      const result = await runBackupJob(
        job,
        'cmd_unl',
        {
          docker: withHostname(engine, SAME_HOST),
          credentials: { env: { RESTIC_PASSWORD: 'pw' } },
        },
        'backup.unlock',
      );
      assert.deepEqual(
        result.unlock,
        { before: 1, after: 0 },
        'the job saw the exclusive lock and plain restic unlock removed it',
      );
      assert.equal(lockFiles(repo), 0, 'no lock file is left in the repository');
      const after = cli(
        'run',
        '--rm',
        '-v',
        `${repo}:${repo}`,
        '-e',
        'RESTIC_PASSWORD=pw',
        RESTIC,
        '-r',
        repo,
        'cat',
        'config',
      );
      assert.equal(after.status, 0, 'the repository is usable again');
    } finally {
      await removeAsRoot(repo);
    }
  },
);

test(
  "control's unlock, run through the control backup code, clears an exclusive stale lock as well",
  { skip: !dockerUp, timeout: 300_000 },
  async () => {
    const engine = new DockerEngine();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-unlock-ctl-'));
    // The control repository is <destination>/_control.
    const repo = path.join(base, '_control');
    await fs.mkdir(repo);
    try {
      await leaveExclusiveStaleLock(engine, repo, 'tug-unlock-ctl');
      const result = await unlockControlRepository(withHostname(engine, SAME_HOST), {
        url: base,
        env: {},
        password: 'pw',
        resticImage: RESTIC,
      });
      assert.deepEqual(result, { before: 1, after: 0 }, 'the exclusive lock is removed');
      assert.equal(lockFiles(repo), 0, 'no lock file is left in the control repository');
    } finally {
      await removeAsRoot(base);
    }
  },
);
