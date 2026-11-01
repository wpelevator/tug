import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.ts';
import { createBackupService } from './backup-scheduler.ts';
import { createRestoreService, discoverWriters } from './backup-restore.ts';
import { normalized } from '../tests/fake-docker.ts';
import type { BackupJobPayload, DesiredState } from './protocol.ts';

const at = (iso: string) => new Date(iso);

async function fixture(options: { writers?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-restore-'));
  const db = await openDb(path.join(dir, 'tug.db'));
  let clock = at('2026-11-01T10:00:00Z');
  const queued: { id: string; type: string; payload: BackupJobPayload }[] = [];
  const compose = normalized({
    'x-tug': { backup: { schedule: '0 3 * * *', retention: { daily: 7 } } },
    services: {
      db: {
        image: 'mariadb:11.4',
        'x-tug': {
          placement: { nodes: ['app1'] },
          backup: { jitter: 0, command: ['dump'], restore: ['load'], filename: 'db.sql' },
        },
      },
      web: {
        image: 'wordpress',
        ...(options.writers === false
          ? {}
          : { depends_on: { db: { condition: 'service_started' } } }),
        volumes: ['uploads:/uploads'],
        'x-tug': { placement: { nodes: ['app1'] } },
      },
    },
    volumes: { uploads: { 'x-tug': { placement: { nodes: ['app1'] }, backup: { jitter: 0 } } } },
  });
  const spec = (image: string) => ({
    image,
    build: null,
    placement: { nodes: ['app1'] },
    replicas: 1,
    health: null,
  });
  const desired: DesiredState = {
    project: 'site',
    version: 'v1',
    compose,
    services: { db: spec('mariadb'), web: spec('wordpress') },
  };
  const ts = clock.toISOString();
  db.run(
    "INSERT INTO nodes(id,name,status,last_seen_at,created_at) VALUES('n1','app1','online',?,?)",
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
  db.run(
    "INSERT INTO backup_destination(id,url,env_names_json,updated_at) VALUES('default','s3:https://h/b','[]',?)",
    ts,
  );
  let seq = 0;
  const woken: string[] = [];
  const backups = createBackupService({
    db,
    clock: () => clock,
    queueCommand: (nodeId, _p, type, payload, deadline) => {
      const id = `cmd_${++seq}`;
      queued.push({ id, type, payload: payload as unknown as BackupJobPayload });
      db.run(
        "INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,deadline,created_at,updated_at) VALUES(?,?,?,?,'running',?,0,?,?,?)",
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
  backups.sync(clock);
  const restores = createRestoreService({
    db,
    backups,
    wake: (p) => woken.push(p),
    clock: () => clock,
  });
  const reportHeld = (held: boolean) =>
    db.run(
      `INSERT INTO node_statuses(id,node_id,project_id,observed_version,status_json,health,updated_at) VALUES('ns','n1','site','v1',?,'serving',?)
       ON CONFLICT(node_id,project_id) DO UPDATE SET status_json=excluded.status_json`,
      JSON.stringify({
        project: 'site',
        serviceStates: { web: { rolloutState: held ? 'held' : 'serving' } },
      }),
      ts,
    );
  /** A successful catalog entry for `target`, as a finished backup run would leave. */
  const catalog = (target: string, snapshot: string, finished: string) =>
    db.run(
      'INSERT INTO backup_runs(id,project_id,target,type,node_id,trigger,state,snapshot_id,finished_at,queued_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      `bkr_${snapshot}`,
      'site',
      target,
      'command',
      'n1',
      'manual',
      'succeeded',
      snapshot,
      finished,
      finished,
    );
  return {
    db,
    backups,
    restores,
    queued,
    woken,
    reportHeld,
    catalog,
    set: (iso: string) => (clock = at(iso)),
    state: (id: string) =>
      db.get<{ state: string; error: string | null }>('SELECT * FROM restore_runs WHERE id=?', id)!,
    holds: () =>
      db
        .all<{ service: string }>('SELECT * FROM service_holds')
        .map((h) => h.service)
        .sort(),
    lock: () => db.get<{ owner: string }>("SELECT * FROM locks WHERE name='project:site'"),
    events: (type: string) =>
      db.all<{ message: string }>('SELECT * FROM events WHERE type=?', type),
    finish: (commandId: string, state: string, error?: string) =>
      db.run(
        'UPDATE commands SET state=?,result_json=? WHERE id=?',
        state,
        JSON.stringify(error ? { error } : {}),
        commandId,
      ),
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  project: 'site',
  target: 'service:db',
  actor: 'alice',
  ...overrides,
});

test('writers are the services depending on a service, or mounting a volume and what depends on them', async () => {
  const f = await fixture();
  const state = JSON.parse(
    f.db.get<{ state_json: string }>('SELECT state_json FROM desired_states')!.state_json,
  ) as DesiredState;
  assert.deepEqual(discoverWriters(state.compose, 'service:db'), ['web'], 'web depends on db');
  assert.deepEqual(discoverWriters(state.compose, 'volume:uploads'), ['web'], 'web mounts uploads');
});

test('a plan names the snapshot, node and writers, and resolves latest from the catalog', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snapOLD', '2026-11-01T03:00:00Z');
  f.catalog('service:db', 'snapNEW', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  assert.deepEqual(
    [plan.snapshotId, plan.node, plan.writers, plan.safetyBackup, plan.mode],
    ['snapNEW', 'app1', ['web'], true, 'in-place'],
    'the most recent successful backup is used',
  );
  const raw = f.restores.plan(request({ from: 'abc123' }));
  assert.ok(
    !('error' in raw) && raw.snapshotId === 'abc123',
    'a raw snapshot id is passed through',
  );
  const missing = f.restores.plan(request({ from: 'bkr_ghost' }));
  assert.ok('error' in missing && /not a successful backup/.test(missing.error));
  const none = (await fixture()).restores.plan(request());
  assert.ok(
    'error' in none && /no successful backup in the catalog/.test(none.error),
    'nothing to restore says so',
  );
});

test('a target with no discoverable writers is refused unless the operator says there are none', async () => {
  const f = await fixture({ writers: false });
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const refused = f.restores.plan(request());
  assert.ok('error' in refused && refused.status === 409 && /--no-writers/.test(refused.error));
  assert.ok(
    !('error' in f.restores.plan(request({ noWriters: true }))),
    '--no-writers is accepted',
  );
  const named = f.restores.plan(request({ writers: ['web'] }));
  assert.ok(!('error' in named) && named.writers[0] === 'web', 'writers can be named explicitly');
  assert.ok(
    'error' in f.restores.plan(request({ writers: ['ghost'] })),
    'an unknown writer is refused',
  );
});

test('an in-place restore locks, holds writers, takes a safety backup, restores, then releases everything', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  const started = f.restores.start(request(), plan);
  assert.ok(!('error' in started));
  const id = started.restoreId;
  assert.equal(f.state(id).state, 'holding', 'waits for the writers to stop');
  assert.deepEqual(f.holds(), ['web'], 'the writers are held');
  assert.equal(f.lock()?.owner, `restore:${id}`, 'the project is locked against deploys');
  assert.ok(f.woken.includes('site'), 'agents are woken to apply the hold');

  f.restores.advance();
  assert.equal(f.state(id).state, 'holding', 'not held on the node yet, so nothing else happens');
  assert.equal(f.queued.length, 0, 'no backup or restore is queued before the writers stopped');

  f.reportHeld(true);
  f.restores.advance();
  assert.equal(f.state(id).state, 'safety_backup', 'a safety backup comes first');
  const safety = f.queued.at(-1)!;
  assert.equal(safety.type, 'backup.run');
  assert.ok(
    safety.payload.tags.includes('trigger:pre-restore'),
    'it is tagged so retention keeps it',
  );

  f.backups.onResult(safety.id, 'succeeded', {
    runId: safety.payload.runId,
    snapshotId: 'safety1',
    durationMs: 1,
  });
  f.restores.advance();
  assert.equal(f.state(id).state, 'restoring');
  const job = f.queued.at(-1)!;
  assert.equal(job.type, 'backup.restore');
  assert.deepEqual(job.payload.restore, { snapshotId: 'snap1', mode: 'in-place' });
  assert.deepEqual(
    job.payload.command?.restoreArgv,
    ['load'],
    'the restore command comes from the Compose file',
  );

  f.finish(job.id, 'succeeded');
  f.restores.advance();
  assert.equal(f.state(id).state, 'succeeded');
  assert.deepEqual(f.holds(), [], 'the writers are released');
  assert.equal(f.lock(), undefined, 'the project is unlocked');
  assert.equal(f.events('restore.completed').length, 1);
});

test('a second restore or deploy is refused while a restore holds the project lock', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  assert.ok(!('error' in f.restores.start(request(), plan)));
  const second = f.restores.start(request(), plan);
  assert.ok(
    'error' in second && second.status === 409 && /is locked by restore:/.test(second.error),
  );
});

test('a failed safety backup aborts before anything changed and releases the holds and the lock', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  const started = f.restores.start(request(), plan) as { restoreId: string };
  f.reportHeld(true);
  f.restores.advance();
  const safety = f.queued.at(-1)!;
  f.backups.onResult(safety.id, 'failed', { error: 'bucket unreachable' });
  f.restores.advance();
  assert.equal(f.state(started.restoreId).state, 'failed');
  assert.match(f.state(started.restoreId).error!, /safety backup failed.*nothing was changed/);
  assert.deepEqual(f.holds(), [], 'the writers are started again');
  assert.equal(f.lock(), undefined);
});

test('a restore that fails after data may have changed stays interrupted with the holds, until released or resumed', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request({ safetyBackup: false }));
  assert.ok(!('error' in plan) && plan.safetyBackup === false);
  const id = (f.restores.start(request({ safetyBackup: false }), plan) as { restoreId: string })
    .restoreId;
  f.reportHeld(true);
  f.restores.advance();
  const job = f.queued.at(-1)!;
  assert.equal(job.type, 'backup.restore', '--no-safety-backup goes straight to the restore');
  f.finish(job.id, 'failed', 'load exited 1');
  f.restores.advance();
  assert.equal(f.state(id).state, 'interrupted');
  assert.deepEqual(f.holds(), ['web'], 'a half-restored database must not serve traffic');
  assert.ok(f.lock(), 'the project stays locked');
  assert.equal(f.events('restore.failed').length, 1);

  assert.ok(!('error' in f.restores.resume(id)), 'resume runs the restore step again');
  assert.equal(f.state(id).state, 'restoring');
  f.finish(f.queued.at(-1)!.id, 'failed', 'again');
  f.restores.advance();
  assert.equal(f.state(id).state, 'interrupted');

  assert.ok(!('error' in f.restores.releaseInterrupted(id)));
  assert.equal(f.state(id).state, 'released');
  assert.deepEqual(f.holds(), []);
  assert.equal(f.lock(), undefined);
  assert.ok(
    'error' in f.restores.releaseInterrupted(id),
    'a finished restore cannot be released again',
  );
});

test('writers that never stop fail the restore after the timeout and release the project', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  const id = (f.restores.start(request(), plan) as { restoreId: string }).restoreId;
  f.set('2026-11-01T10:06:00Z');
  f.restores.advance();
  assert.equal(f.state(id).state, 'failed');
  assert.match(f.state(id).error!, /did not stop in time/);
  assert.deepEqual(f.holds(), []);
  assert.equal(f.lock(), undefined);
});

