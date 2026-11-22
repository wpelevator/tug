import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PassThrough } from 'node:stream';
import { JobRunner, defaultJobConcurrency, laneOf } from './jobs.ts';
import {
  RESTIC_LOCK_WAIT_MS,
  RESTIC_STALL_MS,
  backupArgs,
  forgetArgs,
  memoryBytes,
  parseSummary,
  removeStaleJobContainers,
  runBackupJob,
} from '../backup/job.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { JOB_CANCELLED } from '../protocol.ts';
import type { BackupJobPayload, Command } from '../protocol.ts';
import { until } from '../../tests/wait.ts';

const payload = (overrides: Partial<BackupJobPayload> = {}): BackupJobPayload => ({
  runId: 'bkr_1',
  project: 'site',
  target: 'service:db',
  type: 'command',
  repository: 's3:https://s3.example.com/bucket/site',
  resticImage: 'restic/restic:0.19.1',
  node: 'app1',
  tags: ['tug', 'project:site', 'target:service:db', 'run:bkr_1'],
  limits: { memory: '512m', timeoutSec: 60 },
  ...overrides,
});
const command = (id: string, body: BackupJobPayload, type = 'backup.check'): Command => ({
  id,
  type,
  payload_json: JSON.stringify(body),
});
const credentials = {
  env: { RESTIC_PASSWORD: 'repo-password-xyz', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
};
async function runner(docker: FakeDocker, concurrency = 1) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-jobs-'));
  const jobs = new JobRunner({
    docker,
    stateDir,
    concurrency,
    fetchCredentials: async () => credentials,
  });
  return { jobs, stateDir };
}
const settle = (jobs: JobRunner, expected: number) =>
  until(() => jobs.pending().length >= expected, `${expected} finished job result(s)`);

function dockerWith(responder: FakeDocker['execResponder']): FakeDocker {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.execResponder = responder;
  return docker;
}

test('a check job reports a healthy repository and removes its helper container', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic version'
      ? { code: 0, out: 'restic 0.19.1 compiled with go1.22\n' }
      : { code: 0 },
  );
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', payload()));
  await settle(jobs, 1);
  const [result] = jobs.pending();
  assert.equal(result.state, 'succeeded', 'the check should succeed');
  assert.deepEqual(
    (result.result as { repository?: string; resticVersion?: string }).repository,
    'ok',
    'an existing repository is reported ok',
  );
  assert.equal((result.result as { resticVersion?: string }).resticVersion, '0.19.1');
  assert.deepEqual(docker.names(), [], 'the helper container is removed after the job');
});

const REST_MISSING =
  'Fatal: repository does not exist: unable to open config file: <config/> does not exist\nIs there a repository at the following location?\nrest:http://backup.internal:8030/tug/site/';
const S3_NO_KEY =
  'Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.\nIs there a repository at the following location?\ns3:http://s3.example.com/exists/tug';
const BUCKET_MISSING =
  'Fatal: unable to open config file: Stat: The specified bucket does not exist.\nIs there a repository at the following location?';

async function finished(docker: FakeDocker, kind: string) {
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', payload(), kind));
  await settle(jobs, 1);
  return jobs.pending()[0];
}
const ran = (docker: FakeDocker, cmd: string) =>
  docker.execOptions.some((e) => e.cmd.join(' ') === cmd);

test('a run job initializes a repository restic reports as missing with exit 10, on REST and S3', async () => {
  for (const [what, err] of [
    ['a REST server', REST_MISSING],
    ['an S3 key that does not exist', S3_NO_KEY],
  ] as const) {
    const docker = dockerWith((cmd) =>
      cmd.join(' ') === 'restic cat config --no-lock' ? { code: 10, err } : { code: 0 },
    );
    const result = await finished(docker, 'backup.run');
    assert.ok(
      !/repository check failed|repository init failed/.test(JSON.stringify(result.result)),
      `${what} without a repository must not fail the repository check`,
    );
    assert.ok(ran(docker, 'restic init'), `${what}: restic init ran`);
  }
});

test('a check job only reports a missing repository and never initializes it', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock' ? { code: 10, err: REST_MISSING } : { code: 0 },
  );
  const result = await finished(docker, 'backup.check');
  assert.equal(result.state, 'succeeded', 'a missing repository is not a failed check');
  assert.equal(
    (result.result as { repository?: string }).repository,
    'missing',
    'the check reports the repository as missing',
  );
  assert.ok(!ran(docker, 'restic init'), 'backup.check is read-only');
});

test('a missing bucket (exit 1) and a wrong password (exit 12) fail a run job without init', async () => {
  for (const [what, code, err, expected] of [
    ['a missing bucket', 1, BUCKET_MISSING, /bucket does not exist/],
    ['a wrong password', 12, 'Fatal: wrong password or no key found', /wrong repository password/],
  ] as const) {
    const docker = dockerWith((cmd) =>
      cmd.join(' ') === 'restic cat config --no-lock' ? { code, err } : { code: 0 },
    );
    const result = await finished(docker, 'backup.run');
    assert.equal(result.state, 'failed', `${what} fails the job`);
    assert.match(JSON.stringify(result.result), expected, `${what} is explained`);
    assert.ok(!ran(docker, 'restic init'), `${what} must never create a repository or bucket`);
  }
});

test('a restore job fails on a missing repository instead of creating one', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock' ? { code: 10, err: REST_MISSING } : { code: 0 },
  );
  const result = await finished(docker, 'backup.restore');
  assert.equal(result.state, 'failed', 'there is nothing to restore from');
  assert.ok(!ran(docker, 'restic init'), 'a restore never initializes');
});

