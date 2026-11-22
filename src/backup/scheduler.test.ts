import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/db.ts';
import { createBackupService } from './scheduler.ts';
import { normalized } from '../../tests/fake-docker.ts';
import type { Db } from '../db/db.ts';
import { JOB_CANCELLED } from '../protocol.ts';
import type { BackupJobPayload, DesiredState } from '../protocol.ts';

const at = (iso: string) => new Date(iso);

interface Queued {
  id: string;
  nodeId: string;
  type: string;
  payload: BackupJobPayload;
  deadline?: string;
}

async function fixture(options: { destination?: boolean; schedule?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-sched-'));
  const db: Db = await openDb(path.join(dir, 'tug.db'));
  let clock = at('2026-11-01T00:00:00Z');
  const queued: Queued[] = [];
  const compose = normalized({
    'x-tug': { backup: { schedule: options.schedule ?? '0 3 * * *', retention: { daily: 7 } } },
    services: {
      db: {
        image: 'mariadb:11.4',
        volumes: ['db-data:/var/lib/mysql'],
        'x-tug': {
          placement: { nodes: ['app1'] },
          backup: { jitter: 0, command: ['dump-it'], filename: 'db.sql', verify: 'done' },
        },
      },
    },
    volumes: {
      'db-data': {},
      uploads: { 'x-tug': { placement: { nodes: ['app1'] }, backup: { jitter: 0 } } },
    },
  });
  const desired: DesiredState = {
    project: 'site',
    version: 'v1',
    compose,
    services: {
      db: {
        image: 'mariadb@sha256:abc',
        build: null,
        placement: { nodes: ['app1'] },
        replicas: 1,
        health: null,
      },
    },
  };
  const ts = clock.toISOString();
  db.run(
    "INSERT INTO nodes(id,name,status,last_seen_at,created_at) VALUES('n_app1','app1','online',?,?)",
    ts,
    ts,
  );
  db.run(
    "INSERT INTO projects(id,name,current_deployment_id,created_at) VALUES('site','site','dep1',?)",
    ts,
  );
  db.run(
    "INSERT INTO deployments(id,project_id,version,state,created_at) VALUES('dep1','site','v1','succeeded',?)",
    ts,
  );
  db.run(
    'INSERT INTO desired_states(id,project_id,deployment_id,version,state_json,created_at) VALUES(?,?,?,?,?,?)',
    'ds1',
    'site',
    'dep1',
    'v1',
    JSON.stringify(desired),
    ts,
  );
  if (options.destination !== false)
    db.run(
      "INSERT INTO backup_destination(id,url,env_names_json,updated_at) VALUES('default','s3:https://s3.example.com/bucket/tug','[]',?)",
      ts,
    );
  let seq = 0;
  const service = createBackupService({
    db,
    clock: () => clock,
    redact: (text) => text.replaceAll('sekret-value-1', '[redacted]'),
    queueCommand: (nodeId, _project, type, payload, deadline) => {
      const id = `cmd_${++seq}`;
      queued.push({ id, nodeId, type, payload: payload as unknown as BackupJobPayload, deadline });
      db.run(
        "INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,deadline,created_at,updated_at) VALUES(?,?,?,?,'pending',?,0,?,?,?)",
        id,
        nodeId,
        'site',
        type,
        JSON.stringify(payload),
        deadline ?? null,
        ts,
        ts,
      );
      return id;
    },
  });
  return {
    db,
    service,
    queued,
    set: (iso: string) => (clock = at(iso)),
    runs: () =>
      db.all<{
        id: string;
        state: string;
        trigger: string;
        error: string | null;
        target: string;
        scheduled_for: string | null;
      }>('SELECT * FROM backup_runs ORDER BY queued_at, id'),
    events: (type: string) =>
      db.all<{ message: string; level: string }>('SELECT * FROM events WHERE type=?', type),
    schedule: (target = 'service:db') =>
      db.get<{
        next_run_at: string;
        last_success_at: string | null;
        enabled: number;
        node_id: string;
      }>('SELECT * FROM backup_schedules WHERE target=?', target)!,
  };
}

test('sync creates a schedule per backup target on its node, with the next slot after now', async () => {
  const f = await fixture();
  f.service.sync(at('2026-11-01T00:00:00Z'));
  assert.equal(f.schedule().next_run_at, '2026-11-01T03:00:00.000Z', 'the next 03:00 UTC slot');
  assert.equal(f.schedule().node_id, 'n_app1', 'the backup runs on the service node');
  assert.equal(
    f.schedule('volume:uploads').next_run_at,
    '2026-11-01T03:00:00.000Z',
    'volumes are scheduled too',
  );
});

test('a due slot queues exactly one backup command, and repeated ticks do not queue another', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-01T03:00:30Z');
  f.service.tick(at('2026-11-01T03:00:30Z'));
  f.service.tick(at('2026-11-01T03:00:40Z'));
  const db = f.queued.filter((q) => q.payload.target === 'service:db');
  assert.equal(db.length, 1, 'one command for the slot');
  const [job] = db;
  assert.equal(job.type, 'backup.run');
  assert.equal(job.nodeId, 'n_app1');
  assert.equal(
    job.payload.repository,
    's3:https://s3.example.com/bucket/tug/site',
    'one repository per project',
  );
  assert.equal(job.payload.limits.memory, '512m', 'the restic helper defaults to 512m');
  assert.equal(
    job.payload.resticImage,
    'restic/restic:0.19.1',
    'the restic helper defaults to the current restic release',
  );
  assert.deepEqual(
    job.payload.command,
    {
      service: 'db',
      argv: ['dump-it'],
      filename: 'db.sql',
      verify: 'done',
      restoreArgv: undefined,
    },
    'the job carries the command to run in the service container',
  );
  assert.ok(
    job.payload.tags.includes('target:service:db') && job.payload.tags.includes('trigger:schedule'),
  );
  assert.ok(
    job.deadline && new Date(job.deadline).getTime() > at('2026-11-01T03:00:30Z').getTime(),
    'a deadline bounds a late start',
  );
  assert.equal(f.schedule().next_run_at, '2026-11-02T03:00:00.000Z', 'the next slot is tomorrow');
  assert.equal(f.runs().filter((r) => r.target === 'service:db').length, 1, 'one run row per slot');
});

