import { cronPeriodMs, nextCronRun } from './cron.ts';
import { resolveBackups } from './backup-config.ts';
import { projectRepository } from './backup-destination.ts';
import { networkName, volumeName } from './container-spec.ts';
import { id } from './util.ts';
import { isUniqueViolation } from './db-driver.ts';
import type { ResolvedBackup } from './backup-config.ts';
import type { Db } from './db.ts';
import type { BackupDestinationRow, BackupRunRow, BackupScheduleRow } from './db.ts';
import type {
  BackupJobPayload,
  BackupJobResult,
  CommandResultPayload,
  CommandType,
  DesiredState,
  JobStatus,
} from './protocol.ts';

/** Pinned by tag; override on control with `TUG_RESTIC_IMAGE` (a digest reference is recommended for production). */
export const DEFAULT_RESTIC_IMAGE = 'restic/restic:0.17.3';
const MINUTE = 60_000;
const DEFAULT_MEMORY = '512m';
const RETRY_DELAY_MS = 10 * MINUTE;
const AGENT_LOST_MS = 10 * MINUTE;
const MAX_DEADLINE_MS = 6 * 3600_000;
const MANUAL_DEADLINE_MS = 30 * MINUTE;
const STALE_REPEAT_MS = 24 * 3600_000;
const MAX_CATCH_UP_SLOTS = 20_000;

export type RunTrigger = 'schedule' | 'manual' | 'pre-restore' | 'catch-up' | 'retry';

export interface BackupServiceDeps {
  db: Db;
  queueCommand(
    nodeId: string,
    projectId: string | null,
    type: CommandType,
    payload: Record<string, unknown>,
    deadline?: string,
  ): string;
  /** Removes credential values from error text before it is stored. */
  redact?: (text: string) => string;
  resticImage?: string;
  /** Clock override for tests. */
  clock?: () => Date;
}

export interface TargetStatus {
  project: string;
  target: string;
  node: string | null;
  type: string;
  schedule: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
}