test('an unlock job removes only stale locks: plain restic unlock, never --remove-all, and reports the counts', async () => {
  let listed = 0;
  const docker = dockerWith((cmd) => {
    const line = cmd.join(' ');
    if (line === 'restic list locks --no-lock') {
      listed++;
      // Three locks before the unlock; the one a live restic holds remains after.
      return {
        code: 0,
        out: listed === 1 ? 'aaaaaaaa11\nbbbbbbbb22\ncccccccc33\n' : 'cccccccc33\n',
      };
    }
    return { code: 0 };
  });
  const result = await finished(docker, 'backup.unlock');
  assert.equal(result.state, 'succeeded', 'the unlock succeeds');
  assert.deepEqual(
    (result.result as { unlock?: unknown }).unlock,
    { before: 3, after: 1 },
    'the result carries the lock counts before and after',
  );
  assert.ok(ran(docker, 'restic unlock'), 'restic unlock ran');
  assert.ok(
    !docker.execOptions.some((e) => e.cmd.includes('--remove-all')),
    'unlock never passes --remove-all, which would remove the lock of a live prune',
  );
  assert.ok(!ran(docker, 'restic init'), 'an unlock never initializes a repository');
});

test('an unlock job fails on a missing repository instead of creating one', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock' ? { code: 10, err: REST_MISSING } : { code: 0 },
  );
  const result = await finished(docker, 'backup.unlock');
  assert.equal(result.state, 'failed', 'there is nothing to unlock');
  assert.ok(!ran(docker, 'restic init'), 'an unlock never initializes');
});

const maintained = async (
  maintain: BackupJobPayload['maintain'],
  responder: FakeDocker['execResponder'],
) => {
  const docker = dockerWith(responder);
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', payload({ maintain }), 'backup.maintain'));
  await settle(jobs, 1);
  return { docker, result: jobs.pending()[0] };
};

test('a maintenance job prunes, then checks, and reports both; a subset is passed to the check', async () => {
  const { docker, result } = await maintained({ prune: true, subset: '5%' }, () => ({ code: 0 }));
  assert.equal(result.state, 'succeeded', 'the job succeeds');
  assert.deepEqual(
    (result.result as { maintenance?: unknown }).maintenance,
    { prune: 'ok', check: 'ok', subset: '5%' },
    'prune and check outcomes are structured',
  );
  const lines = docker.execOptions.map((e) => e.cmd.join(' '));
  const prune = lines.findIndex((line) => line.startsWith('restic prune'));
  const check = lines.findIndex((line) => line.startsWith('restic check'));
  assert.ok(prune >= 0 && check > prune, 'the prune runs before the check');
  assert.match(lines[check], /--read-data-subset=5%/, 'the check reads the requested subset');
  assert.match(lines[prune], /--retry-lock 10m/, 'the prune waits for the repository lock');
});

test('a maintenance job without prune only checks, so an append-only destination is never asked to delete', async () => {
  const { docker, result } = await maintained({ prune: false }, () => ({ code: 0 }));
  assert.deepEqual(
    (result.result as { maintenance?: unknown }).maintenance,
    { prune: 'skipped', check: 'ok' },
    'the prune is reported as skipped',
  );
  assert.ok(!docker.execOptions.some((e) => e.cmd[1] === 'prune'), 'restic prune did not run');
});

test('a failed prune does not stop the check, and a failed check or a lock exit is reported as data', async () => {
  const { result } = await maintained({ prune: true }, (cmd) =>
    cmd[1] === 'prune'
      ? { code: 11, err: 'unable to create lock in backend' }
      : cmd[1] === 'check'
        ? { code: 1, err: 'error: pack abc: ciphertext verification failed' }
        : { code: 0 },
  );
  assert.equal(result.state, 'succeeded', 'a failing repository is a result, not a failed job');
  const outcome = (result.result as { maintenance?: Record<string, unknown> }).maintenance!;
  assert.equal(outcome.prune, 'failed', 'the prune failure is recorded');
  assert.equal(outcome.check, 'failed', 'the check still ran and failed');
  assert.equal(outcome.locked, true, "restic's lock exit code, not its wording, marks it locked");
  assert.match(String(outcome.message), /prune failed/, 'the first failure is the message');
});

test('a maintenance job fails on a missing repository instead of creating one', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock' ? { code: 10, err: REST_MISSING } : { code: 0 },
  );
  const result = await finished(docker, 'backup.maintain');
  assert.equal(result.state, 'failed', 'there is nothing to check');
  assert.ok(!ran(docker, 'restic init'), 'maintenance never initializes');
});

test('a forget job forgets only the safety snapshots restic lists for the project, and a missing one is already gone', async () => {
  const listings: string[] = [];
  const docker = dockerWith((cmd) => {
    const line = cmd.join(' ');
    if (cmd[1] === 'snapshots') {
      listings.push(line);
      return {
        code: 0,
        out: JSON.stringify([{ id: 'aaaaaaaa11112222', short_id: 'aaaaaaaa' }]),
      };
    }
    return { code: 0 };
  });
  const { jobs } = await runner(docker);
  await jobs.start(
    command(
      'cmd_1',
      payload({ forget: { snapshotIds: ['aaaaaaaa11112222', 'ffffffff99998888'] } }),
      'backup.forget',
    ),
  );
  await settle(jobs, 1);
  const [result] = jobs.pending();
  assert.equal(result.state, 'succeeded', 'the job succeeds');
  assert.deepEqual(
    (result.result as { forgotten?: string[] }).forgotten,
    ['aaaaaaaa'],
    'the snapshot restic lists is forgotten',
  );
  assert.match(
    listings[0],
    /--tag project:site,trigger:pre-restore/,
    "restic is asked for exactly this project's safety snapshots (AND, not OR)",
  );
  const forget = docker.execOptions
    .map((e) => e.cmd.join(' '))
    .find((c) => c.startsWith('restic forget'))!;
  assert.match(
    forget,
    /^restic forget aaaaaaaa11112222 --retry-lock/,
    'only the listed id is forgotten',
  );
  assert.ok(!forget.includes('ffffffff'), 'an id restic does not list is never passed to forget');
  assert.ok(!forget.includes('--prune'), 'a forget never prunes: the weekly maintenance does');
});