test('a scratch restore of a volume takes no lock and holds nothing', async () => {
  const f = await fixture();
  f.catalog('volume:uploads', 'vsnap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request({ target: 'volume:uploads', scratch: true }));
  assert.ok(
    !('error' in plan) &&
      plan.mode === 'scratch' &&
      plan.scratchVolume?.startsWith('tug_site_restore-'),
  );
  const started = f.restores.start(request({ target: 'volume:uploads', scratch: true }), plan) as {
    restoreId: string;
  };
  assert.deepEqual(f.holds(), [], 'nothing live is touched');
  assert.equal(f.lock(), undefined);
  const job = f.queued.at(-1)!;
  assert.equal(job.type, 'backup.restore');
  assert.equal(job.payload.restore?.mode, 'scratch');
  assert.equal(job.payload.restore?.scratchVolume, plan.scratchVolume);
  f.finish(job.id, 'succeeded');
  f.restores.advance();
  assert.equal(f.state(started.restoreId).state, 'succeeded');
  const service = f.restores.plan(request({ scratch: true }));
  assert.ok(
    'error' in service && /only available for volumes/.test(service.error),
    'services cannot be restored into scratch',
  );
});

test('scheduled backups of a target are skipped while it is being restored', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  f.restores.start(request(), plan);
  f.backups.tick(at('2026-11-01T03:00:00Z'));
  f.set('2026-11-02T03:00:30Z');
  f.backups.tick(at('2026-11-02T03:00:30Z'));
  const runs = f.db.all<{ state: string; error: string | null; target: string }>(
    "SELECT * FROM backup_runs WHERE trigger='schedule' AND target='service:db'",
  );
  assert.ok(
    runs.every((r) => r.state === 'cancelled' && r.error === 'restore_in_progress'),
    'a backup mid-restore would capture a half-restored state',
  );
});

test('an unfinished restore keeps the project locked across a control restart', async () => {
  const f = await fixture();
  f.catalog('service:db', 'snap1', '2026-11-01T09:00:00Z');
  const plan = f.restores.plan(request());
  assert.ok(!('error' in plan));
  const id = (f.restores.start(request(), plan) as { restoreId: string }).restoreId;
  f.db.run("DELETE FROM locks WHERE name='project:site'");
  f.restores.advance();
  assert.equal(f.lock()?.owner, `restore:${id}`, 're-adopting the restore takes the lock back');
});