test('a target reports why it needs attention, and a healthy one reports nothing', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  const problems = () =>
    Object.fromEntries(f.service.list('site').targets.map((t) => [t.target, t.problem]));
  assert.deepEqual(
    problems(),
    { 'service:db': null, 'volume:uploads': null },
    'a new target is healthy',
  );

  f.set('2026-11-01T03:00:30Z');
  f.service.tick(at('2026-11-01T03:00:30Z'));
  const job = f.queued.find((q) => q.payload.target === 'service:db')!;
  f.service.onResult(job.id, 'failed', { error: 'bucket unreachable' });
  assert.equal(problems()['service:db'], 'the last run failed', 'a failed last run is a problem');

  const retry = () => f.queued.filter((q) => q.payload.target === 'service:db').at(-1)!;
  f.set('2026-11-01T03:12:00Z');
  f.service.tick(at('2026-11-01T03:12:00Z'));
  f.service.onResult(retry().id, 'succeeded', {
    runId: retry().payload.runId,
    snapshotId: 'ok',
    durationMs: 1,
  });
  assert.equal(problems()['service:db'], null, 'a later success clears it');

  f.set('2026-11-04T12:00:00Z');
  assert.match(
    problems()['service:db']!,
    /no successful backup since 2026-11-01T03:12/,
    'two silent days is stale',
  );
  f.db.run("UPDATE backup_schedules SET enabled=0 WHERE target='service:db'");
  assert.equal(problems()['service:db'], null, 'a disabled target is not a problem');
});