test('a forget job whose snapshots are all gone runs no forget', async () => {
  const docker = dockerWith((cmd) =>
    cmd[1] === 'snapshots' ? { code: 0, out: '[]' } : { code: 0 },
  );
  const { jobs } = await runner(docker);
  await jobs.start(
    command('cmd_1', payload({ forget: { snapshotIds: ['aaaaaaaa11112222'] } }), 'backup.forget'),
  );
  await settle(jobs, 1);
  assert.equal(jobs.pending()[0].state, 'succeeded', 'an already removed snapshot is not an error');
  assert.ok(!docker.execOptions.some((e) => e.cmd[1] === 'forget'), 'restic forget did not run');
});

test('error text never contains credentials', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock'
      ? {
          code: 1,
          err: 'Fatal: backend rejected key sekret-value-1 with password repo-password-xyz',
        }
      : { code: 0 },
  );
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', payload()));
  await settle(jobs, 1);
  const text = JSON.stringify(jobs.pending());
  assert.ok(!text.includes('sekret-value-1'), 'the access secret should be redacted');
  assert.ok(!text.includes('repo-password-xyz'), 'the repository password should be redacted');
  assert.match(text, /\[redacted\]/);
});

test('results survive a restart until acknowledged, and a job interrupted by a restart is reported failed', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  const { jobs, stateDir } = await runner(docker);
  await jobs.start(command('cmd_1', payload()));
  await settle(jobs, 1);
  // The result is in memory before the runner writes it, and a restart only sees the file.
  await until(
    async () =>
      (await fs.readFile(path.join(stateDir, 'job-results.json'), 'utf8').catch(() => '')).includes(
        'cmd_1',
      ),
    'the finished result written to job-results.json',
  );
  const restarted = new JobRunner({ docker, stateDir, fetchCredentials: async () => credentials });
  await restarted.start(command('cmd_bad', { ...payload(), repository: '' }));
  const ids = restarted
    .pending()
    .map((r) => r.commandId)
    .sort();
  assert.deepEqual(
    ids,
    ['cmd_1', 'cmd_bad'],
    'an unacknowledged result is delivered after a restart',
  );
  await restarted.acknowledge(restarted.pending());
  assert.equal(restarted.pending().length, 0, 'acknowledged results are dropped');

  await fs.writeFile(
    path.join(stateDir, 'job-results.json'),
    JSON.stringify({ results: [], running: ['cmd_lost'] }),
  );
  const third = new JobRunner({ docker, stateDir, fetchCredentials: async () => credentials });
  await third.start(command('cmd_2', { ...payload(), repository: '' }));
  assert.ok(
    third.pending().some((r) => r.commandId === 'cmd_lost' && r.state === 'failed'),
    'a job that was running when the agent stopped is reported failed',
  );
});

test('jobs beyond the concurrency limit wait queued and are reported as such', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config --no-lock' ? undefined : { code: 0 },
  );
  const { jobs } = await runner(docker, 1);
  await jobs.start(command('cmd_a', payload({ runId: 'bkr_a' })));
  await jobs.start(command('cmd_b', payload({ runId: 'bkr_b' })));
  await until(() => phaseOf(jobs, 'cmd_a') !== 'queued', 'the first job to start');
  const phases = Object.fromEntries(jobs.statuses().map((s) => [s.commandId, s.phase]));
  assert.equal(phases.cmd_b, 'queued', 'the second job waits while the first runs');
  assert.notEqual(phases.cmd_a, 'queued', 'the first job is running');
  await jobs.cancel('cmd_b');
  await jobs.cancel('cmd_a');
});

test('restic arguments carry the node as host, tags, retention and the stdin name', () => {
  const p = payload({ retention: { daily: 7, weekly: 4 } });
  const backup = backupArgs(p, 'db.sql').join(' ');
  assert.match(backup, /backup --stdin --stdin-filename db\.sql --json --host app1 --tag tug/);
  assert.match(backup, /--tag run:bkr_1/);
  const forget = forgetArgs(p, p.retention!).join(' ');
  assert.match(forget, /--tag target:service:db --host app1 --group-by host/);
  assert.match(forget, /--keep-daily 7 --keep-weekly 4 --retry-lock/);
  assert.ok(
    !forget.includes('--prune'),
    'a per-run forget never prunes: the exclusive lock is taken once a week by backup.maintain',
  );
  assert.match(
    forget,
    /--keep-tag trigger:pre-restore/,
    'safety snapshots outlive routine retention',
  );
  assert.throws(
    () => forgetArgs(p, {}),
    /keep no snapshots/,
    'an empty policy would delete everything',
  );
  const volume = backupArgs(
    payload({
      type: 'volume',
      target: 'volume:uploads',
      volume: { name: 'uploads', dockerVolume: 'x', exclude: ['cache/'] },
    }),
  ).join(' ');
  assert.match(volume, /^backup \/data --exclude cache\/ --json/);
});

