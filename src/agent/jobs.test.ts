import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PassThrough } from 'node:stream';
import { JobRunner, defaultJobConcurrency, laneOf } from './jobs.ts';
import { backupArgs, forgetArgs, memoryBytes, parseSummary, runBackupJob } from '../backup/job.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { JOB_CANCELLED } from '../protocol.ts';
import type { BackupJobPayload, Command } from '../protocol.ts';

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
const settle = async (jobs: JobRunner, expected: number) => {
  for (let i = 0; i < 200 && jobs.pending().length < expected; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

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

test('a missing repository is initialized, but a wrong password is not', async () => {
  const missing = dockerWith((cmd) => {
    if (cmd.join(' ') === 'restic cat config')
      return {
        code: 10,
        err: 'Fatal: unable to open config file\nIs there a repository at the following location?',
      };
    return { code: 0 };
  });
  const first = await runner(missing);
  await first.jobs.start(command('cmd_1', payload()));
  await settle(first.jobs, 1);
  assert.equal(
    (first.jobs.pending()[0].result as { repository?: string }).repository,
    'initialized',
    'a missing repository is created',
  );
  assert.ok(
    missing.execOptions.some((e) => e.cmd.join(' ') === 'restic init'),
    'restic init ran',
  );

  const wrong = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config'
      ? { code: 1, err: 'Fatal: wrong password or no key found' }
      : { code: 0 },
  );
  const second = await runner(wrong);
  await second.jobs.start(command('cmd_2', payload()));
  await settle(second.jobs, 1);
  assert.equal(second.jobs.pending()[0].state, 'failed', 'a wrong password fails the job');
  assert.ok(
    !wrong.execOptions.some((e) => e.cmd.join(' ') === 'restic init'),
    'a wrong password must never initialize a new repository',
  );
});

test('error text never contains credentials', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic cat config'
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
    cmd.join(' ') === 'restic cat config' ? undefined : { code: 0 },
  );
  const { jobs } = await runner(docker, 1);
  await jobs.start(command('cmd_a', payload({ runId: 'bkr_a' })));
  await jobs.start(command('cmd_b', payload({ runId: 'bkr_b' })));
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  assert.match(forget, /--keep-daily 7 --keep-weekly 4 --prune/);
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
      docker.execOptions.some((o) => o.cmd.join(' ') === 'restic forget snap1234'),
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

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
  await tick();
  assert.equal(phaseOf(jobs, 'A') === 'queued', false, 'the first job starts at once');
  assert.equal(phaseOf(jobs, 'C') === 'queued', false, 'a second project uses the second slot');
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
  await tick();
  assert.equal(
    [phaseOf(jobs, 'B'), phaseOf(jobs, 'D'), phaseOf(jobs, 'E')].map((p) => p === 'queued').join(),
    'true,true,false',
    'the restore takes the freed slot ahead of an older scheduled backup and a manual one',
  );

  assert.equal(await jobs.cancel('C'), true);
  await tick();
  assert.equal(phaseOf(jobs, 'D') === 'queued', false, 'a manual backup is next');
  assert.equal(phaseOf(jobs, 'B') === 'queued', true, 'the scheduled backup still waits its turn');

  assert.equal(await jobs.cancel('E'), true);
  assert.equal(await jobs.cancel('D'), true);
  await tick();
  assert.equal(
    phaseOf(jobs, 'B') === 'queued',
    false,
    'the scheduled backup runs once the lanes ahead are empty',
  );
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
  await tick();
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
  await tick();
  assert.ok(docker.names().length > 0, 'the helper runs');
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