test('a completed result records the snapshot, updates the schedule and emits an event', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-01T03:00:30Z');
  f.service.tick(at('2026-11-01T03:00:30Z'));
  const job = f.queued.find((q) => q.payload.target === 'service:db')!;
  f.service.onHeartbeat([
    {
      commandId: job.id,
      runId: job.payload.runId,
      phase: 'dumping',
      startedAt: '2026-11-01T03:00:31Z',
    },
  ]);
  assert.equal(
    f.runs().find((r) => r.id === job.payload.runId)?.state,
    'running',
    'a heartbeat marks the run running',
  );
  f.service.onResult(job.id, 'succeeded', {
    runId: job.payload.runId,
    snapshotId: 'abcdef123456',
    addedBytes: 10,
    totalBytes: 20,
    durationMs: 5,
  });
  const run = f.db.get<{ state: string; snapshot_id: string; size_bytes: number }>(
    'SELECT * FROM backup_runs WHERE id=?',
    job.payload.runId,
  )!;
  assert.deepEqual([run.state, run.snapshot_id, run.size_bytes], ['succeeded', 'abcdef123456', 20]);
  assert.ok(f.schedule().last_success_at, 'last success is recorded');
  assert.equal(f.events('backup.completed').length, 1, 'completion is an event');
});

test('a failed result emits an error event without credentials and gets one retry after ten minutes', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-01T03:00:30Z');
  f.service.tick(at('2026-11-01T03:00:30Z'));
  const job = f.queued.find((q) => q.payload.target === 'service:db')!;
  f.service.onResult(job.id, 'failed', { error: 'bucket rejected key sekret-value-1' });
  const failed = f.events('backup.failed');
  assert.equal(failed.length, 1, 'a failure is an event');
  assert.equal(failed[0].level, 'error');
  assert.ok(!failed[0].message.includes('sekret-value-1'), 'credentials never reach events');

  f.service.tick(at('2026-11-01T03:05:00Z'));
  assert.equal(
    f.queued.filter((q) => q.payload.tags.includes('trigger:retry')).length,
    0,
    'no retry before ten minutes',
  );
  f.service.tick(at('2026-11-01T03:11:00Z'));
  f.service.tick(at('2026-11-01T03:12:00Z'));
  assert.equal(
    f.queued.filter(
      (q) => q.payload.target === 'service:db' && q.payload.tags.includes('trigger:retry'),
    ).length,
    1,
    'exactly one retry',
  );
});

test('control down for a week yields one missed event and one catch-up run per target, not a burst', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-08T12:00:00Z');
  f.service.tick(at('2026-11-08T12:00:00Z'));
  const missed = f.runs().filter((r) => r.state === 'missed' && r.target === 'service:db');
  assert.equal(missed.length, 1, 'one missed record for the whole gap');
  assert.equal(missed[0].error, 'control_down');
  assert.equal(
    f.events('backup.missed').filter((e) => e.message.includes('service:db')).length,
    1,
    'one missed event',
  );
  const catchUps = f.queued.filter((q) => q.payload.target === 'service:db');
  assert.equal(catchUps.length, 1, 'one catch-up backup');
  assert.ok(catchUps[0].payload.tags.includes('trigger:catch-up'));
  assert.equal(
    f.schedule().next_run_at,
    '2026-11-09T03:00:00.000Z',
    'scheduling resumes at the next future slot',
  );
});

test('a command the node never fetched before its deadline becomes a missed run', async () => {
  const f = await fixture({ schedule: '@hourly' });
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-01T01:00:10Z');
  f.service.tick(at('2026-11-01T01:00:10Z'));
  f.service.tick(at('2026-11-01T01:40:00Z'));
  const run = f.runs().find((r) => r.target === 'service:db' && r.trigger === 'schedule')!;
  assert.equal(run.state, 'missed', 'the pending run is missed after the deadline');
  assert.equal(run.error, 'node_offline');
  assert.equal(f.events('backup.missed').length >= 1, true);
  assert.equal(
    f.db.get<{ state: string }>('SELECT state FROM commands WHERE id=?', f.queued[0].id)?.state,
    'expired',
    'the stale command is never delivered',
  );
});