test('restic summaries and memory limits parse', () => {
  const output = [
    '{"message_type":"status","percent_done":0.5}',
    '{"message_type":"summary","snapshot_id":"abc123","data_added":2048,"total_bytes_processed":4096}',
  ].join('\n');
  assert.deepEqual(parseSummary(output), {
    snapshotId: 'abc123',
    addedBytes: 2048,
    totalBytes: 4096,
  });
  assert.deepEqual(parseSummary('no json here'), {});
  assert.equal(memoryBytes('512m'), 512 * 1024 * 1024);
  assert.equal(memoryBytes('2g'), 2 * 1024 ** 3);
  assert.throws(() => memoryBytes('lots'), /invalid memory limit/);
});

test('a volume backup fails when the volume does not exist on the node instead of backing up an empty one', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  const { jobs } = await runner(docker);
  await jobs.start(
    command(
      'cmd_vol',
      payload({
        type: 'volume',
        target: 'volume:uploads',
        volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
      }),
      'backup.run',
    ),
  );
  await settle(jobs, 1);
  const [result] = jobs.pending();
  assert.equal(result.state, 'failed', 'a missing volume fails the job');
  assert.match(
    JSON.stringify(result.result),
    /volume tug_v4_site_uploads does not exist on this node/,
    'the error says which volume is missing',
  );
});

test('backup and restore reject a volume owned by another project', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  docker.volumes.set('tug_v4_site_data_uploads', {
    Name: 'tug_v4_site_data_uploads',
    Labels: { 'tug.project': 'site_data', 'tug.volume': 'uploads' },
  });
  const job = payload({
    type: 'volume',
    target: 'volume:data_uploads',
    volume: { name: 'data_uploads', dockerVolume: 'tug_v4_site_data_uploads' },
  });
  for (const kind of ['backup.run', 'backup.restore'] as const)
    await assert.rejects(
      runBackupJob(job, 'cmd', { docker, credentials }, kind),
      /not owned/,
      `${kind} must not access another project's volume`,
    );
  assert.equal(docker.names().length, 0, 'a refused volume must not be mounted by a helper');
});

test('scratch restore does not reuse an unrelated existing volume', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  docker.volumes.set('tug_site_restore-x', {
    Name: 'tug_site_restore-x',
    Labels: { 'tug.project': 'other' },
  });
  const job = payload({
    type: 'volume',
    target: 'volume:uploads',
    volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
    restore: { snapshotId: 'snap', mode: 'scratch', scratchVolume: 'tug_site_restore-x' },
  });
  await assert.rejects(
    runBackupJob(job, 'cmd', { docker, credentials }, 'backup.restore'),
    /not owned/,
    'a scratch restore must not overwrite an unrelated volume',
  );
  assert.equal(
    docker.names().length,
    0,
    'a refused scratch volume must not be mounted by a helper',
  );
});

test('scratch restore checks restore identity and can resume the same restore', async () => {
  const docker = dockerWith((cmd) =>
    cmd[0] === 'restic' && cmd[1] === 'snapshots'
      ? { code: 0, out: JSON.stringify([{ tags: ['project:site', 'target:volume:uploads'] }]) }
      : { code: 0 },
  );
  const job = payload({
    runId: 'rst_original',
    type: 'volume',
    target: 'volume:uploads',
    volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
    restore: { snapshotId: 'snap', mode: 'scratch', scratchVolume: 'tug_site_restore-x' },
  });
  await runBackupJob(job, 'first', { docker, credentials }, 'backup.restore');
  assert.equal(
    docker.volumes.get('tug_site_restore-x')?.Labels?.['tug.restore'],
    'rst_original',
    'the scratch volume identifies its restore',
  );
  await runBackupJob(job, 'resume', { docker, credentials }, 'backup.restore');
  await assert.rejects(
    runBackupJob(
      { ...job, runId: 'rst_other' },
      'other',
      { docker, credentials },
      'backup.restore',
    ),
    /not owned/,
    'another restore in the same project must not reuse the scratch volume',
  );
});

const SNAPSHOT_LISTING = JSON.stringify([{ tags: ['project:site', 'target:volume:uploads'] }]);
const volumeRestore = (mode: 'in-place' | 'scratch') =>
  payload({
    runId: 'rst_abc123',
    type: 'volume',
    target: 'volume:uploads',
    volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
    restore: {
      snapshotId: 'snap',
      mode,
      ...(mode === 'scratch' ? { scratchVolume: 'tug_site_restore-x' } : {}),
    },
  });

test('an in-place volume restore reads and verifies the snapshot beside the live data before replacing it', async () => {
  const docker = dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'snapshots') return { code: 0, out: SNAPSHOT_LISTING };
    return { code: 0 };
  });
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  await runBackupJob(volumeRestore('in-place'), 'cmd', { docker, credentials }, 'backup.restore');
  const commands = docker.execOptions.map((o) => o.cmd.join(' '));
  const restored = commands.findIndex((c) => c.startsWith('restic restore'));
  const swapped = commands.findIndex((c) => c.startsWith('sh -ec'));
  assert.ok(
    restored >= 0 && swapped > restored,
    'the live data is replaced only after restic finished',
  );
  assert.match(
    commands[restored],
    /--target \/data\/\.tug-restore-rst_abc123 .*--verify|--verify.*--target/,
    'the snapshot is restored beside the live data and verified',
  );
  assert.ok(
    !commands.some((c) => c.includes('-mindepth 1 -delete')),
    'the volume is never emptied before the snapshot has been read',
  );
});

