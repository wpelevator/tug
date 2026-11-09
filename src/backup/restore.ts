import { id } from '../db/row.ts';
import { advance as advanceRow, isTerminal, terminalStates, statesSql } from '../db/lifecycle.ts';
import { RESTORE_LOCKED_STATES, restoreLifecycle } from '../db/lifecycles.ts';
import type { RestoreState } from '../db/lifecycles.ts';
import { scratchVolumeName } from '../container-spec.ts';
import type { BackupService } from './scheduler.ts';
import type { Db, BackupRunRow, CommandRow, RestoreRunRow, NodeStatusRow } from '../db/db.ts';
import type { ComposeFile, DesiredState, ProjectStatus } from '../protocol.ts';

const MINUTE = 60_000;
const LOCK_TTL_MS = 15 * MINUTE;
const HOLD_TIMEOUT_MS = 5 * MINUTE;
/** How long a finished restore waits for its writers to serve again before it reports that they did not. */
const VERIFY_TIMEOUT_MS = 5 * MINUTE;

export interface RestoreRequest {
  project: string;
  target: string;
  /** `latest`, a backup run id, or a restic snapshot id. */
  from?: string;
  scratch?: boolean;
  safetyBackup?: boolean;
  writers?: string[];
  noWriters?: boolean;
  actor: string;
}

export interface RestorePlan {
  project: string;
  target: string;
  node: string;
  snapshotId: string;
  snapshotTime: string | null;
  mode: 'in-place' | 'scratch';
  scratchVolume?: string;
  writers: string[];
  safetyBackup: boolean;
}

export interface RestoreDeps {
  db: Db;
  backups: BackupService;
  /** Wakes agents so a hold or command is picked up without waiting for the next poll. */
  wake: (project: string) => void;
  clock?: () => Date;
}

const HOST_KEY = /host|server|addr|endpoint|url|uri|dsn/i;

/**
 * True when an environment entry points at `service` over the network: a host-like variable that is exactly the
 * service name (`WORDPRESS_DB_HOST=db`), or a value that names it as a host (`db:3306`, `mysql://u:p@db/app`,
 * `mysql:host=db;dbname=app`). A service reached across nodes has no `depends_on` to find it by.
 */
export function environmentReaches(service: string, key: string, value: string): boolean {
  const name = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (value === service) return HOST_KEY.test(key);
  return [
    new RegExp(`^${name}:\\d+$`),
    new RegExp(`(?:://|@)(?:[^/@\\s]*@)?${name}(?::\\d+)?(?:[/?\\s]|$)`),
    new RegExp(`(?:host|server)=${name}(?:[;:,\\s]|$)`, 'i'),
  ].some((pattern) => pattern.test(value));
}

function environmentOf(service: ComposeFile['services'][string]): [string, string][] {
  const env = service.environment as unknown;
  if (Array.isArray(env))
    return env.map(String).map((entry) => {
      const at = entry.indexOf('=');
      return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
    });
  return env && typeof env === 'object'
    ? Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
    : [];
}

/**
 * The services that write to a target. For a service they are the services that depend on it, transitively,
 * plus the services whose environment names it as a host, which is how a service on another node reaches it (only for the target itself, not for what depends on the writers);
 * for a volume, the services that mount it and everything depending on those. Stored `depends_on` is used,
 * because the per-node copies drop cross-node dependencies.
 */
export function discoverWriters(compose: ComposeFile, target: string): string[] {
  const [kind, name] = [
    target.slice(0, target.indexOf(':')),
    target.slice(target.indexOf(':') + 1),
  ];
  const dependsOn = (service: string): string[] => {
    const deps = compose.services[service]?.depends_on;
    if (Array.isArray(deps)) return deps.map(String);
    return deps && typeof deps === 'object' ? Object.keys(deps) : [];
  };
  const seeds =
    kind === 'volume'
      ? Object.entries(compose.services)
          .filter(([, svc]) =>
            (svc.volumes ?? []).some(
              (mount) =>
                typeof mount === 'object' && mount.type === 'volume' && mount.source === name,
            ),
          )
          .map(([service]) => service)
      : [name];
  const writers = new Set<string>(kind === 'volume' ? seeds : []);
  const queue = [...seeds];
  while (queue.length) {
    const current = queue.pop()!;
    for (const service of Object.keys(compose.services))
      if (
        !writers.has(service) &&
        service !== name &&
        (dependsOn(service).includes(current) ||
          (kind === 'service' &&
            current === name &&
            environmentOf(compose.services[service]).some(([k, v]) =>
              environmentReaches(name, k, v),
            )))
      ) {
        writers.add(service);
        queue.push(service);
      }
  }
  return [...writers].sort();
}

