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
  type: 'command',
  repository: repo,
  resticImage: RESTIC,
  node: 'node1',
  tags: ['tug', 'project:bkjob', 'target:service:db', 'trigger:manual'],
  limits: { memory: '512m', timeoutSec: 600 },
  ...extra,
});
const credentials = (env: Record<string, string> = { RESTIC_PASSWORD: 'repo-password' }) => ({
  env,
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
        '--label',
        'tug.project=bkjob',
        '--label',
        'tug.service=db',
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

      // The command is whatever the operator wrote; Tug runs it in the service's container and stores its output.
      const commandFor = (databases: string) => ({
        service: 'db',
        argv: [
          'sh',
          '-c',
          `mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --databases ${databases}`,
        ],
        filename: 'db.sql',
        verify: '-- Dump completed',
      });
      const service = commandFor('wordpress');
      const phases: string[] = [];
      const first = await runBackupJob(
        base(repo, { command: service, retention: { last: 2 } }),
        'cmd_1',
        {
          docker: engine,
          credentials: credentials(),
          onPhase: (phase) => phases.push(phase),
        },
      );
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
        await runBackupJob(base(repo, { command: service, retention: { last: 2 } }), `cmd_r${i}`, {
          docker: engine,
          credentials: credentials(),
        });
      assert.equal(snapshots(repo).length, 2, 'retention keeps the last two snapshots');

      const before = snapshots(repo).length;
      await assert.rejects(
        runBackupJob(base(repo, { command: commandFor('nonexistent') }), 'cmd_bad', {
          docker: engine,
          credentials: credentials(),
        }),
        /the command exited with code/,
        'a failing command fails the job',
      );
      assert.equal(snapshots(repo).length, before, 'a failed dump leaves no snapshot behind');

      await assert.rejects(
        runBackupJob(base(repo, { command: service }), 'cmd_pw', {
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
            dockerVolume: 'tug_bkjob_uploads',
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

      // ---- Restore: also generic, the operator supplies the command that loads the stored file back ----
      const restoreCommand = {
        ...service,
        restoreArgv: ['sh', '-c', 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"'],
      };
      const fresh = await runBackupJob(
        base(repo, { command: service, retention: { last: 5 } }),
        'cmd_fresh',
        { docker: engine, credentials: credentials() },
      );
      const restorePayload = (extra: Partial<BackupJobPayload>) =>
        base(repo, { ...extra, restore: { snapshotId: fresh.snapshotId!, mode: 'in-place' } });
      sql('DELETE FROM posts; INSERT INTO posts VALUES (2,"damaged");');
      await runBackupJob(
        restorePayload({ command: restoreCommand }),
        'cmd_restore',
        {
          docker: engine,
          credentials: credentials(),
        },
        'backup.restore',
      );
      const rows = sql('SELECT title FROM posts').stdout;
      assert.match(rows, /hello world/, 'the restore command loaded the snapshot back');
      assert.doesNotMatch(rows, /damaged/, 'the damaged data was replaced by the dump');

      await assert.rejects(
        runBackupJob(
          restorePayload({ command: service }),
          'cmd_norestore',
          {
            docker: engine,
            credentials: credentials(),
          },
          'backup.restore',
        ),
        /no x-tug\.backup\.restore command/,
        'a target without a restore command cannot be restored',
      );
      await assert.rejects(
        runBackupJob(
          base(repo, {
            target: 'volume:uploads',
            type: 'volume',
            volume: { name: 'uploads', dockerVolume: 'tug_bkjob_uploads' },
            restore: { snapshotId: fresh.snapshotId!, mode: 'in-place' },
          }),
          'cmd_wrong',
          { docker: engine, credentials: credentials() },
          'backup.restore',
        ),
        /is not a volume:uploads backup/,
        'a snapshot of another target is never restored into this one',
      );

      // Volume: change files, restore in place, then restore into a scratch volume.
      docker(
        'run',
        '--rm',
        '-v',
        'tug_bkjob_uploads:/d',
        'alpine',
        'sh',
        '-c',
        'rm /d/a.jpg; echo new > /d/b.jpg',
      );
      const volumeRestore = (mode: 'in-place' | 'scratch', scratchVolume?: string) =>
        base(repo, {
          target: 'volume:uploads',
          type: 'volume',
          tags: ['tug', 'project:bkjob', 'target:volume:uploads'],
          volume: { name: 'uploads', dockerVolume: 'tug_bkjob_uploads' },
          restore: { snapshotId: volumeResult.snapshotId!, mode, scratchVolume },
        });
      await runBackupJob(
        volumeRestore('in-place'),
        'cmd_vrestore',
        { docker: engine, credentials: credentials() },
        'backup.restore',
      );
      const listing = docker(
        'run',
        '--rm',
        '-v',
        'tug_bkjob_uploads:/d',
        'alpine',
        'ls',
        '/d',
      ).stdout;
      assert.match(listing, /a\.jpg/, 'the original file is back');
      assert.doesNotMatch(
        listing,
        /b\.jpg/,
        'files created after the backup are removed by an in-place restore',
      );

      docker('volume', 'rm', '-f', 'tug_bkjob_scratch');
      await runBackupJob(
        volumeRestore('scratch', 'tug_bkjob_scratch'),
        'cmd_vscratch',
        { docker: engine, credentials: credentials() },
        'backup.restore',
      );
      assert.match(
        docker('run', '--rm', '-v', 'tug_bkjob_scratch:/d', 'alpine', 'ls', '/d').stdout,
        /a\.jpg/,
        'a scratch restore materializes the files in a separate volume',
      );
      assert.match(
        docker('run', '--rm', '-v', 'tug_bkjob_uploads:/d', 'alpine', 'ls', '/d').stdout,
        /a\.jpg/,
        'the live volume is untouched by a scratch restore',
      );

      assert.equal(
        docker('ps', '-aq', '--filter', 'label=tug.job').stdout.trim(),
        '',
        'no helper containers are left behind',
      );
    } finally {
      docker('rm', '-f', 'tug-bkjob-db');
      docker('network', 'rm', network);
      docker('volume', 'rm', '-f', 'tug_bkjob_uploads', 'tug_bkjob_scratch');
      // restic runs as root in its container, so on Linux the repository is not removable by this user.
      docker('run', '--rm', '-v', `${dir}:/work`, 'alpine', 'rm', '-rf', '/work/repo');
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