test('a scratch restore still restores straight into its empty volume', async () => {
  const docker = dockerWith((cmd) =>
    cmd[0] === 'restic' && cmd[1] === 'snapshots'
      ? { code: 0, out: SNAPSHOT_LISTING }
      : { code: 0 },
  );
  await runBackupJob(volumeRestore('scratch'), 'cmd', { docker, credentials }, 'backup.restore');
  const restore = docker.execOptions
    .map((o) => o.cmd.join(' '))
    .find((c) => c.startsWith('restic restore'));
  assert.match(restore ?? '', /--target \/ /, 'a scratch restore targets / so files land in /data');
});

test('a restore that makes no progress fails with a clear error and leaves the live volume alone', async () => {
  const docker = dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'snapshots') return { code: 0, out: SNAPSHOT_LISTING };
    if (cmd[0] === 'restic' && cmd[1] === 'restore') return undefined; // restic retrying a failing store: no exit, no progress
    return { code: 0 };
  });
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  await assert.rejects(
    runBackupJob(
      volumeRestore('in-place'),
      'cmd',
      { docker, credentials, stallMs: 80 },
      'backup.restore',
    ),
    /made no progress for .*unreadable or the backup store unreachable/,
    'a stalled restore fails instead of waiting for the job limit',
  );
  const commands = docker.execOptions.map((o) => o.cmd.join(' '));
  assert.ok(
    !commands.some((c) => c.startsWith('sh -ec')),
    'the live volume is not touched when the snapshot could not be read',
  );
  assert.ok(
    commands.some((c) => c === 'rm -rf /data/.tug-restore-rst_abc123'),
    'the partial staging copy is removed',
  );
  assert.equal(docker.names().length, 0, 'the helper containers are removed');
});

test('cancelling a job reaches a restic command that never returns', async () => {
  const docker = dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'snapshots') return { code: 0, out: SNAPSHOT_LISTING };
    if (cmd[0] === 'restic' && cmd[1] === 'restore') return undefined;
    return { code: 0 };
  });
  const controller = new AbortController();
  const running = runBackupJob(
    volumeRestore('scratch'),
    'cmd',
    { docker, credentials, signal: controller.signal },
    'backup.restore',
  );
  setTimeout(() => controller.abort(new Error('the job exceeded its 5s limit')), 50);
  await assert.rejects(running, /exceeded its 5s limit/, 'the time limit ends a hung restore');
  assert.equal(docker.names().length, 0, 'the helper containers are removed after the abort');
});

const SUMMARY =
  '{"message_type":"summary","snapshot_id":"snap1234","data_added":10,"total_bytes_processed":20}\n';

/** A project with a running `db` container whose command output and exit code the test scripts. */
async function dockerWithService(command: { code: number; out?: string; err?: string }) {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.addImage('db');
  const id = await docker.createContainer('site-db-1', {
    Image: 'db',
    Labels: { 'tug.project': 'site', 'tug.service': 'db' },
  });
  await docker.startContainer(id);
  docker.execResponder = (cmd) => {
    if (cmd[0] === 'dump-it') return command;
    if (cmd[0] === 'restic' && cmd[1] === 'backup') return { code: 0, out: SUMMARY };
    return { code: 0 };
  };
  return docker;
}
const commandJob = (verify?: string) =>
  payload({
    command: {
      service: 'db',
      argv: ['dump-it'],
      filename: 'db.sql',
      ...(verify ? { verify } : {}),
    },
  });

test('a command backup runs in the service container and streams its output into restic', async () => {
  const docker = await dockerWithService({ code: 0, out: 'data\n-- done\n' });
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', commandJob('-- done'), 'backup.run'));
  await settle(jobs, 1);
  const [result] = jobs.pending();
  assert.equal(result.state, 'succeeded', JSON.stringify(result.result));
  assert.equal((result.result as { snapshotId?: string }).snapshotId, 'snap1234');
  const started = docker.execOptions.map((o) => o.cmd.join(' '));
  assert.ok(started.includes('dump-it'), 'the command runs through exec in the service container');
  assert.ok(
    started.some((c) => c.startsWith('restic backup --stdin --stdin-filename db.sql')),
    'its output is the stdin of restic backup under the configured file name',
  );
  assert.ok(!docker.names().some((n) => n.startsWith('tug-job-')), 'helper containers are removed');
});

test('a failing command, missing output or a missing completion marker never leaves a snapshot', async () => {
  const cases: [{ code: number; out?: string }, string | undefined, RegExp][] = [
    [{ code: 3, out: 'partial\n-- done\n' }, '-- done', /the command exited with code 3/],
    [{ code: 0, out: '' }, undefined, /produced no output/],
    [
      { code: 0, out: 'partial data\n' },
      '-- done',
      /the end of the output does not contain \\"-- done\\", so it was cut short/,
    ],
  ];
  for (const [outcome, verify, message] of cases) {
    const docker = await dockerWithService(outcome);
    const { jobs } = await runner(docker);
    await jobs.start(command('cmd_x', commandJob(verify), 'backup.run'));
    await settle(jobs, 1);
    const [result] = jobs.pending();
    assert.equal(result.state, 'failed', `${JSON.stringify(outcome)} should fail the job`);
    assert.match(JSON.stringify(result.result), message);
    assert.ok(
      docker.execOptions.some((o) => o.cmd.join(' ') === 'restic forget snap1234 --retry-lock 10m'),
      'the snapshot restic already wrote is forgotten',
    );
  }
});