test('a running job whose agent stopped reporting for ten minutes fails as agent_lost', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-01T03:00:30Z');
  f.service.tick(at('2026-11-01T03:00:30Z'));
  const job = f.queued.find((q) => q.payload.target === 'service:db')!;
  f.service.onHeartbeat([
    {
      commandId: job.id,
      runId: job.payload.runId,
      phase: 'uploading',
      startedAt: '2026-11-01T03:00:31Z',
    },
  ]);
  f.service.tick(at('2026-11-01T03:05:00Z'));
  assert.equal(
    f.runs().find((r) => r.id === job.payload.runId)?.state,
    'running',
    'still alive within ten minutes',
  );
  f.service.tick(at('2026-11-01T03:20:00Z'));
  const run = f.runs().find((r) => r.id === job.payload.runId)!;
  assert.deepEqual([run.state, run.error], ['failed', 'agent_lost']);
});

test('a target that has not succeeded for two periods is reported stale once a day', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.service.tick(at('2026-11-03T12:00:00Z'));
  assert.ok(f.events('backup.stale').length >= 1, 'a long-failing target is stale');
  const count = f.events('backup.stale').length;
  f.service.tick(at('2026-11-03T13:00:00Z'));
  assert.equal(f.events('backup.stale').length, count, 'the warning repeats at most daily');
});

test('without a destination a due slot is recorded and warned, and no command is queued', async () => {
  const f = await fixture({ destination: false });
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.service.tick(at('2026-11-01T03:00:30Z'));
  assert.equal(f.queued.length, 0, 'nothing runs without a destination');
  assert.ok(f.events('backup.no_destination').length >= 1, 'the operator is told why');
  assert.equal(f.runs()[0].state, 'missed');
});

test('manual runs queue every target or the named ones and refuse unknown names', async () => {
  const f = await fixture();
  const all = f.service.runNow('site', undefined, 'alice');
  assert.deepEqual(all.runs.map((r) => r.target).sort(), ['service:db', 'volume:uploads']);
  const one = f.service.runNow('site', ['db'], 'alice');
  assert.equal(one.runs.length, 1, 'a bare name matches the service or volume');
  assert.ok(f.queued.at(-1)!.payload.tags.includes('trigger:manual'));
  assert.equal(
    f.db.get<{ actor: string }>('SELECT actor FROM backup_runs WHERE id=?', one.runs[0].runId)
      ?.actor,
    'alice',
    'the actor is recorded',
  );
  assert.match(
    f.service.runNow('site', ['ghost'], 'alice').errors[0],
    /ghost is not a backup target/,
  );
});

test('removing a target from the Compose file disables its schedule but keeps its history', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  const state = JSON.parse(
    f.db.get<{ state_json: string }>('SELECT state_json FROM desired_states')!.state_json,
  ) as DesiredState;
  delete (state.compose.volumes!.uploads['x-tug'] as { backup?: unknown }).backup;
  f.db.run('UPDATE desired_states SET state_json=?', JSON.stringify(state));
  f.service.sync(at('2026-11-01T01:00:00Z'));
  assert.equal(f.schedule('volume:uploads').enabled, 0, 'the removed target stops running');
  assert.equal(f.schedule().enabled, 1, 'other targets keep running');
});

/** A scheduled run of `service:db` queued for the node, as a node would have fetched it. */
function dueDbRun(f: Awaited<ReturnType<typeof fixture>>) {
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.set('2026-11-01T03:00:30Z');
  f.service.tick(at('2026-11-01T03:00:30Z'));
  return f.queued.find((q) => q.payload.target === 'service:db')!;
}

