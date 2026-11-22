import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerEngine } from '../../src/docker-api.ts';
import { runBackupJob } from '../../src/backup/job.ts';
import type { BackupJobPayload } from '../../src/protocol.ts';

import { ensureResticImage, openUp, removeAsRoot } from './restic-support.ts';
const RESTIC = process.env.TUG_RESTIC_IMAGE || 'restic/restic:0.19.1';

ensureResticImage(RESTIC);
const dockerUp = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const restic = (repo: string, ...args: string[]) =>
  spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${repo}:${repo}`,
      '-e',
      'RESTIC_PASSWORD=pw',
      RESTIC,
      '-r',
      repo,
      ...args,
    ],
    { encoding: 'utf8' },
  );

const payload = (repo: string, maintain: BackupJobPayload['maintain']): BackupJobPayload => ({
  runId: 'mnt_1',
  project: 'maint',
  target: '',
  type: 'command',
  repository: repo,
  resticImage: RESTIC,
  node: 'node1',
  tags: ['tug', 'project:maint', 'maintain', 'trigger:schedule'],
  limits: { memory: '512m', timeoutSec: 300 },
  maintain,
});

test(
  'a maintenance job prunes the forgotten data and checks a real repository, and a damaged pack fails the check',
  { skip: !dockerUp, timeout: 300_000 },
  async () => {
    const engine = new DockerEngine();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-maintain-'));
    try {
      assert.equal(restic(repo, 'init').status, 0, 'the repository is created');
      for (const dir of ['/etc', '/usr/share'])
        assert.equal(
          restic(repo, 'backup', '--host', 'node1', dir).status,
          0,
          `${dir} is backed up`,
        );
      const ids = JSON.parse(restic(repo, 'snapshots', '--json').stdout) as { id: string }[];
      assert.equal(ids.length, 2, 'two snapshots exist');
      // Forgetting alone leaves the data in the packs, as a per-run forget now does.
      assert.equal(restic(repo, 'forget', ids[1].id).status, 0, 'a snapshot is forgotten');
      openUp(repo); // restic wrote the packs as root; this test reads and damages them
      const dataBefore = (await fs.readdir(path.join(repo, 'data'))).length;

      const ok = await runBackupJob(
        payload(repo, { prune: true, subset: '1/2' }),
        'cmd_m1',
        { docker: engine, credentials: { env: { RESTIC_PASSWORD: 'pw' } } },
        'backup.maintain',
      );
      assert.deepEqual(
        ok.maintenance,
        { prune: 'ok', check: 'ok', subset: '1/2' },
        'prune and a partial data read both pass on a healthy repository',
      );
      assert.ok(dataBefore > 0, 'the repository holds data');

      // Damage a pack: the full data check must notice, and the job reports it as data.
      const dirs = await fs.readdir(path.join(repo, 'data'));
      let damaged = false;
      for (const dir of dirs) {
        for (const file of await fs.readdir(path.join(repo, 'data', dir))) {
          const target = path.join(repo, 'data', dir, file);
          const bytes = await fs.readFile(target);
          bytes[bytes.length - 1] ^= 0xff;
          await fs.writeFile(target, bytes);
          damaged = true;
          break;
        }
        if (damaged) break;
      }
      assert.ok(damaged, 'a pack was damaged');
      const bad = await runBackupJob(
        payload(repo, { prune: false, subset: '100%' }),
        'cmd_m2',
        { docker: engine, credentials: { env: { RESTIC_PASSWORD: 'pw' } } },
        'backup.maintain',
      );
      assert.equal(bad.maintenance?.check, 'failed', 'reading all data finds the damaged pack');
      assert.equal(bad.maintenance?.prune, 'skipped', 'a check-only run does not prune');
      assert.ok(bad.maintenance?.message, 'restic says what it found');
    } finally {
      await removeAsRoot(repo);
    }
  },
);

test(
  'a forget job removes a safety snapshot of the project and never a regular backup, a safety snapshot of another project, or a stale id',
  { skip: !dockerUp, timeout: 300_000 },
  async () => {
    const engine = new DockerEngine();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-forget-'));
    try {
      assert.equal(restic(repo, 'init').status, 0, 'the repository is created');
      const take = (tags: string[]) => {
        const run = restic(
          repo,
          'backup',
          '--host',
          'node1',
          '--json',
          ...tags.flatMap((tag) => ['--tag', tag]),
          '/etc/hostname',
        );
        assert.equal(run.status, 0, run.stderr);
        const summary = run.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((line) => line.message_type === 'summary');
        return summary.snapshot_id as string;
      };
      const safety = take(['project:maint', 'trigger:pre-restore']);
      const regular = take(['project:maint', 'trigger:schedule']);
      const other = take(['project:other', 'trigger:pre-restore']);
      const job = await runBackupJob(
        {
          ...payload(repo, undefined),
          forget: { snapshotIds: [safety, regular, other, 'deadbeef'] },
        },
        'cmd_f1',
        { docker: engine, credentials: { env: { RESTIC_PASSWORD: 'pw' } } },
        'backup.forget',
      );
      assert.deepEqual(
        job.forgotten,
        [safety.slice(0, 8)],
        'only the project safety snapshot is forgotten',
      );
      const left = (JSON.parse(restic(repo, 'snapshots', '--json').stdout) as { id: string }[]).map(
        (snapshot) => snapshot.id.slice(0, 8),
      );
      assert.deepEqual(
        left.sort(),
        [regular.slice(0, 8), other.slice(0, 8)].sort(),
        'a regular backup and another project safety snapshot are untouched',
      );
    } finally {
      await removeAsRoot(repo);
    }
  },
);