test('a command backup fails clearly when the service is not running on the node', async () => {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.execResponder = () => ({ code: 0 });
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', commandJob(), 'backup.run'));
  await settle(jobs, 1);
  assert.match(
    JSON.stringify(jobs.pending()[0].result),
    /service db is not running on this node/,
    'there is nothing to back up from a stopped service',
  );
});

/** A job that stays active until it is cancelled: the helper's `restic version` never answers. */
const holding = () =>
  dockerWith((cmd) => (cmd.join(' ') === 'restic version' ? undefined : { code: 0 }));
const job = (id: string, project: string, trigger: string, type = 'backup.run') =>
  command(
    id,
    payload({
      runId: `run_${id}`,
      project,
      tags: ['tug', `project:${project}`, `trigger:${trigger}`],
    }),
    type,
  );
const phaseOf = (jobs: JobRunner, id: string) =>
  jobs.statuses().find((status) => status.commandId === id)?.phase;
/** Polls until the queue shows this phase for a job; a fixed sleep here raced the runner on a loaded machine. */
const phaseIs = (jobs: JobRunner, id: string, queued: boolean) =>
  until(
    () => (phaseOf(jobs, id) === 'queued') === queued,
    `job ${id} to be ${queued ? 'queued' : 'started'}`,
  );

test('lanes: a restore starts before a manual backup, which starts before a scheduled one', () => {
  const lane = (trigger: string, type = 'backup.run') =>
    laneOf(job('x', 'p', trigger, type), payload({ tags: [`trigger:${trigger}`] }));
  assert.equal(lane('schedule'), 'scheduled', 'a scheduled backup is the lowest lane');
  assert.equal(lane('retry'), 'scheduled', 'so is a retry');
  assert.equal(lane('manual'), 'manual', 'a backup someone asked for comes next');
  assert.equal(lane('pre-restore'), 'restore', 'a safety backup waits for no scheduled backup');
  assert.equal(lane('schedule', 'backup.restore'), 'restore', 'a restore is the highest lane');
});

test('the node runs the best lane first, one job per project, and no more than its concurrency', async () => {
  const { jobs } = await runner(holding(), 2);
  await jobs.start(job('A', 'p1', 'schedule'));
  await jobs.start(job('B', 'p1', 'schedule'));
  await jobs.start(job('C', 'p2', 'schedule'));
  await jobs.start(job('D', 'p3', 'manual'));
  await jobs.start(job('E', 'p4', 'restore', 'backup.restore'));
  await phaseIs(jobs, 'A', false); // the first job starts at once
  await phaseIs(jobs, 'C', false); // a second project uses the second slot
  const queued = new Map(
    jobs
      .statuses()
      .filter((s) => s.phase === 'queued')
      .map((s) => [s.commandId, s]),
  );
  assert.deepEqual([...queued.keys()].sort(), ['B', 'D', 'E'], 'everything else waits');
  assert.equal(
    queued.get('B')?.waitingFor,
    'run_A',
    'a job waits for the running job of its own project',
  );
  assert.equal(queued.get('E')?.lane, 'restore', 'the lane is reported');

  assert.equal(await jobs.cancel('A'), true, 'cancelling a running job finds it');
  await phaseIs(jobs, 'E', false);
  assert.equal(
    [phaseOf(jobs, 'B'), phaseOf(jobs, 'D'), phaseOf(jobs, 'E')].map((p) => p === 'queued').join(),
    'true,true,false',
    'the restore takes the freed slot ahead of an older scheduled backup and a manual one',
  );

  assert.equal(await jobs.cancel('C'), true);
  await phaseIs(jobs, 'D', false); // a manual backup is next
  assert.equal(phaseOf(jobs, 'B') === 'queued', true, 'the scheduled backup still waits its turn');

  assert.equal(await jobs.cancel('E'), true);
  assert.equal(await jobs.cancel('D'), true);
  await phaseIs(jobs, 'B', false); // the scheduled backup runs once the lanes ahead are empty
  await jobs.cancel('B');
  await settle(jobs, 5);
  assert.deepEqual(
    jobs
      .pending()
      .map((r) => [r.state, (r.result as { error?: string }).error])
      .filter(([, e]) => e !== JOB_CANCELLED),
    [],
    'every cancelled job reports that it was cancelled, not a failure',
  );
});

test('cancelling a queued job removes it and reports it cancelled; an unknown job is not found', async () => {
  const { jobs } = await runner(holding(), 1);
  await jobs.start(job('A', 'p1', 'schedule'));
  await jobs.start(job('B', 'p2', 'schedule'));
  await phaseIs(jobs, 'A', false);
  assert.equal(phaseOf(jobs, 'B'), 'queued', 'the second job waits for the only slot');
  assert.equal(await jobs.cancel('B'), true, 'a queued job can be cancelled');
  assert.equal(phaseOf(jobs, 'B'), undefined, 'it never starts');
  assert.deepEqual(
    jobs.pending().map((r) => [r.commandId, (r.result as { error?: string }).error]),
    [['B', JOB_CANCELLED]],
    'its result says it was cancelled',
  );
  assert.equal(
    await jobs.cancel('nope'),
    false,
    'a job the node does not know is reported as not found',
  );
  await jobs.cancel('A');
});

test('a job removes its helper containers when it is cancelled while running', async () => {
  const docker = holding();
  const { jobs } = await runner(docker, 1);
  await jobs.start(job('A', 'p1', 'schedule'));
  await until(() => docker.names().length > 0, 'the helper container to start');
  await jobs.cancel('A');
  await settle(jobs, 1);
  assert.equal(docker.names().length, 0, 'cancelling removes the helper containers');
});