test('a job the node has queued behind another stays queued, and the listing says what it waits for', async () => {
  const f = await fixture();
  const job = dueDbRun(f);
  f.service.onHeartbeat([
    {
      commandId: job.id,
      runId: job.payload.runId,
      phase: 'queued',
      startedAt: '2026-11-01T03:00:31Z',
      lane: 'scheduled',
      waitingFor: 'bkr_other',
    },
  ]);
  assert.equal(
    f.runs().find((r) => r.id === job.payload.runId)?.state,
    'queued',
    'a job waiting for a free slot on the node is not running',
  );
  const waiting = f.service.list('site').runs.find((r) => r.id === job.payload.runId);
  assert.deepEqual(
    [waiting?.phase, waiting?.waitingFor, waiting?.lane],
    ['queued', 'bkr_other', 'scheduled'],
    'the listing carries what the node reported',
  );
  f.service.onHeartbeat([
    {
      commandId: job.id,
      runId: job.payload.runId,
      phase: 'uploading',
      startedAt: '2026-11-01T03:05:00Z',
    },
  ]);
  const running = f.service.list('site').runs.find((r) => r.id === job.payload.runId);
  assert.equal(running?.state, 'running', 'once the node starts it, it is running');
  assert.equal(running?.waitingFor, undefined, 'and no longer waits for anything');
});

test('a run the node fetched but never started is failed when the node goes silent', async () => {
  const f = await fixture();
  const job = dueDbRun(f);
  f.db.run("UPDATE commands SET state='running' WHERE id=?", job.id);
  f.service.onHeartbeat([
    { commandId: job.id, runId: job.payload.runId, phase: 'queued', startedAt: 't' },
  ]);
  f.set('2026-11-01T03:30:00Z');
  f.service.tick(at('2026-11-01T03:30:00Z'));
  const run = f.runs().find((r) => r.id === job.payload.runId);
  assert.deepEqual(
    [run?.state, run?.error],
    ['failed', 'agent_lost'],
    'a queued-on-the-node job does not stay queued for ever when its node disappears',
  );
});

test('cancelling a run asks its node to stop the job, and a cancelled job is a warning that is not retried', async () => {
  const f = await fixture();
  const job = dueDbRun(f);
  f.service.onHeartbeat([
    { commandId: job.id, runId: job.payload.runId, phase: 'uploading', startedAt: 't' },
  ]);
  assert.deepEqual(
    f.service.cancelRun('site', 'nope'),
    { error: 'backup run nope not found in project site', status: 404 },
    'an unknown run is not found',
  );
  const cancelled = f.service.cancelRun('site', job.payload.runId);
  assert.ok('ok' in cancelled, 'a running run can be cancelled');
  const cancel = f.queued.at(-1)!;
  assert.equal(cancel.type, 'backup.cancel', 'the node is told with a backup.cancel command');
  assert.deepEqual(cancel.payload, { commandId: job.id }, 'naming the job to stop');
  assert.equal(cancel.nodeId, job.nodeId, 'on the node that runs it');

  f.service.onResult(job.id, 'failed', { error: JOB_CANCELLED });
  assert.equal(f.events('backup.cancelled')[0]?.level, 'warn', 'a cancel is a warning');
  assert.equal(f.events('backup.failed').length, 0, 'not a failure alert');
  f.set('2026-11-01T04:00:00Z');
  const runsBefore = f.queued.filter((q) => q.type === 'backup.run').length;
  f.service.tick(at('2026-11-01T04:00:00Z'));
  assert.equal(
    f.queued.filter((q) => q.type === 'backup.run').length,
    runsBefore,
    'a cancelled scheduled run is not retried',
  );
  assert.deepEqual(
    f.service.cancelRun('site', job.payload.runId),
    { error: `backup run ${job.payload.runId} already failed`, status: 409 },
    'a finished run cannot be cancelled again',
  );
});