function parse<T>(json: string | null | undefined, fallback: T): T {
  try {
    return json ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Where a backup target runs, from the resolved desired state (labels are already resolved there). */
export function targetNode(target: ResolvedBackup, desired: DesiredState): string | undefined {
  if (target.kind === 'service') {
    const nodes = desired.services[target.name]?.placement.nodes ?? [];
    return nodes.length === 1 ? nodes[0] : undefined;
  }
  const placed = desired.compose.volumes?.[target.name]?.['x-tug']?.placement?.nodes ?? [];
  if (placed.length) return placed.length === 1 ? placed[0] : undefined;
  const mounting = Object.entries(desired.compose.services).filter(([, svc]) =>
    (svc.volumes ?? []).some(
      (mount) =>
        typeof mount === 'object' && mount.type === 'volume' && mount.source === target.name,
    ),
  );
  const nodes = [
    ...new Set(mounting.flatMap(([name]) => desired.services[name]?.placement.nodes ?? [])),
  ];
  return nodes.length === 1 ? nodes[0] : undefined;
}

export function createBackupService(deps: BackupServiceDeps) {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const resticImage = deps.resticImage || DEFAULT_RESTIC_IMAGE;
  const redact = deps.redact ?? ((text: string) => text);
  const started = clock().getTime();
  const stamp = () => clock().toISOString();
  const heartbeats = new Map<string, number>();

  const destination = () =>
    db.get<BackupDestinationRow>("SELECT * FROM backup_destination WHERE id='default'");
  const nodeId = (name: string) =>
    db.get<{ id: string }>('SELECT id FROM nodes WHERE name=?', name)?.id;
  const nodeName = (nodeIdValue: string | null) =>
    nodeIdValue
      ? (db.get<{ name: string }>('SELECT name FROM nodes WHERE id=?', nodeIdValue)?.name ?? null)
      : null;

  function event(
    level: 'info' | 'warn' | 'error',
    type: string,
    projectId: string,
    message: string,
    metadata: Record<string, unknown>,
    node?: string | null,
    actor?: string,
  ): void {
    db.run(
      'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id('evt'),
      projectId,
      null,
      node ?? null,
      level,
      type,
      message,
      JSON.stringify(metadata),
      stamp(),
      actor ?? null,
    );
  }

  /** Desired states of projects whose current deployment succeeded. */
  function deployed(
    projectId?: string,
  ): { project: string; desired: DesiredState; deploymentId: string }[] {
    const rows = db.all<{ project: string; state_json: string; deployment_id: string }>(
      `SELECT p.id AS project, ds.state_json, d.id AS deployment_id FROM projects p
       JOIN deployments d ON d.id=p.current_deployment_id AND d.state='succeeded'
       JOIN desired_states ds ON ds.deployment_id=d.id ${projectId ? 'WHERE p.id=?' : ''}`,
      ...(projectId ? [projectId] : []),
    );
    return rows.map((row) => ({
      project: row.project,
      desired: JSON.parse(row.state_json) as DesiredState,
      deploymentId: row.deployment_id,
    }));
  }

  /** Brings `backup_schedules` in line with the current successful deployments. */
  function sync(at: Date = clock()): void {
    for (const { project, desired, deploymentId } of deployed()) {
      const { targets } = resolveBackups(desired.compose, project);
      const seen = new Set<string>();
      for (const target of targets) {
        const node = targetNode(target, desired);
        const config = JSON.stringify({ ...target, node });
        const existing = db.get<BackupScheduleRow>(
          'SELECT * FROM backup_schedules WHERE project_id=? AND target=?',
          project,
          target.target,
        );
        seen.add(target.target);
        const ts = stamp();
        if (!existing) {
          const next = nextCronRun(target.schedule, at);
          if (!next) continue;
          db.run(
            `INSERT INTO backup_schedules(id,project_id,target,type,node_id,config_json,schedule,jitter_seconds,next_run_at,deployment_id,enabled,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`,
            id('bks'),
            project,
            target.target,
            target.type,
            node ? (nodeId(node) ?? null) : null,
            config,
            target.schedule,
            target.jitterSeconds,
            next.toISOString(),
            deploymentId,
            ts,
            ts,
          );
          continue;
        }
        const scheduleChanged = existing.schedule !== target.schedule;
        const next = scheduleChanged ? nextCronRun(target.schedule, at) : null;
        db.run(
          `UPDATE backup_schedules SET type=?,node_id=?,config_json=?,schedule=?,jitter_seconds=?,deployment_id=?,enabled=1,next_run_at=?,updated_at=? WHERE id=?`,
          target.type,
          node ? (nodeId(node) ?? null) : null,
          config,
          target.schedule,
          target.jitterSeconds,
          deploymentId,
          next ? next.toISOString() : existing.next_run_at,
          ts,
          existing.id,
        );
      }
      // A target that left the Compose file stops running; its snapshots stay in the repository.
      for (const row of db.all<BackupScheduleRow>(
        'SELECT * FROM backup_schedules WHERE project_id=? AND enabled=1',
        project,
      ))
        if (!seen.has(row.target))
          db.run('UPDATE backup_schedules SET enabled=0,updated_at=? WHERE id=?', stamp(), row.id);
    }
  }

  function buildPayload(
    schedule: BackupScheduleRow,
    runId: string,
    trigger: RunTrigger,
    desired: DesiredState,
    node: string,
  ): BackupJobPayload {
    const config = parse<ResolvedBackup>(schedule.config_json, {} as ResolvedBackup);
    const dest = destination()!;
    const payload: BackupJobPayload = {
      runId,
      project: schedule.project_id,
      target: schedule.target,
      type: config.type,
      repository: projectRepository(dest.url, schedule.project_id),
      resticImage,
      node,
      tags: [
        'tug',
        `project:${schedule.project_id}`,
        `target:${schedule.target}`,
        `type:${config.type}`,
        `run:${runId}`,
        `trigger:${trigger}`,
      ],
      retention: config.retention,
      limits: { memory: DEFAULT_MEMORY, timeoutSec: config.timeoutSec },
    };
    if (config.kind === 'service') {
      payload.service = {
        name: config.name,
        image: desired.services[config.name]?.image ?? '',
        network: networkName(schedule.project_id),
        databases: config.databases ?? [],
        user: config.user ?? 'root',
        passwordSecret: config.passwordSecret ?? '',
      };
    } else {
      payload.volume = {
        name: config.name,
        dockerVolume: volumeName(schedule.project_id, config.name),
        exclude: config.exclude,
      };
    }
    return payload;
  }

  function insertRun(
    schedule: BackupScheduleRow,
    trigger: RunTrigger,
    scheduledFor: string | null,
    state: 'queued' | 'missed',
    extra: {
      error?: string;
      actor?: string;
      commandId?: string;
      runId?: string;
      nodeId?: string | null;
    } = {},
  ): string | null {
    const runId = extra.runId ?? id('bkr');
    try {
      db.run(
        `INSERT INTO backup_runs(id,schedule_id,project_id,target,type,node_id,command_id,trigger,state,scheduled_for,queued_at,finished_at,error,actor,deployment_version)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId,
        schedule.id,
        schedule.project_id,
        schedule.target,
        schedule.type,
        extra.nodeId ?? schedule.node_id,
        extra.commandId ?? null,
        trigger,
        state,
        scheduledFor,
        stamp(),
        state === 'missed' ? stamp() : null,
        extra.error ?? null,
        extra.actor ?? null,
        null,
      );
    } catch (error) {
      if (isUniqueViolation(error)) return null; // this slot already has a run
      throw error;
    }
    return runId;
  }

  /** Queues one backup of a schedule's target; returns the run id, or why it could not be queued. */
  function queueRun(
    schedule: BackupScheduleRow,
    trigger: RunTrigger,
    scheduledFor: string | null,
    at: Date,
    actor?: string,
  ): { runId: string } | { error: string } {
    const config = parse<ResolvedBackup>(schedule.config_json, {} as ResolvedBackup);
    const fail = (error: string, type: string) => {
      const runId = insertRun(schedule, trigger, scheduledFor, 'missed', { error, actor });
      if (runId)
        event(
          'error',
          type,
          schedule.project_id,
          `backup of ${schedule.target} could not start: ${error}`,
          {
            runId,
            target: schedule.target,
            reason: error,
          },
          nodeName(schedule.node_id),
          actor,
        );
      return { error };
    };
    if (!destination()) {
      const runId = insertRun(schedule, trigger, scheduledFor, 'missed', {
        error: 'no backup destination is configured',
        actor,
      });
      if (runId)
        event(
          'warn',
          'backup.no_destination',
          schedule.project_id,
          `backup of ${schedule.target} skipped: no backup destination is configured; run tug backup-destination-set`,
          {
            runId,
            target: schedule.target,
          },
          null,
          actor,
        );
      return { error: 'no backup destination is configured' };
    }
    const current = deployed(schedule.project_id)[0];
    const node = current ? targetNode(config, current.desired) : undefined;
    if (!current || !node || !schedule.node_id)
      return fail('the target is not placed on exactly one node', 'backup.failed');
    const runId = id('bkr');
    const payload = buildPayload(schedule, runId, trigger, current.desired, node);
    if (payload.service && !payload.service.image)
      return fail('the service has no image on its node', 'backup.failed');
    const period = cronPeriodMs(schedule.schedule, at) ?? MAX_DEADLINE_MS * 2;
    const window =
      trigger === 'manual' || trigger === 'pre-restore'
        ? MANUAL_DEADLINE_MS
        : Math.min(period / 2, MAX_DEADLINE_MS);
    const commandId = deps.queueCommand(
      schedule.node_id,
      schedule.project_id,
      'backup.run',
      payload as unknown as Record<string, unknown>,
      new Date(at.getTime() + window).toISOString(),
    );
    const inserted = insertRun(schedule, trigger, scheduledFor, 'queued', {
      runId,
      commandId,
      actor,
      nodeId: schedule.node_id,
    });
    if (!inserted) {
      db.run("UPDATE commands SET state='cancelled' WHERE id=?", commandId);
      return { error: 'this slot already has a run' };
    }
    return { runId };
  }

  /** Marks a run's schedule row with its latest outcome. */
  function noteOutcome(run: BackupRunRow, status: string, at: string, success: boolean): void {
    if (!run.schedule_id) return;
    db.run(
      `UPDATE backup_schedules SET last_run_at=?,last_status=?${success ? ',last_success_at=?' : ''} WHERE id=?`,
      ...(success ? [at, status, at, run.schedule_id] : [at, status, run.schedule_id]),
    );
  }

  function tick(at: Date = clock()): void {
    sync(at);
    const iso = at.toISOString();

    // Commands the node never fetched before their deadline: the slot is missed, not silently dropped.
    for (const run of db.all<BackupRunRow & { deadline: string }>(
      `SELECT r.*, c.deadline FROM backup_runs r JOIN commands c ON c.id=r.command_id
       WHERE r.state='queued' AND c.state IN ('pending','expired') AND c.deadline IS NOT NULL AND c.deadline<?`,
      iso,
    )) {
      db.run("UPDATE commands SET state='expired',updated_at=? WHERE id=?", iso, run.command_id);
      db.run(
        "UPDATE backup_runs SET state='missed',finished_at=?,error=? WHERE id=?",
        iso,
        'node_offline',
        run.id,
      );
      noteOutcome(run, 'missed', iso, false);
      event(
        'error',
        'backup.missed',
        run.project_id,
        `backup of ${run.target} missed: node ${nodeName(run.node_id) ?? ''} did not pick it up before its deadline`,
        {
          runId: run.id,
          target: run.target,
          reason: 'node_offline',
          lastSeenAt:
            db.get<{ last_seen_at: string }>(
              'SELECT last_seen_at FROM nodes WHERE id=?',
              run.node_id,
            )?.last_seen_at ?? null,
        },
        nodeName(run.node_id),
      );
    }

    // A job whose agent stopped reporting for ten minutes is lost.
    for (const run of db.all<BackupRunRow>("SELECT * FROM backup_runs WHERE state='running'")) {
      const last = heartbeats.get(run.command_id ?? '') ?? started;
      if (at.getTime() - last < AGENT_LOST_MS) continue;
      db.run(
        "UPDATE backup_runs SET state='failed',finished_at=?,error=? WHERE id=?",
        iso,
        'agent_lost',
        run.id,
      );
      db.run(
        "UPDATE commands SET state='failed',updated_at=? WHERE id=? AND state='running'",
        iso,
        run.command_id,
      );
      noteOutcome(run, 'failed', iso, false);
      event(
        'error',
        'backup.failed',
        run.project_id,
        `backup of ${run.target} failed: the agent stopped reporting`,
        {
          runId: run.id,
          target: run.target,
          reason: 'agent_lost',
        },
        nodeName(run.node_id),
      );
    }

    // Due slots. A slot long overdue (control was down) becomes one missed event and one catch-up run, never a burst.
    for (const schedule of db.all<BackupScheduleRow>(
      'SELECT * FROM backup_schedules WHERE enabled=1 AND next_run_at<=?',
      iso,
    )) {
      const jitterMs = schedule.jitter_seconds * 1000;
      const slot = new Date(schedule.next_run_at);
      if (slot.getTime() + jitterMs > at.getTime()) continue;
      const grace = Math.max(10 * MINUTE, jitterMs);
      const lateness = at.getTime() - (slot.getTime() + jitterMs);
      let next = nextCronRun(schedule.schedule, slot);
      let latest = slot;
      let missedSlots = 0;
      if (lateness > grace) {
        // Find the most recent slot that is not in the future; every earlier one is part of the gap.
        for (let i = 0; next && next.getTime() <= at.getTime() && i < MAX_CATCH_UP_SLOTS; i++) {
          latest = next;
          missedSlots++;
          next = nextCronRun(schedule.schedule, next);
        }
        const runId = insertRun(schedule, 'schedule', latest.toISOString(), 'missed', {
          error: 'control_down',
        });
        if (runId)
          event(
            'error',
            'backup.missed',
            schedule.project_id,
            `backup of ${schedule.target} missed ${missedSlots + 1} scheduled run${missedSlots ? 's' : ''} while control was not running`,
            {
              runId,
              target: schedule.target,
              reason: 'control_down',
              gapMinutes: Math.round((at.getTime() - slot.getTime()) / MINUTE),
            },
            nodeName(schedule.node_id),
          );
        noteOutcome({ schedule_id: schedule.id } as BackupRunRow, 'missed', iso, false);
        queueRun(schedule, 'catch-up', null, at);
      } else {
        queueRun(schedule, 'schedule', slot.toISOString(), at);
      }
      db.run(
        'UPDATE backup_schedules SET next_run_at=? WHERE id=?',
        (next ?? new Date(at.getTime() + 24 * 3600_000)).toISOString(),
        schedule.id,
      );
    }

    // One automatic retry, ten minutes after a scheduled run failed.
    for (const run of db.all<BackupRunRow>(
      `SELECT r.* FROM backup_runs r WHERE r.state='failed' AND r.trigger IN ('schedule','catch-up') AND r.finished_at<=?
       AND NOT EXISTS (SELECT 1 FROM backup_runs x WHERE x.schedule_id=r.schedule_id AND x.trigger='retry' AND x.scheduled_for IS r.scheduled_for AND x.queued_at>=r.queued_at)`,
      new Date(at.getTime() - RETRY_DELAY_MS).toISOString(),
    )) {
      const schedule = run.schedule_id
        ? db.get<BackupScheduleRow>(
            'SELECT * FROM backup_schedules WHERE id=? AND enabled=1',
            run.schedule_id,
          )
        : undefined;
      if (schedule) queueRun(schedule, 'retry', run.scheduled_for, at);
    }

    // Independent of single runs: a target that has not succeeded for two periods is stale, even when each run failed alike.
    for (const schedule of db.all<BackupScheduleRow>(
      'SELECT * FROM backup_schedules WHERE enabled=1',
    )) {
      const period = cronPeriodMs(schedule.schedule, at);
      if (!period) continue;
      const since = new Date(schedule.last_success_at ?? schedule.created_at ?? iso).getTime();
      if (at.getTime() - since <= 2 * period + 10 * MINUTE) continue;
      if (
        schedule.stale_notified_at &&
        at.getTime() - new Date(schedule.stale_notified_at).getTime() < STALE_REPEAT_MS
      )
        continue;
      db.run('UPDATE backup_schedules SET stale_notified_at=? WHERE id=?', iso, schedule.id);
      event(
        'error',
        'backup.stale',
        schedule.project_id,
        `backup of ${schedule.target} has not succeeded since ${schedule.last_success_at ?? 'it was configured'}`,
        {
          target: schedule.target,
          lastSuccessAt: schedule.last_success_at,
        },
        nodeName(schedule.node_id),
      );
    }
  }

  /** Heartbeats from `StatusReport.jobs`: a queued run becomes running, and a running one stays alive. */
  function onHeartbeat(jobs: JobStatus[]): void {
    const at = clock().getTime();
    for (const job of jobs) {
      heartbeats.set(job.commandId, at);
      db.run(
        "UPDATE backup_runs SET state='running',started_at=COALESCE(started_at,?) WHERE command_id=? AND state='queued'",
        job.startedAt,
        job.commandId,
      );
    }
  }

  function onResult(commandId: string, state: string, result: CommandResultPayload): void {
    const run = db.get<BackupRunRow>('SELECT * FROM backup_runs WHERE command_id=?', commandId);
    if (!run || ['succeeded', 'failed', 'missed', 'cancelled'].includes(run.state)) return;
    const at = stamp();
    heartbeats.delete(commandId);
    if (state === 'succeeded') {
      const r = result as BackupJobResult;
      db.run(
        `UPDATE backup_runs SET state='succeeded',finished_at=?,snapshot_id=?,size_bytes=?,added_bytes=?,duration_ms=?,restic_version=?,metadata_json=? WHERE id=?`,
        at,
        r.snapshotId ?? null,
        r.totalBytes ?? null,
        r.addedBytes ?? null,
        r.durationMs ?? null,
        r.resticVersion ?? null,
        JSON.stringify({ warnings: r.warnings ?? [] }),
        run.id,
      );
      noteOutcome(run, 'succeeded', at, true);
      db.run('UPDATE backup_schedules SET stale_notified_at=NULL WHERE id=?', run.schedule_id);
      event(
        'info',
        'backup.completed',
        run.project_id,
        `backup of ${run.target} completed${r.snapshotId ? ` as snapshot ${r.snapshotId.slice(0, 8)}` : ''}`,
        {
          runId: run.id,
          target: run.target,
          snapshotId: r.snapshotId,
          addedBytes: r.addedBytes,
          totalBytes: r.totalBytes,
          durationMs: r.durationMs,
          warnings: r.warnings,
        },
        nodeName(run.node_id),
        run.actor ?? undefined,
      );
      return;
    }
    const error = redact((result as { error?: string }).error ?? 'the backup job failed').slice(
      0,
      2000,
    );
    db.run(
      "UPDATE backup_runs SET state='failed',finished_at=?,error=? WHERE id=?",
      at,
      error,
      run.id,
    );
    noteOutcome(run, 'failed', at, false);
    event(
      'error',
      'backup.failed',
      run.project_id,
      `backup of ${run.target} failed: ${error}`,
      {
        runId: run.id,
        target: run.target,
        error,
      },
      nodeName(run.node_id),
      run.actor ?? undefined,
    );
  }

  /** Queues manual backups of the named targets, or every target of the project when none are named. */
  function runNow(
    project: string,
    targets: string[] | undefined,
    actor: string,
    trigger: RunTrigger = 'manual',
  ): { runs: { runId: string; target: string }[]; errors: string[] } {
    sync();
    const schedules = db.all<BackupScheduleRow>(
      'SELECT * FROM backup_schedules WHERE project_id=? AND enabled=1 ORDER BY target',
      project,
    );
    const wanted = targets?.length
      ? targets.map((name) => (name.includes(':') ? name : undefined) ?? name)
      : schedules.map((row) => row.target);
    const runs: { runId: string; target: string }[] = [];
    const errors: string[] = [];
    for (const name of wanted) {
      const schedule =
        schedules.find((row) => row.target === name) ??
        schedules.find((row) => row.target.endsWith(`:${name}`));
      if (!schedule) {
        errors.push(`${name} is not a backup target of project ${project}`);
        continue;
      }
      const queued = queueRun(schedule, trigger, null, clock(), actor);
      if ('error' in queued) errors.push(`${schedule.target}: ${queued.error}`);
      else runs.push({ runId: queued.runId, target: schedule.target });
    }
    return { runs, errors };
  }

  function list(project: string, limit = 50): { targets: TargetStatus[]; runs: BackupRunRow[] } {
    const targets = db
      .all<BackupScheduleRow>(
        'SELECT * FROM backup_schedules WHERE project_id=? ORDER BY target',
        project,
      )
      .map((row) => ({
        project: row.project_id,
        target: row.target,
        node: nodeName(row.node_id),
        type: row.type,
        schedule: row.schedule,
        enabled: row.enabled === 1,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastSuccessAt: row.last_success_at,
        lastStatus: row.last_status,
      }));
    const runs = db.all<BackupRunRow>(
      'SELECT * FROM backup_runs WHERE project_id=? ORDER BY COALESCE(finished_at,queued_at) DESC LIMIT ?',
      project,
      limit,
    );
    return { targets, runs };
  }

  return { sync, tick, onHeartbeat, onResult, runNow, list };
}

export type BackupService = ReturnType<typeof createBackupService>;
