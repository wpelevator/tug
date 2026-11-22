import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTIC_LOCK_WAIT, RESTIC_LOCK_WAIT_MS, RESTIC_STALL_MS, runBackupJob } from './job.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { RESTIC_EXIT_LOCKED } from '../protocol.ts';
import type { BackupJobPayload } from '../protocol.ts';

const RESTIC = 'restic/restic:0.19.1';
const credentials = { env: { RESTIC_PASSWORD: 'repo-password-xyz' } };
const LOCKED =
  'unable to create lock in backend: repository is already locked exclusively by PID 1 on 4f1c2a (lock was created at 2026-11-22 10:00:00, 31m21s ago)\nthe `unlock` command can be used to remove stale locks';

const payload = (overrides: Partial<BackupJobPayload> = {}): BackupJobPayload => ({
  runId: 'bkr_lock',
  project: 'site',
  target: 'volume:uploads',
  type: 'volume',
  repository: 's3:https://s3.example.com/bucket/site',
  resticImage: RESTIC,
  node: 'app1',
  tags: ['tug', 'project:site', 'target:volume:uploads'],
  limits: { memory: '512m', timeoutSec: 60 },
  volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
  ...overrides,
});

const SNAPSHOTS = JSON.stringify([
  { id: 'aaaaaaaa11112222', short_id: 'aaaaaaaa', tags: ['project:site', 'target:volume:uploads'] },
]);

function dockerWith(responder: FakeDocker['execResponder']): FakeDocker {
  const docker = new FakeDocker();
  docker.addImage(RESTIC);
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  docker.execResponder = responder;
  return docker;
}

const resticCommands = (docker: FakeDocker): string[][] =>
  docker.execOptions.map((o) => o.cmd).filter((cmd) => cmd[0] === 'restic');

/** What restic does with an exclusive lock in the repository: every command that locks fails with exit 11. */
const exclusivelyLocked =
  (rest?: FakeDocker['execResponder']): FakeDocker['execResponder'] =>
  (cmd) => {
    const [, sub] = cmd;
    const locking =
      cmd[0] === 'restic' &&
      !cmd.includes('--no-lock') &&
      !['unlock', 'version', 'init'].includes(sub);
    if (locking) return { code: RESTIC_EXIT_LOCKED, err: LOCKED };
    return rest?.(cmd) ?? { code: 0 };
  };

test('the lock wait is shorter than the stall limit, so a restic waiting for a lock is not failed as stalled', () => {
  assert.ok(
    RESTIC_STALL_MS > RESTIC_LOCK_WAIT_MS,
    'a command that waits the whole lock wait without output must not hit the stall limit first',
  );
});

test('an unlock job runs against an exclusive stale lock: its probe takes no lock and plain restic unlock removes it', async () => {
  let listed = 0;
  const docker = dockerWith(
    exclusivelyLocked((cmd) => {
      if (cmd.join(' ') === 'restic list locks --no-lock') {
        listed++;
        return { code: 0, out: listed === 1 ? 'aaaaaaaa11\n' : '' };
      }
      return { code: 0 };
    }),
  );
  const result = await runBackupJob(payload(), 'cmd_u', { docker, credentials }, 'backup.unlock');
  assert.deepEqual(
    result.unlock,
    { before: 1, after: 0 },
    'the exclusive lock is seen and removed although every locking command is refused',
  );
  const commands = resticCommands(docker).map((cmd) => cmd.join(' '));
  assert.ok(
    commands.includes('restic cat config --no-lock'),
    'the repository probe is read without a lock',
  );
  assert.ok(commands.includes('restic unlock'), 'plain restic unlock ran');
  assert.ok(
    !commands.some((line) => line.includes('--remove-all')),
    'unlock never removes a lock a live restic holds',
  );
  assert.ok(
    !commands.some((line) => line.startsWith('restic unlock') && line.includes('--retry-lock')),
    'unlock does not wait for a lock: it is the command that removes them',
  );
});

test('a backup that meets a lock reaches restic backup with the lock wait and fails as locked there, not at the probe', async () => {
  const docker = dockerWith(exclusivelyLocked());
  await assert.rejects(
    runBackupJob(payload(), 'cmd_b', { docker, credentials }, 'backup.run'),
    (error: Error & { jobCause?: string }) => {
      assert.equal(error.jobCause, 'locked', 'restic exit code 11 marks the failure as locked');
      assert.match(error.message, /backup failed/, 'the failure is the backup, not the probe');
      return true;
    },
  );
  const backup = resticCommands(docker).find((cmd) => cmd[1] === 'backup');
  assert.ok(backup, 'the probe passed, so restic backup ran');
  assert.deepEqual(
    backup.slice(backup.indexOf('--retry-lock')),
    ['--retry-lock', RESTIC_LOCK_WAIT],
    'restic backup waits for the lock',
  );
});