test('a node with little memory runs one job at a time and a larger one two', () => {
  assert.equal(defaultJobConcurrency(2 * 1024 ** 3), 1, 'each helper reserves 512 MB');
  assert.equal(defaultJobConcurrency(8 * 1024 ** 3), 2, 'a larger host can run two');
});

test('restic output that is only retry notices is not progress, so a failing store still stalls the job', async () => {
  const docker = dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'snapshots')
      return {
        code: 0,
        out: JSON.stringify([{ tags: ['project:site', 'target:volume:uploads'] }]),
      };
    return cmd[1] === 'restore' ? undefined : { code: 0 };
  });
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  const running = runBackupJob(
    payload({
      type: 'volume',
      target: 'volume:uploads',
      volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
      restore: { snapshotId: 'snap', mode: 'scratch', scratchVolume: 'tug_site_restore-x' },
    }),
    'cmd',
    { docker, credentials, stallMs: 150 },
    'backup.restore',
  );
  const noise = setInterval(() => {
    for (const proc of docker.execProcesses)
      (proc.stderr as unknown as PassThrough).write(
        'Load(<data/ab12cd>, 0, 0) returned error, retrying after 1.2s: 500\n',
      );
  }, 20);
  try {
    await assert.rejects(
      running,
      /made no progress/,
      'retry notices every 20 ms do not count as progress',
    );
  } finally {
    clearInterval(noise);
  }
});

test('a prune that stalls after the snapshot was taken is a warning, not a failed backup', async () => {
  const docker = dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'backup') return { code: 0, out: SUMMARY };
    return cmd[1] === 'forget' ? undefined : { code: 0 };
  });
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  const result = await runBackupJob(
    payload({
      type: 'volume',
      target: 'volume:uploads',
      volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
      retention: { daily: 7 },
    }),
    'cmd',
    { docker, credentials, stallMs: 80 },
    'backup.run',
  );
  assert.equal(result.snapshotId, 'snap1234', 'the snapshot that was taken is reported');
  assert.match(
    result.warnings?.join(' ') ?? '',
    /retention failed: restic made no progress/,
    'the stalled prune is a warning',
  );
});

const stopsRestic = (call: string) =>
  call.startsWith('exec-start') && call.includes('pkill -INT -x restic');
const hangingRestore = () =>
  dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'snapshots') return { code: 0, out: SNAPSHOT_LISTING };
    if (cmd[0] === 'restic' && cmd[1] === 'restore') return undefined;
    return { code: 0 };
  });

test('the stall limit is longer than the repository lock wait, so waiting for a lock is not reported as a stall', () => {
  assert.ok(
    RESTIC_STALL_MS > RESTIC_LOCK_WAIT_MS,
    'a job that waits out --retry-lock must not be failed as stalled first',
  );
  const args = [...forgetArgs(payload(), { daily: 7 }), ...backupArgs(payload())];
  assert.equal(
    args.filter((arg) => arg === '10m').length,
    2,
    'backup and forget wait the lock wait the stall limit was sized against',
  );
});

test('an aborted job interrupts restic so it releases its lock before the helper is removed', async () => {
  const docker = hangingRestore();
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  const controller = new AbortController();
  const running = runBackupJob(
    volumeRestore('scratch'),
    'cmd',
    { docker, credentials, signal: controller.signal, stopGraceMs: 1000 },
    'backup.restore',
  );
  setTimeout(() => controller.abort(new Error('cancelled by test')), 50);
  await assert.rejects(running, /cancelled by test/, 'the abort ends the job');
  const stop = docker.calls.findIndex(stopsRestic);
  const remove = docker.calls.findIndex((call) => call.startsWith('rm tug-job-rst_abc123-restic'));
  assert.ok(stop >= 0, 'restic is sent SIGINT (pkill -INT) in the helper');
  assert.ok(remove > stop, 'the helper is removed only after restic was told to stop');
});

test('a restic that stalls is interrupted before its helper is removed', async () => {
  const docker = hangingRestore();
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  await assert.rejects(
    runBackupJob(
      volumeRestore('scratch'),
      'cmd',
      { docker, credentials, stallMs: 80, stopGraceMs: 1000 },
      'backup.restore',
    ),
    /made no progress/,
    'the stall fails the job',
  );
  assert.ok(docker.calls.some(stopsRestic), 'the stalled restic gets SIGINT, not a forced removal');
});

test('a job whose restic commands all finished removes its helper without sending any signal', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  const { jobs } = await runner(docker);
  await jobs.start(command('cmd_1', payload()));
  await settle(jobs, 1);
  assert.ok(!docker.calls.some(stopsRestic), 'no restic is running, so none is interrupted');
});

test('leftover helpers of a previous agent are stopped gracefully when running and removed either way', async () => {
  const docker = dockerWith(() => ({ code: 0 }));
  const live = await docker.createContainer('tug-job-a-restic', {
    Image: 'restic/restic:0.19.1',
    Labels: { 'tug.job': 'a' },
  });
  await docker.startContainer(live);
  await docker.createContainer('tug-job-b-restic', {
    Image: 'restic/restic:0.19.1',
    Labels: { 'tug.job': 'b' },
  });
  docker.calls.length = 0;
  assert.equal(await removeStaleJobContainers(docker, 1000), 2, 'both leftovers are counted');
  assert.equal(
    docker.calls.filter(stopsRestic).length,
    1,
    'only the running helper may hold a lock, so only it is signalled',
  );
  assert.ok(
    docker.calls.findIndex(stopsRestic) <
      docker.calls.findIndex((c) => c === 'rm tug-job-a-restic'),
    'the running helper is removed after the signal',
  );
  assert.deepEqual(docker.names(), [], 'every leftover is removed');
});