/** Runs the db target's backup at `when` and returns what the node would have been told. */
function runAt(f: Awaited<ReturnType<typeof fixture>>, when: string) {
  f.set(when);
  f.service.tick(at(when));
  return f.queued.filter((q) => q.payload.target === 'service:db').at(-1)!;
}
const succeed = (
  f: Awaited<ReturnType<typeof fixture>>,
  job: Queued,
  retention?: { state: 'ok' | 'failed' | 'external'; message?: string; locked?: boolean },
) =>
  f.service.onResult(job.id, 'succeeded', {
    runId: job.payload.runId,
    snapshotId: 'abcdef123456',
    durationMs: 5,
    ...(retention ? { retention } : {}),
  });
const dbTarget = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.service.list('site').targets.find((t) => t.target === 'service:db')!;

test('a run stores its retention outcome as data, and the listing serves parsed fields, not the raw metadata', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  succeed(f, runAt(f, '2026-11-01T03:00:30Z'), { state: 'failed', message: 'prune failed' });
  const stored = f.db.get<{ metadata_json: string }>(
    "SELECT metadata_json FROM backup_runs WHERE state='succeeded'",
  )!;
  assert.deepEqual(
    JSON.parse(stored.metadata_json).retention,
    { state: 'failed', message: 'prune failed' },
    'the outcome is stored in the run metadata next to the warnings',
  );
  const listing = f.service.list('site');
  assert.equal(
    typeof listing.runs[0].metadata_json,
    'string',
    'the raw metadata string stays on the run row, so a client that reads it keeps working',
  );
  assert.deepEqual(
    listing.runs[0].retention,
    { state: 'failed', message: 'prune failed' },
    'the run lists its retention as a parsed field',
  );
  assert.deepEqual(
    dbTarget(f).retention,
    { state: 'failed', message: 'prune failed', failures: 1 },
    'the target reports the newest outcome and a streak of one',
  );
});

test('retention failures count consecutively and a run whose retention works clears the streak', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  succeed(f, runAt(f, '2026-11-01T03:00:30Z'), { state: 'failed', message: 'overlap' });
  succeed(f, runAt(f, '2026-11-02T03:00:30Z'), { state: 'failed', message: 'overlap' });
  assert.equal(
    dbTarget(f).retention?.failures,
    2,
    'two failed prunes in a row are a streak of two',
  );
  succeed(f, runAt(f, '2026-11-03T03:00:30Z'), { state: 'ok' });
  assert.deepEqual(
    dbTarget(f).retention,
    { state: 'ok', failures: 0 },
    'a prune that works again ends the streak',
  );
  succeed(f, runAt(f, '2026-11-04T03:00:30Z'), { state: 'external' });
  assert.equal(
    dbTarget(f).retention?.state,
    'external',
    'an external destination is reported as such',
  );
});

test('retention events fire on transition only, once on the way down and once on recovery', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  succeed(f, runAt(f, '2026-11-01T03:00:30Z'), { state: 'ok' });
  assert.equal(f.events('backup.retention_failed').length, 0, 'a healthy prune raises nothing');
  succeed(f, runAt(f, '2026-11-02T03:00:30Z'), { state: 'failed', message: 'prune failed' });
  succeed(f, runAt(f, '2026-11-03T03:00:30Z'), { state: 'failed', message: 'prune failed' });
  assert.equal(
    f.events('backup.retention_failed').length,
    1,
    'a second failure in a row is not another alert',
  );
  assert.equal(f.events('backup.retention_recovered').length, 0, 'nothing recovered yet');
  succeed(f, runAt(f, '2026-11-04T03:00:30Z'), { state: 'ok' });
  assert.equal(f.events('backup.retention_recovered').length, 1, 'recovery is announced once');
  succeed(f, runAt(f, '2026-11-05T03:00:30Z'), { state: 'ok' });
  assert.equal(
    f.events('backup.retention_recovered').length,
    1,
    'a run that stays healthy is not another recovery',
  );
});