test('every restic command that takes a repository lock waits for it, in every kind of job', async () => {
  const LOCKING = ['backup', 'forget', 'prune', 'check', 'snapshots', 'dump', 'restore'];
  const kinds: [BackupJobPayload, Parameters<typeof runBackupJob>[3]][] = [
    [payload(), 'backup.run'],
    [
      payload({
        runId: 'rst_lock',
        restore: { snapshotId: 'aaaaaaaa', mode: 'in-place' },
      }),
      'backup.restore',
    ],
    [payload({ forget: { snapshotIds: ['aaaaaaaa11112222'] } }), 'backup.forget'],
    [payload({ maintain: { prune: true, subset: '5%' } }), 'backup.maintain'],
    [payload(), 'backup.unlock'],
    [payload(), 'backup.check'],
  ];
  for (const [job, kind] of kinds) {
    const docker = dockerWith((cmd) => {
      if (cmd[1] === 'snapshots') return { code: 0, out: SNAPSHOTS };
      if (cmd[1] === 'backup')
        return { code: 0, out: '{"message_type":"summary","snapshot_id":"abc123def456"}\n' };
      return { code: 0 };
    });
    await runBackupJob(job, 'cmd_k', { docker, credentials }, kind);
    for (const cmd of resticCommands(docker)) {
      const line = cmd.join(' ');
      if (cmd[1] === 'cat')
        assert.ok(cmd.includes('--no-lock'), `${kind}: the probe "${line}" takes no lock`);
      else if (LOCKING.includes(cmd[1]))
        assert.ok(
          cmd.join(' ').includes(`--retry-lock ${RESTIC_LOCK_WAIT}`),
          `${kind}: "${line}" must wait for the repository lock like restic backup does`,
        );
    }
  }
});

test('a retention failure on an append-only destination is reported as the refusal with the external-retention hint, not a stack tail', async () => {
  const forgetOutput = [
    '[0:00] 0.00%  0 / 1 files deleted',
    'Remove(<snapshot/202d03c576>) failed: unexpected HTTP response (403): 403 Forbidden',
    'unable to remove snapshot/202d03c5 from the repository',
    'failed to remove one or more snapshots',
    'main.init',
    '\t/restic/cmd/restic/cmd_forget.go:67',
    'runtime.doInit1',
    '\t/usr/local/go/src/runtime/proc.go:8103',
    'runtime.main',
    '\t/usr/local/go/src/runtime/proc.go:258',
  ].join('\n');
  const docker = dockerWith((cmd) => {
    if (cmd[1] === 'backup')
      return { code: 0, out: '{"message_type":"summary","snapshot_id":"abc123def456"}\n' };
    if (cmd[1] === 'forget') return { code: 1, err: forgetOutput };
    return { code: 0 };
  });
  const result = await runBackupJob(
    payload({ retention: { last: 1 } }),
    'cmd_r',
    { docker, credentials },
    'backup.run',
  );
  assert.equal(result.retention?.state, 'failed', 'the backup succeeds and retention fails');
  assert.match(result.retention?.message ?? '', /403 Forbidden/, 'the 403 line is kept');
  assert.ok(!/runtime\.|main\.init|proc\.go/.test(result.retention?.message ?? ''), 'no stack');
  assert.match(
    result.retention?.message ?? '',
    /tug backup destination set --retention external/,
    'the message says how to stop the failure',
  );
  assert.notEqual(result.retention?.locked, true, 'a refusal is not a lock');
});

test("a retention failure on restic exit 11 is marked locked and keeps restic's lock message", async () => {
  const docker = dockerWith((cmd) => {
    if (cmd[1] === 'backup')
      return { code: 0, out: '{"message_type":"summary","snapshot_id":"abc123def456"}\n' };
    if (cmd[1] === 'forget') return { code: RESTIC_EXIT_LOCKED, err: LOCKED };
    return { code: 0 };
  });
  const result = await runBackupJob(
    payload({ retention: { last: 1 } }),
    'cmd_l',
    { docker, credentials },
    'backup.run',
  );
  assert.equal(result.retention?.locked, true, 'exit code 11 marks the retention failure locked');
  assert.match(
    result.retention?.message ?? '',
    /locked exclusively/,
    "restic's lock message is kept",
  );
});
