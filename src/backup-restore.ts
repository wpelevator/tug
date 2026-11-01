import { id } from './util.ts';
import { volumeName } from './container-spec.ts';
import type { BackupService } from './backup-scheduler.ts';
import type { Db, BackupRunRow, CommandRow, RestoreRunRow, NodeStatusRow } from './db.ts';
import type { ComposeFile, DesiredState, ProjectStatus } from './protocol.ts';

const MINUTE = 60_000;
const LOCK_TTL_MS = 15 * MINUTE;
const HOLD_TIMEOUT_MS = 5 * MINUTE;
/** How long a finished restore waits for its writers to serve again before it reports that they did not. */
const VERIFY_TIMEOUT_MS = 5 * MINUTE;
/** Restore states in which the project must stay locked. */
const LOCKED_STATES = ['locking', 'holding', 'safety_backup', 'restoring', 'interrupted'];
const TERMINAL = ['succeeded', 'failed', 'released'];

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

/**
 * The services that write to a target. For a service they are the services that depend on it, transitively;
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
      if (!writers.has(service) && service !== name && dependsOn(service).includes(current)) {
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
          error: `no services were found that write to ${request.target}; pass --writers to name them or --no-writers to restore without holding any`,
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
      ...(mode === 'scratch'
        ? { scratchVolume: volumeName(request.project, `restore-${id('r').slice(-6)}`) }
        : {}),
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
  function release(restore: RestoreRunRow): void {
    db.run('DELETE FROM service_holds WHERE restore_id=?', restore.id);
    unlock(restore);
    deps.wake(restore.project_id);
  }

  function move(
    restore: RestoreRunRow,
    state: string,
    extra: { error?: string; commandId?: string; safetyRunId?: string } = {},
  ): void {
    db.run(
      `UPDATE restore_runs SET state=?,state_changed_at=?,error=COALESCE(?,error),command_id=COALESCE(?,command_id),safety_run_id=COALESCE(?,safety_run_id),
       finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?`,
      state,
      stamp(),
      extra.error ?? null,
      extra.commandId ?? null,
      extra.safetyRunId ?? null,
      TERMINAL.includes(state) ? 1 : 0,
      stamp(),
      restore.id,
    );
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
      for (const service of restorePlan.writers)
        db.run(
          'INSERT OR REPLACE INTO service_holds(project_id,service,reason,restore_id,created_at) VALUES(?,?,?,?,?)',
          restore.project_id,
          service,
          `restore ${restoreId}`,
          restoreId,
          ts,
        );
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

  /** Fails a restore. Before anything changed, holds and the lock are dropped; after, they stay until released. */
  function fail(restore: RestoreRunRow, error: string, dataChanged: boolean): void {
    if (dataChanged) move(restore, 'interrupted', { error });
    else {
      release(restore);
      move(restore, 'failed', { error });
    }
    event(
      'error',
      'restore.failed',
      restore,
      `restore of ${restore.target} failed: ${error}${dataChanged ? '; the writers stay held until tug restore-release' : ''}`,
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

  /** Advances every restore that is waiting on something; safe to call often. */
  function advance(): void {
    for (const restore of db.all<RestoreRunRow>(
      `SELECT * FROM restore_runs WHERE state NOT IN ('succeeded','failed','released')`,
    )) {
      const age =
        clock().getTime() -
        new Date(restore.state_changed_at ?? restore.started_at ?? stamp()).getTime();
      // Keep the project locked while a restore is unfinished, across a control restart.
      if (restore.mode === 'in-place' && LOCKED_STATES.includes(restore.state)) lock(restore);
      const writers = JSON.parse(restore.writers_json) as string[];
      switch (restore.state) {
        case 'holding': {
          if (!writersReport(restore, writers, 'held')) {
            if (age > HOLD_TIMEOUT_MS) fail(restore, 'the writers did not stop in time', false);
            break;
          }
          if (!restore.safety_backup) {
            queueRestoreJob(restore);
            break;
          }
          const safety = backups.runNow(
            restore.project_id,
            [restore.target],
            restore.actor ?? 'restore',
            'pre-restore',
          );
          if (!safety.runs.length)
            return fail(
              restore,
              `the safety backup could not start: ${safety.errors.join('; ')}`,
              false,
            );
          move(restore, 'safety_backup', { safetyRunId: safety.runs[0].runId });
          break;
        }
        case 'safety_backup': {
          const run = db.get<BackupRunRow>(
            'SELECT * FROM backup_runs WHERE id=?',
            restore.safety_run_id,
          );
          if (!run || run.state === 'queued' || run.state === 'running') break;
          if (run.state === 'succeeded') queueRestoreJob(restore);
          else
            fail(
              restore,
              `the safety backup ${run.state}${run.error ? ` (${run.error})` : ''}; nothing was changed`,
              false,
            );
          break;
        }
        case 'restoring': {
          const command = db.get<CommandRow>(
            'SELECT * FROM commands WHERE id=?',
            restore.command_id,
          );
          if (!command || ['pending', 'running'].includes(command.state)) break;
          if (command.state === 'succeeded') {
            if (restore.mode === 'in-place') release(restore);
            // The data is back; the restore is done when the services that were stopped are serving again.
            if (restore.mode === 'in-place' && writers.length) move(restore, 'verifying');
            else complete(restore);
          } else {
            const error =
              (JSON.parse(command.result_json ?? '{}') as { error?: string }).error ??
              `the restore command ${command.state}`;
            fail(restore, error, restore.mode === 'in-place');
          }
          break;
        }
        case 'verifying': {
          if (writersReport(restore, writers, 'serving')) complete(restore);
          else if (age > VERIFY_TIMEOUT_MS)
            complete(
              restore,
              `the data was restored, but ${writers.join(', ')} did not report serving within ${VERIFY_TIMEOUT_MS / MINUTE} minutes; check tug status`,
            );
          break;
        }
        default:
      }
    }
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

  function list(project: string, limit = 20): RestoreRunRow[] {
    return db.all<RestoreRunRow>(
      'SELECT * FROM restore_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?',
      project,
      limit,
    );
  }

  return { plan, start, advance, releaseInterrupted, resume, holds, list };
}

export type RestoreService = ReturnType<typeof createRestoreService>;