test('clearing retention failures turns failing targets external at once and announces each recovery once', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  succeed(f, runAt(f, '2026-11-01T03:00:30Z'), { state: 'failed', message: 'denied' });
  succeed(f, runAt(f, '2026-11-02T03:00:30Z'), { state: 'failed', message: 'denied' });
  assert.equal(dbTarget(f).retention?.failures, 2, 'the failing streak is recorded');
  assert.equal(f.service.clearRetentionFailures('alice'), 1, 'one failing target is cleared');
  assert.deepEqual(
    dbTarget(f).retention,
    { state: 'external', failures: 0 },
    'the target is external with no failing streak, so --check is green without a new backup',
  );
  assert.equal(
    f.events('backup.retention_recovered').length,
    1,
    'the recovery is announced once for the target that was failing',
  );
  assert.equal(
    f.service.clearRetentionFailures('alice'),
    0,
    'a second call finds nothing failing and announces nothing',
  );
  assert.equal(f.events('backup.retention_recovered').length, 1, 'no second recovery event');
  succeed(f, runAt(f, '2026-11-03T03:00:30Z'), { state: 'external' });
  assert.equal(
    f.events('backup.retention_recovered').length,
    1,
    'the next backup on the external destination raises no event of its own',
  );
});

test('clearing retention failures leaves healthy and never-pruned targets alone', async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  assert.equal(f.service.clearRetentionFailures(), 0, 'a target that never applied retention');
  succeed(f, runAt(f, '2026-11-01T03:00:30Z'), { state: 'ok' });
  assert.equal(f.service.clearRetentionFailures(), 0, 'a target whose retention works');
  assert.deepEqual(dbTarget(f).retention, { state: 'ok', failures: 0 }, 'it stays ok');
  assert.equal(f.events('backup.retention_recovered').length, 0, 'nothing is announced');
});

test('an external destination skips pruning in the job payload and never raises retention events', async () => {
  const f = await fixture();
  f.db.run("INSERT INTO meta(key,value) VALUES('backup_destination_retention','external')");
  f.service.tick(at('2026-11-01T00:00:00Z'));
  const job = runAt(f, '2026-11-01T03:00:30Z');
  assert.equal(job.payload.retentionMode, 'external', 'the node is told not to prune');
  assert.equal(
    job.payload.retention,
    undefined,
    'no retention policy is sent to a node that must not prune',
  );
  succeed(f, job, { state: 'external' });
  assert.equal(
    f.events('backup.retention_failed').length,
    0,
    'external retention is not a failure',
  );
});

test("a run that failed on restic's lock exit records cause locked, shows the lock and carries the cause on backup.failed", async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  const job = runAt(f, '2026-11-01T03:00:30Z');
  f.service.onResult(job.id, 'failed', {
    error: 'backup failed: unable to create lock in backend',
    cause: 'locked',
  });
  const target = dbTarget(f);
  assert.equal(target.cause, 'locked', 'the target reports the cause of its last failed run');
  assert.match(
    target.problem ?? '',
    /repository is locked, run tug backup unlock/,
    'the problem says why the run failed and names the fix',
  );
  const failedEvent = f.db.get<{ metadata_json: string }>(
    "SELECT metadata_json FROM events WHERE type='backup.failed'",
  )!;
  assert.equal(
    JSON.parse(failedEvent.metadata_json).cause,
    'locked',
    'the existing backup.failed event carries cause locked',
  );
  assert.equal(f.events('backup.locked').length, 0, 'no separate locked event exists');
  succeed(f, runAt(f, '2026-11-02T03:00:30Z'), { state: 'ok' });
  assert.equal(dbTarget(f).cause, null, 'the next successful run clears the cause');
});

test("a failure that is not restic's lock exit has no cause and no lock", async () => {
  const f = await fixture();
  f.service.tick(at('2026-11-01T00:00:00Z'));
  f.service.onResult(runAt(f, '2026-11-01T03:00:30Z').id, 'failed', {
    error: 'backup failed: no space',
  });
  assert.equal(dbTarget(f).cause, null, 'only the lock exit code makes a cause');
});