export function createRestoreService(deps: RestoreDeps) {
  const { db, backups } = deps;
  const clock = deps.clock ?? (() => new Date());
  const stamp = () => clock().toISOString();

  const deployed = (project: string): DesiredState | undefined => {
    const row = db.get<{ state_json: string }>(
      `SELECT ds.state_json FROM projects p JOIN deployments d ON d.id=p.current_deployment_id AND d.state='succeeded'
       JOIN desired_states ds ON ds.deployment_id=d.id WHERE p.id=?`,
      project,
    );
    return row ? (JSON.parse(row.state_json) as DesiredState) : undefined;
  };

  function event(
    level: 'info' | 'warn' | 'error',
    type: string,
    restore: RestoreRunRow,
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    db.run(
      'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id('evt'),
      restore.project_id,
      null,
      restore.node_id,
      level,
      type,
      message,
      JSON.stringify({
        restoreId: restore.id,
        target: restore.target,
        snapshotId: restore.snapshot_id,
        ...extra,
      }),
      stamp(),
      restore.actor,
    );
  }

  function resolveSnapshot(
    project: string,
    target: string,
    from: string | undefined,
  ): { snapshotId: string; time: string | null } | { error: string } {
    const latest = !from || from === 'latest';
    if (!latest && !from.startsWith('bkr_')) return { snapshotId: from, time: null };
    const run = latest
      ? // A safety snapshot records the state just before a restore, often a damaged one, so it is never "the latest backup".
        db.get<BackupRunRow>(
          `SELECT * FROM backup_runs WHERE project_id=? AND target=? AND state='succeeded' AND snapshot_id IS NOT NULL
           AND trigger != 'pre-restore' ORDER BY finished_at DESC LIMIT 1`,
          project,
          target,
        )
      : db.get<BackupRunRow>(
          "SELECT * FROM backup_runs WHERE id=? AND project_id=? AND target=? AND state='succeeded' AND snapshot_id IS NOT NULL",
          from,
          project,
          target,
        );
    if (!run?.snapshot_id)
      return {
        error: latest
          ? `${target} has no successful backup in the catalog; pass --from with a snapshot id`
          : `backup run ${from} is not a successful backup of ${target}`,
      };
    return { snapshotId: run.snapshot_id, time: run.finished_at };
  }

  /** Validates a request and describes what a restore would do; nothing is changed. */
  function plan(request: RestoreRequest): RestorePlan | { error: string; status: number } {
    // The most recent deployment may have moved the target since the last scheduler tick.
    backups.sync();
    const desired = deployed(request.project);
    if (!desired)
      return { error: `project ${request.project} has no successful deployment`, status: 409 };
    const schedule = db.get<{ node_id: string | null; type: string }>(
      'SELECT node_id,type FROM backup_schedules WHERE project_id=? AND target=? AND enabled=1',
      request.project,
      request.target,
    );
    if (!schedule?.node_id)
      return {
        error: `${request.target} is not a backup target of project ${request.project}`,
        status: 404,
      };
    const node = db.get<{ name: string }>(
      'SELECT name FROM nodes WHERE id=?',
      schedule.node_id,
    )!.name;
    const mode = request.scratch ? 'scratch' : 'in-place';
    if (mode === 'scratch' && schedule.type !== 'volume')
      return {
        error:
          'a scratch restore is only available for volumes; restore a service in place or load the dump by hand',
        status: 400,
      };
    const snapshot = resolveSnapshot(request.project, request.target, request.from);
    if ('error' in snapshot) return { error: snapshot.error, status: 404 };
    let writers: string[] = [];
    if (mode === 'in-place') {
      writers = request.writers ?? discoverWriters(desired.compose, request.target);
      for (const writer of writers)
        if (!desired.compose.services[writer])
          return { error: `writer ${writer} is not a service of ${request.project}`, status: 400 };
      if (!writers.length && !request.noWriters && !request.writers)
        return {
          error: `no services were found that write to ${request.target} (looked at depends_on, volume mounts and host names in environment variables); pass --writers to name them or --no-writers to restore without holding any`,
          status: 409,
        };
    }
    return {
      project: request.project,
      target: request.target,
      node,
      snapshotId: snapshot.snapshotId,
      snapshotTime: snapshot.time,
      mode,
      ...(mode === 'scratch' ? { scratchVolume: scratchVolumeName(request.project, id('r')) } : {}),
      writers,
      safetyBackup: mode === 'in-place' && request.safetyBackup !== false,
    };
  }

  function lock(restore: RestoreRunRow): boolean {
    const name = `project:${restore.project_id}`;
    const expires = new Date(clock().getTime() + LOCK_TTL_MS).toISOString();
    db.run('DELETE FROM locks WHERE expires_at < ?', stamp());
    const existing = db.get<{ owner: string }>('SELECT owner FROM locks WHERE name=?', name);
    if (existing && existing.owner !== `restore:${restore.id}`) return false;
    db.run(
      `INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at`,
      name,
      `restore:${restore.id}`,
      expires,
      stamp(),
    );
    return true;
  }
  function unlock(restore: RestoreRunRow): void {
    db.run(
      'DELETE FROM locks WHERE name=? AND owner=?',
      `project:${restore.project_id}`,
      `restore:${restore.id}`,
    );
  }
  /**
   * Drops a restore's holds and lock. Holds a deploy placed for a move (no `restore_id`) are dropped with them,
   * unless `keepMoveHolds`: a restore that failed before changing data must not start the writers against the
   * empty database it was meant to fill.
   */
  function release(restore: RestoreRunRow, keepMoveHolds = false): void {
    db.run('DELETE FROM service_holds WHERE restore_id=?', restore.id);
    if (!keepMoveHolds)
      for (const service of JSON.parse(restore.writers_json) as string[])
        db.run(
          'DELETE FROM service_holds WHERE project_id=? AND service=? AND restore_id IS NULL',
          restore.project_id,
          service,
        );
    unlock(restore);
    deps.wake(restore.project_id);
  }

  /** Moves a restore along `restoreLifecycle`; an undeclared move throws, and a lost race leaves the row as it was. */
  function move(
    restore: RestoreRunRow,
    state: RestoreState,
    extra: { error?: string; commandId?: string; safetyRunId?: string } = {},
  ): void {
    const at = stamp();
    const moved = advanceRow(
      db,
      restoreLifecycle,
      restore.id,
      restore.state as RestoreState,
      state,
      {
        state_changed_at: at,
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        ...(extra.commandId !== undefined ? { command_id: extra.commandId } : {}),
        ...(extra.safetyRunId !== undefined ? { safety_run_id: extra.safetyRunId } : {}),
        ...(isTerminal(restoreLifecycle, state) ? { finished_at: at } : {}),
      },
    );
    if (moved) restore.state = state;
  }

  /** Starts a restore. Scratch restores run straight away; in-place restores lock, hold, snapshot, restore, release. */
  function start(
    request: RestoreRequest,
    restorePlan: RestorePlan,
  ): { restoreId: string; scratchVolume?: string } | { error: string; status: number } {
    const restoreId = id('rst');
    const ts = stamp();
    db.run(
      `INSERT INTO restore_runs(id,project_id,target,snapshot_id,mode,scratch_volume,safety_backup,writers_json,state,actor,started_at,state_changed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      restoreId,
      restorePlan.project,
      restorePlan.target,
      restorePlan.snapshotId,
      restorePlan.mode,
      restorePlan.scratchVolume ?? null,
      restorePlan.safetyBackup ? 1 : 0,
      JSON.stringify(restorePlan.writers),
      'locking',
      request.actor,
      ts,
      ts,
    );
    const restore = db.get<RestoreRunRow>('SELECT * FROM restore_runs WHERE id=?', restoreId)!;
    if (restorePlan.mode === 'in-place' && !lock(restore)) {
      db.run('DELETE FROM restore_runs WHERE id=?', restoreId);
      const owner = db.get<{ owner: string }>(
        'SELECT owner FROM locks WHERE name=?',
        `project:${restore.project_id}`,
      )?.owner;
      return {
        error: `project ${restore.project_id} is locked by ${owner}; try again when it finishes`,
        status: 409,
      };
    }
    event(
      'info',
      'restore.started',
      restore,
      `restore of ${restore.target} from snapshot ${restore.snapshot_id.slice(0, 8)} started (${restore.mode})`,
      { mode: restore.mode, writers: restorePlan.writers },
    );
    if (restore.mode === 'scratch') queueRestoreJob(restore);
    else move(restore, 'holding');
    if (restore.mode === 'in-place')
      for (const service of restorePlan.writers) {
        // A hold a deploy placed for a move stays as it is; this restore drops it when it succeeds.
        if (
          db.get(
            'SELECT 1 FROM service_holds WHERE project_id=? AND service=? AND restore_id IS NULL',
            restore.project_id,
            service,
          )
        )
          continue;
        db.run(
          'INSERT OR REPLACE INTO service_holds(project_id,service,reason,restore_id,created_at) VALUES(?,?,?,?,?)',
          restore.project_id,
          service,
          `restore ${restoreId}`,
          restoreId,
          ts,
        );
      }
    deps.wake(restore.project_id);
    advance();
    return {
      restoreId,
      ...(restorePlan.scratchVolume ? { scratchVolume: restorePlan.scratchVolume } : {}),
    };
  }

  /** True when every writer reports `rolloutState` on every node it is placed on. */
  const writersReport = (
    restore: RestoreRunRow,
    writers: string[],
    rolloutState: string,
  ): boolean => {
    const desired = deployed(restore.project_id);
    if (!desired) return false;
    return writers.every((service) => {
      const nodes = desired.services[service]?.placement.nodes ?? [];
      return nodes.every((node) => {
        const row = db.get<NodeStatusRow>(
          'SELECT s.* FROM node_statuses s JOIN nodes n ON n.id=s.node_id WHERE n.name=? AND s.project_id=?',
          node,
          restore.project_id,
        );
        const status = row ? (JSON.parse(row.status_json) as ProjectStatus) : undefined;
        return status?.serviceStates?.[service]?.rolloutState === rolloutState;
      });
    });
  };

  /** Says which writers never reported `held` and why: the node's own apply error, or that it has not reported. */
  const holdDiagnosis = (restore: RestoreRunRow, writers: string[]): string => {
    const desired = deployed(restore.project_id);
    const problems: string[] = [];
    for (const service of writers)
      for (const node of desired?.services[service]?.placement.nodes ?? []) {
        const row = db.get<NodeStatusRow>(
          'SELECT s.* FROM node_statuses s JOIN nodes n ON n.id=s.node_id WHERE n.name=? AND s.project_id=?',
          node,
          restore.project_id,
        );
        const status = row ? (JSON.parse(row.status_json) as ProjectStatus) : undefined;
        const state = status?.serviceStates?.[service]?.rolloutState;
        if (state === 'held') continue;
        problems.push(
          !status
            ? `${service} on ${node}: the node has not reported`
            : `${service} on ${node}: ${state ?? 'no state'}${status.error ? `; the node's apply failed with: ${status.error}` : ''}`,
        );
      }
    return problems.join('; ');
  };

  /** Fails a restore. Before anything changed, holds and the lock are dropped; after, they stay until released. */
  function fail(restore: RestoreRunRow, error: string, dataChanged: boolean): void {
    if (dataChanged) move(restore, 'interrupted', { error });
    else {
      release(restore, true);
      move(restore, 'failed', { error });
    }
    event(
      'error',
      'restore.failed',
      restore,
      `restore of ${restore.target} failed: ${error}${dataChanged ? '; the writers stay held until tug restore release' : ''}`,
      { error, held: dataChanged },
    );
  }

  function queueRestoreJob(restore: RestoreRunRow): void {
    const queued = backups.queueRestore(
      restore.project_id,
      restore.target,
      {
        snapshotId: restore.snapshot_id,
        mode: restore.mode,
        ...(restore.scratch_volume ? { scratchVolume: restore.scratch_volume } : {}),
      },
      restore.id,
    );
    if ('error' in queued) return fail(restore, queued.error, restore.state === 'interrupted');
    move(restore, 'restoring', { commandId: queued.commandId });
    db.run('UPDATE restore_runs SET node_id=? WHERE id=?', queued.nodeId, restore.id);
  }

  function advanceHolding(restore: RestoreRunRow, writers: string[], age: number): void {
    if (!writersReport(restore, writers, 'held')) {
      if (age > HOLD_TIMEOUT_MS) {
        const why = holdDiagnosis(restore, writers);
        fail(restore, `the writers did not stop in time${why ? ` (${why})` : ''}`, false);
      }
      return;
    }
    if (!restore.safety_backup) return queueRestoreJob(restore);
    const safety = backups.runNow(
      restore.project_id,
      [restore.target],
      restore.actor ?? 'restore',
      'pre-restore',
    );
    if (!safety.runs.length)
      return fail(restore, `the safety backup could not start: ${safety.errors.join('; ')}`, false);
    move(restore, 'safety_backup', { safetyRunId: safety.runs[0].runId });
  }

  function advanceSafetyBackup(restore: RestoreRunRow): void {
    const run = db.get<BackupRunRow>('SELECT * FROM backup_runs WHERE id=?', restore.safety_run_id);
    if (!run || run.state === 'queued' || run.state === 'running') return;
    if (run.state === 'succeeded') return queueRestoreJob(restore);
    fail(
      restore,
      `the safety backup ${run.state}${run.error ? ` (${run.error})` : ''}; nothing was changed`,
      false,
    );
  }

  function advanceRestoring(restore: RestoreRunRow, writers: string[]): void {
    const command = db.get<CommandRow>('SELECT * FROM commands WHERE id=?', restore.command_id);
    if (!command || ['pending', 'running'].includes(command.state)) return;
    if (command.state !== 'succeeded') {
      const error =
        (JSON.parse(command.result_json ?? '{}') as { error?: string }).error ??
        `the restore command ${command.state}`;
      return fail(restore, error, restore.mode === 'in-place');
    }
    if (restore.mode === 'in-place') release(restore);
    // The data is back; the restore is done when the services that were stopped are serving again.
    if (restore.mode === 'in-place' && writers.length) move(restore, 'verifying');
    else complete(restore);
  }

  function advanceVerifying(restore: RestoreRunRow, writers: string[], age: number): void {
    if (writersReport(restore, writers, 'serving')) return complete(restore);
    if (age > VERIFY_TIMEOUT_MS)
      complete(
        restore,
        `the data was restored, but ${writers.join(', ')} did not report serving within ${VERIFY_TIMEOUT_MS / MINUTE} minutes; check tug status`,
      );
  }

  function advanceRestore(restore: RestoreRunRow): void {
    const age =
      clock().getTime() -
      new Date(restore.state_changed_at ?? restore.started_at ?? stamp()).getTime();
    // Keep the project locked while a restore is unfinished, across a control restart.
    if (
      restore.mode === 'in-place' &&
      (RESTORE_LOCKED_STATES as readonly string[]).includes(restore.state)
    )
      lock(restore);
    const writers = JSON.parse(restore.writers_json) as string[];
    switch (restore.state) {
      case 'holding':
        return advanceHolding(restore, writers, age);
      case 'safety_backup':
        return advanceSafetyBackup(restore);
      case 'restoring':
        return advanceRestoring(restore, writers);
      case 'verifying':
        return advanceVerifying(restore, writers, age);
    }
  }

  /** Advances every restore that is waiting on something; safe to call often. */
  function advance(): void {
    for (const restore of db.all<RestoreRunRow>(
      `SELECT * FROM restore_runs WHERE state NOT IN (${statesSql(terminalStates(restoreLifecycle))})`,
    ))
      advanceRestore(restore);
  }

  function complete(restore: RestoreRunRow, warning?: string): void {
    move(restore, 'succeeded', warning ? { error: warning } : {});
    event(
      warning ? 'warn' : 'info',
      'restore.completed',
      restore,
      `restore of ${restore.target} completed${restore.scratch_volume ? ` into volume ${restore.scratch_volume}` : ''}${warning ? `, but ${warning}` : ''}`,
      { scratchVolume: restore.scratch_volume, ...(warning ? { warning } : {}) },
    );
  }

  /** Drops the holds and the lock of an interrupted restore; the data may be partly restored. */
  function releaseInterrupted(restoreId: string): { ok: true } | { error: string; status: number } {
    const restore = db.get<RestoreRunRow>('SELECT * FROM restore_runs WHERE id=?', restoreId);
    if (!restore) return { error: 'restore not found', status: 404 };
    if (restore.state !== 'interrupted')
      return { error: `restore is ${restore.state}, not interrupted`, status: 409 };
    release(restore);
    move(restore, 'released');
    event(
      'warn',
      'restore.released',
      restore,
      `holds for restore of ${restore.target} released; its data may be partly restored`,
    );
    return { ok: true };
  }

  /** Runs the restore step again for an interrupted restore, with the holds still in place. */
  function resume(restoreId: string): { ok: true } | { error: string; status: number } {
    const restore = db.get<RestoreRunRow>('SELECT * FROM restore_runs WHERE id=?', restoreId);
    if (!restore) return { error: 'restore not found', status: 404 };
    if (restore.state !== 'interrupted')
      return { error: `restore is ${restore.state}, not interrupted`, status: 409 };
    queueRestoreJob(restore);
    return { ok: true };
  }

  /** Per-project holds delivered to agents in the work response. */
  function holds(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const row of db.all<{ project_id: string; service: string }>(
      'SELECT project_id,service FROM service_holds',
    ))
      (result[row.project_id] ??= []).push(row.service);
    return result;
  }

  function list(project: string, limit = 20, interruptedOnly = false): RestoreRunRow[] {
    if (interruptedOnly)
      return db.all<RestoreRunRow>(
        "SELECT * FROM restore_runs WHERE project_id=? AND state='interrupted' ORDER BY started_at DESC,id",
        project,
      );
    return db.all<RestoreRunRow>(
      'SELECT * FROM restore_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?',
      project,
      limit,
    );
  }

  /**
   * Stops a restore's current job. While it waits on its safety backup, that backup fails and nothing has changed; while
   * it is restoring, the job fails and the restore is interrupted, with its writers still stopped for resume or release.
   */
  function cancel(id: string): { ok: true; state: string } | { error: string; status: number } {
    const restore = db.get<RestoreRunRow>('SELECT * FROM restore_runs WHERE id=?', id);
    if (!restore) return { error: 'restore not found', status: 404 };
    const stopped =
      restore.state === 'safety_backup' && restore.safety_run_id
        ? backups.cancelRun(restore.project_id, restore.safety_run_id)
        : restore.state === 'restoring'
          ? backups.cancelJob(restore.node_id, restore.project_id, restore.command_id)
          : {
              error: `restore is ${restore.state}; only one waiting on its safety backup or restoring can be cancelled`,
              status: 409,
            };
    return 'error' in stopped ? stopped : { ok: true, state: restore.state };
  }

  return { plan, start, advance, releaseInterrupted, resume, cancel, holds, list };
}

export type RestoreService = ReturnType<typeof createRestoreService>;