/** A volume backup with retention, whose restic commands the test scripts by subcommand. */
async function retentionRun(
  scripted: (cmd: string[]) => { code: number; out?: string; err?: string } | undefined,
  overrides: Partial<BackupJobPayload> = {},
) {
  const docker = dockerWith((cmd) => {
    if (cmd[0] === 'restic' && cmd[1] === 'backup') return { code: 0, out: SUMMARY };
    return scripted(cmd) ?? { code: 0 };
  });
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  const result = await runBackupJob(
    payload({
      type: 'volume',
      target: 'volume:uploads',
      volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
      retention: { daily: 7 },
      ...overrides,
    }),
    'cmd',
    { docker, credentials },
    'backup.run',
  );
  return { docker, result };
}
const ranForget = (docker: FakeDocker) => docker.execOptions.some((e) => e.cmd[1] === 'forget');

test('a successful prune is reported as retention ok', async () => {
  const { result } = await retentionRun(() => ({ code: 0 }));
  assert.deepEqual(result.retention, { state: 'ok' }, 'the run reports that retention worked');
  assert.equal(result.warnings, undefined, 'a working prune adds no warning');
});

test('a failed prune is retention failed with a redacted message, and the backup still succeeds', async () => {
  const { result } = await retentionRun((cmd) =>
    cmd[1] === 'forget' ? { code: 1, err: 'Fatal: access denied for sekret-value-1' } : undefined,
  );
  assert.equal(result.snapshotId, 'snap1234', 'the snapshot is kept');
  assert.equal(result.retention?.state, 'failed', 'the prune failure is structured data');
  assert.ok(
    !result.retention?.message?.includes('sekret-value-1'),
    'the stored message never carries a credential',
  );
  assert.equal(result.retention?.locked, undefined, 'a plain failure is not a lock');
  assert.match(result.warnings?.[0] ?? '', /^retention failed:/, 'the existing warning stays');
});

test("a prune that exits with restic's lock code is classified locked, whatever restic printed", async () => {
  const { result } = await retentionRun((cmd) =>
    cmd[1] === 'forget' ? { code: 11, err: 'some wording a future restic changed' } : undefined,
  );
  assert.equal(result.retention?.state, 'failed', 'the prune failed');
  assert.equal(result.retention?.locked, true, 'exit code 11 marks it locked');
  const plain = await retentionRun((cmd) =>
    cmd[1] === 'forget'
      ? { code: 1, err: 'unable to create lock in backend: repository is already locked' }
      : undefined,
  );
  assert.equal(
    plain.result.retention?.locked,
    undefined,
    'wording that sounds like a lock is not a lock without the exit code',
  );
});

test('an external destination skips forget --prune and reports retention external', async () => {
  const { docker, result } = await retentionRun(
    (cmd) => (cmd[1] === 'forget' ? { code: 1, err: 'append-only' } : undefined),
    {
      retention: undefined,
      retentionMode: 'external',
    },
  );
  assert.ok(!ranForget(docker), 'forget is never run against an append-only destination');
  assert.deepEqual(result.retention, { state: 'external' }, 'the run says pruning is external');
  assert.equal(result.warnings, undefined, 'an external destination is not a warning');
});

test('a run without a retention policy (a safety backup before a restore) reports no retention', async () => {
  const { docker, result } = await retentionRun(() => undefined, { retention: undefined });
  assert.ok(!ranForget(docker), 'no policy, no forget');
  assert.equal(
    result.retention,
    undefined,
    'nothing is reported, so it cannot reset a failing streak',
  );
});

test("a backup that exits with restic's lock code fails with cause locked, and the node reports it", async () => {
  const docker = dockerWith((cmd) =>
    cmd[0] === 'restic' && cmd[1] === 'backup'
      ? { code: 11, err: 'unable to create lock in backend' }
      : { code: 0 },
  );
  docker.volumes.set('tug_v4_site_uploads', {
    Name: 'tug_v4_site_uploads',
    Labels: { 'tug.project': 'site', 'tug.volume': 'uploads' },
  });
  const { jobs } = await runner(docker);
  await jobs.start(
    command(
      'cmd_lock',
      payload({
        type: 'volume',
        target: 'volume:uploads',
        volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
      }),
      'backup.run',
    ),
  );
  await settle(jobs, 1);
  const [result] = jobs.pending();
  assert.equal(result.state, 'failed', 'a locked backup is a failed run');
  assert.equal(
    (result.result as { cause?: string }).cause,
    'locked',
    'the failed result carries cause locked',
  );
  const other = dockerWith((cmd) =>
    cmd[0] === 'restic' && cmd[1] === 'backup'
      ? { code: 1, err: 'repository is already locked' }
      : { code: 0 },
  );
  other.volumes = docker.volumes;
  const second = await runner(other);
  await second.jobs.start(
    command(
      'cmd_plain',
      payload({
        type: 'volume',
        target: 'volume:uploads',
        volume: { name: 'uploads', dockerVolume: 'tug_v4_site_uploads' },
      }),
      'backup.run',
    ),
  );
  await settle(second.jobs, 1);
  assert.equal(
    (second.jobs.pending()[0].result as { cause?: string }).cause,
    undefined,
    'a failure with lock-like wording but another exit code has no cause',
  );
});
