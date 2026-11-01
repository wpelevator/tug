import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobRunner } from './agent-jobs.ts';
import { backupArgs, forgetArgs, memoryBytes, parseSummary } from './backup-job.ts';
import { FakeDocker } from '../tests/fake-docker.ts';
import type { BackupJobPayload, Command } from './protocol.ts';

const payload = (overrides: Partial<BackupJobPayload> = {}): BackupJobPayload => ({
  runId: 'bkr_1',
  project: 'site',
  target: 'service:db',
  type: 'command',
  repository: 's3:https://s3.example.com/bucket/site',
  resticImage: 'restic/restic:0.17.3',
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
  docker.addImage('restic/restic:0.17.3');
  docker.execResponder = responder;
  return docker;
}

test('a check job reports a healthy repository and removes its helper container', async () => {
  const docker = dockerWith((cmd) =>
    cmd.join(' ') === 'restic version'
      ? { code: 0, out: 'restic 0.17.3 compiled with go1.22\n' }
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
  assert.equal((result.result as { resticVersion?: string }).resticVersion, '0.17.3');
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
        volume: { name: 'uploads', dockerVolume: 'tug_site_uploads' },
      }),
      'backup.run',
    ),
  );
  await settle(jobs, 1);
  const [result] = jobs.pending();
  assert.equal(result.state, 'failed', 'a missing volume fails the job');
  assert.match(
    JSON.stringify(result.result),
    /volume tug_site_uploads does not exist on this node/,
    'the error says which volume is missing',
  );
});

const SUMMARY =
  '{"message_type":"summary","snapshot_id":"snap1234","data_added":10,"total_bytes_processed":20}\n';

/** A project with a running `db` container whose command output and exit code the test scripts. */
async function dockerWithService(command: { code: number; out?: string; err?: string }) {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.17.3');
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
  docker.addImage('restic/restic:0.17.3');
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
