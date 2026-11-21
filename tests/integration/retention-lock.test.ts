import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { collect, runBackupJob } from '../../src/backup/job.ts';
import { RESTIC_EXIT_LOCKED } from '../../src/protocol.ts';
import { until } from '../wait.ts';
import type { BackupJobPayload } from '../../src/protocol.ts';

const RESTIC = process.env.TUG_RESTIC_IMAGE || 'restic/restic:0.19.1';
const REST_SERVER = process.env.TUG_REST_SERVER_IMAGE || 'restic/rest-server:0.14.0';
const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

const payload = (repo: string, extra: Partial<BackupJobPayload>): BackupJobPayload => ({
  runId: `bkr_${Math.random().toString(36).slice(2, 10)}`,
  project: 'retlock',
  target: 'volume:data',
  type: 'volume',
  repository: repo,
  resticImage: RESTIC,
  node: 'node1',
  tags: ['tug', 'project:retlock', 'target:volume:data', 'trigger:manual'],
  limits: { memory: '512m', timeoutSec: 600 },
  volume: { name: 'data', dockerVolume: 'tug_v7_retlock_data' },
  ...extra,
});

test(
  'against a real restic rest-server --append-only, pruning fails as a retention failure, and external retention skips it',
  { skip: !dockerUp, timeout: 300_000 },
  async () => {
    const engine = new DockerEngine();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-retlock-'));
    const server = 'tug-retlock-rest';
    docker('rm', '-f', server);
    docker('volume', 'rm', '-f', 'tug_v7_retlock_data');
    try {
      const started = docker(
        'run',
        '-d',
        '--name',
        server,
        '-v',
        `${dir}:/data`,
        REST_SERVER,
        'rest-server',
        '--path',
        '/data',
        '--no-auth',
        '--append-only',
      );
      assert.equal(started.status, 0, `rest-server should start: ${started.stderr}`);
      const ip = docker(
        'inspect',
        '-f',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        server,
      ).stdout.trim();
      assert.ok(ip, 'the rest-server has an address on the default bridge');
      const repo = `rest:http://${ip}:8000/retlock`;
      docker(
        'volume',
        'create',
        '--label',
        'tug.project=retlock',
        '--label',
        'tug.volume=data',
        'tug_v7_retlock_data',
      );
      docker(
        'run',
        '--rm',
        '-v',
        'tug_v7_retlock_data:/d',
        'alpine',
        'sh',
        '-c',
        'echo one > /d/a',
      );
      const credentials = { env: { RESTIC_PASSWORD: 'repo-password' } };
      await until(
        () =>
          // restic exits 10 for a repository that does not exist yet, which also means the server answered.
          docker(
            'run',
            '--rm',
            '-e',
            'RESTIC_PASSWORD=repo-password',
            RESTIC,
            '-r',
            repo,
            'cat',
            'config',
          ).status === 10,
        'the rest-server to answer',
        { timeoutMs: 60_000, intervalMs: 500 },
      );

      const run = (extra: Partial<BackupJobPayload> = {}) =>
        runBackupJob(payload(repo, extra), `cmd_${Math.random().toString(36).slice(2, 8)}`, {
          docker: engine,
          credentials,
        });
      const first = await run({ retention: { last: 1 } });
      assert.equal(
        first.retention?.state,
        'ok',
        'with a single snapshot there is nothing to remove, so the prune passes',
      );
      docker(
        'run',
        '--rm',
        '-v',
        'tug_v7_retlock_data:/d',
        'alpine',
        'sh',
        '-c',
        'echo two > /d/b',
      );
      const second = await run({ retention: { last: 1 } });
      assert.ok(second.snapshotId, 'the backup itself succeeds against an append-only server');
      assert.equal(
        second.retention?.state,
        'failed',
        'removing the older snapshot is refused, which is a retention failure',
      );
      assert.notEqual(
        second.retention?.locked,
        true,
        'an append-only refusal is not a lock failure',
      );
      assert.match(
        second.warnings?.[0] ?? '',
        /retention failed/,
        'the run carries the warning too',
      );

      docker(
        'run',
        '--rm',
        '-v',
        'tug_v7_retlock_data:/d',
        'alpine',
        'sh',
        '-c',
        'echo three > /d/c',
      );
      const third = await run({ retentionMode: 'external' });
      assert.ok(third.snapshotId, 'the backup succeeds');
      assert.deepEqual(
        third.retention,
        { state: 'external' },
        'external retention never tries to prune and so never fails',
      );
      assert.equal(third.warnings, undefined, 'and raises no warning');
    } finally {
      docker('rm', '-f', server);
      docker('volume', 'rm', '-f', 'tug_v7_retlock_data');
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'restic exits with code 11 when it cannot lock a repository another restic holds, which is what tug classifies as locked',
  { skip: !dockerUp, timeout: 180_000 },
  async () => {
    const engine = new DockerEngine();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-lockexit-'));
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo);
    const name = 'tug-lockexit';
    docker('rm', '-f', name);
    try {
      const id = await engine.createContainer(name, {
        Image: RESTIC,
        Entrypoint: ['sleep'],
        Cmd: ['86400'],
        Env: ['RESTIC_PASSWORD=pw', `RESTIC_REPOSITORY=${repo}`],
        HostConfig: { Binds: [`${repo}:${repo}`] },
      });
      await engine.startContainer(id);
      assert.equal(
        (await engine.execRun(id, ['restic', 'init'])).code,
        0,
        'the repository is created',
      );
      // A backup of an endless stream holds a shared lock; forget --prune needs the exclusive one.
      const holder = collect(
        await engine.execStart(id, { cmd: ['sh', '-c', 'yes | restic backup --stdin'] }),
      );
      holder.catch(() => undefined);
      await until(
        async () => (await fs.readdir(path.join(repo, 'locks')).catch(() => [])).length > 0,
        'the lock',
      );
      const blocked = await engine.execRun(id, [
        'restic',
        'forget',
        '--keep-last',
        '1',
        '--prune',
        '--retry-lock',
        '2s',
      ]);
      assert.equal(
        blocked.code,
        RESTIC_EXIT_LOCKED,
        `a prune that cannot take the lock exits ${RESTIC_EXIT_LOCKED} on this restic (stderr: ${blocked.err.trim().slice(-200)})`,
      );
    } finally {
      docker('rm', '-f', name);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
