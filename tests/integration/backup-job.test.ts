import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { runBackupJob } from '../../src/backup-job.ts';
import type { BackupJobPayload } from '../../src/protocol.ts';

const RESTIC = process.env.TUG_RESTIC_IMAGE || 'restic/restic:0.17.3';
const MARIADB = 'mariadb:11.4';
const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

const base = (repo: string, extra: Partial<BackupJobPayload>): BackupJobPayload => ({
  runId: `bkr_${Math.random().toString(36).slice(2, 10)}`,
  project: 'bkjob',
  target: 'service:db',
  type: 'mariadb',
  repository: repo,
  resticImage: RESTIC,
  node: 'node1',
  tags: ['tug', 'project:bkjob', 'target:service:db', 'trigger:manual'],
  limits: { memory: '512m', timeoutSec: 600 },
  ...extra,
});
const credentials = (env: Record<string, string> = { RESTIC_PASSWORD: 'repo-password' }) => ({
  env,
  secrets: { MARIADB_ROOT_PASSWORD: 'rootpw-123' },
});
const snapshots = (repo: string, password = 'repo-password') =>
  JSON.parse(
    docker(
      'run',
      '--rm',
      '-v',
      `${repo}:${repo}`,
      '-e',
      `RESTIC_PASSWORD=${password}`,
      RESTIC,
      '-r',
      repo,
      'snapshots',
      '--json',
    ).stdout || '[]',
  ) as { id: string; hostname: string; tags: string[]; paths: string[] }[];

test(
  'backs up a real MariaDB and a volume with restic, enforces retention and never leaves a bad snapshot',
  { skip: !dockerUp, timeout: 600_000 },
  async () => {
    const engine = new DockerEngine();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-bkjob-'));
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo);
    const network = 'tug_bkjob';
    docker('rm', '-f', 'tug-bkjob-db');
    docker('network', 'rm', network);
    assert.equal(
      docker('network', 'create', network).status,
      0,
      'a test network should be created',
    );
    try {
      const run = docker(
        'run',
        '-d',
        '--name',
        'tug-bkjob-db',
        '--network',
        network,
        '--network-alias',
        'db',
        '-e',
        'MARIADB_ROOT_PASSWORD=rootpw-123',
        '-e',
        'MARIADB_DATABASE=wordpress',
        MARIADB,
      );
      assert.equal(run.status, 0, run.stderr);
      // The image starts a temporary server to initialize, then the real one: wait for the second.
      for (let i = 0; ; i++) {
        const logs = docker('logs', 'tug-bkjob-db');
        const ready = `${logs.stdout}${logs.stderr}`.match(/ready for connections/g)?.length ?? 0;
        if (ready >= 2) break;
        assert.ok(i < 90, 'MariaDB should become ready');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const sql = (statement: string) =>
        docker(
          'exec',
          'tug-bkjob-db',
          'mariadb',
          '-uroot',
          '-prootpw-123',
          'wordpress',
          '-e',
          statement,
        );
      sql(
        'CREATE TABLE posts(id INT PRIMARY KEY, title VARCHAR(50)); INSERT INTO posts VALUES (1,"hello world");',
      );

      const service = {
        name: 'db',
        image: MARIADB,
        network,
        databases: ['wordpress'],
        user: 'root',
        passwordSecret: 'MARIADB_ROOT_PASSWORD',
      };
      const phases: string[] = [];
      const first = await runBackupJob(base(repo, { service, retention: { last: 2 } }), 'cmd_1', {
        docker: engine,
        credentials: credentials(),
        onPhase: (phase) => phases.push(phase),
      });
      assert.ok(first.snapshotId, 'a database backup should return a snapshot id');
      assert.ok((first.totalBytes ?? 0) > 0, 'the dump should have bytes');
      assert.ok(
        phases.includes('dumping') && phases.includes('uploading'),
        'phases should be reported',
      );
      const listed = snapshots(repo);
      assert.equal(listed.length, 1, 'one snapshot exists');
      assert.equal(listed[0].hostname, 'node1', 'the node name is the restic host');
      assert.ok(listed[0].tags.includes('target:service:db'), 'snapshots carry the target tag');

      const dump = docker(
        'run',
        '--rm',
        '-v',
        `${repo}:${repo}`,
        '-e',
        'RESTIC_PASSWORD=repo-password',
        RESTIC,
        '-r',
        repo,
        'dump',
        first.snapshotId!,
        'db.sql',
      );
      assert.match(dump.stdout, /hello world/, 'the snapshot contains the dumped row');
      assert.match(dump.stdout, /Dump completed/, 'the snapshot contains the full dump');

      for (let i = 0; i < 3; i++)
        await runBackupJob(base(repo, { service, retention: { last: 2 } }), `cmd_r${i}`, {
          docker: engine,
          credentials: credentials(),
        });
      assert.equal(snapshots(repo).length, 2, 'retention keeps the last two snapshots');

      const before = snapshots(repo).length;
      await assert.rejects(
        runBackupJob(
          base(repo, { service: { ...service, databases: ['nonexistent'] } }),
          'cmd_bad',
          { docker: engine, credentials: credentials() },
        ),
        /dump failed/,
        'a failing dump fails the job',
      );
      assert.equal(snapshots(repo).length, before, 'a failed dump leaves no snapshot behind');

      await assert.rejects(
        runBackupJob(base(repo, { service }), 'cmd_pw', {
          docker: engine,
          credentials: credentials({ RESTIC_PASSWORD: 'wrong' }),
        }),
        /repository check failed/,
        'a wrong repository password fails and does not re-initialize',
      );

      docker('volume', 'create', 'tug_bkjob_uploads');
      docker(
        'run',
        '--rm',
        '-v',
        'tug_bkjob_uploads:/d',
        'alpine',
        'sh',
        '-c',
        'echo photo > /d/a.jpg; mkdir /d/cache; echo junk > /d/cache/x',
      );
      const volumeResult = await runBackupJob(
        base(repo, {
          target: 'volume:uploads',
          type: 'volume',
          tags: ['tug', 'project:bkjob', 'target:volume:uploads'],
          volume: {
            name: 'uploads',
            mount: { kind: 'volume', name: 'tug_bkjob_uploads' },
            exclude: ['cache'],
          },
        }),
        'cmd_vol',
        { docker: engine, credentials: credentials() },
      );
      const files = docker(
        'run',
        '--rm',
        '-v',
        `${repo}:${repo}`,
        '-e',
        'RESTIC_PASSWORD=repo-password',
        RESTIC,
        '-r',
        repo,
        'ls',
        volumeResult.snapshotId!,
      );
      assert.match(files.stdout, /a\.jpg/, 'volume files are in the snapshot');
      assert.doesNotMatch(files.stdout, /cache\/x/, 'excluded paths are left out');

      assert.equal(
        docker('ps', '-aq', '--filter', 'label=tug.job').stdout.trim(),
        '',
        'no helper containers are left behind',
      );
    } finally {
      docker('rm', '-f', 'tug-bkjob-db');
      docker('network', 'rm', network);
      docker('volume', 'rm', '-f', 'tug_bkjob_uploads');
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
