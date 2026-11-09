import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBackupJob, removeStaleJobContainers } from '../backup/job.ts';
import { JOB_CANCELLED } from '../protocol.ts';
import { redactSecrets } from '../backup/destination.ts';
import { errMessage } from '../errors.ts';
import { now } from '../db/row.ts';
import { ensureDir } from '../files.ts';
import type { DockerApi } from '../docker-api.ts';
import type {
  BackupCredentialsResponse,
  BackupJobPayload,
  Command,
  CommandResult,
  JobLane,
  JobPhase,
  JobStatus,
} from '../protocol.ts';

const RESULTS_FILE = 'job-results.json';

interface Persisted {
  /** Finished results not yet acknowledged by control. */
  results: CommandResult[];
  /** Commands that were running when the agent stopped. */
  running: string[];
}

export interface JobHost {
  docker: DockerApi;
  stateDir: string;
  fetchCredentials(commandId: string): Promise<BackupCredentialsResponse>;
  /** Parallel jobs on this node; extra jobs wait queued. */
  concurrency?: number;
}

interface Active extends JobStatus {
  controller: AbortController;
  project: string;
}

interface Queued {
  command: Command;
  payload: BackupJobPayload;
  lane: JobLane;
  queuedAt: string;
}

const LANE_ORDER: Record<JobLane, number> = { restore: 0, manual: 1, scheduled: 2 };

export function laneOf(command: Command, payload: BackupJobPayload): JobLane {
  if (command.type === 'backup.restore' || payload.tags?.includes('trigger:pre-restore'))
    return 'restore';
  return payload.tags?.includes('trigger:manual') ? 'manual' : 'scheduled';
}

/**
 * Jobs a node runs at once. Each restic helper reserves its own memory (512 MB by default), so a small host runs one
 * at a time; `TUG_BACKUP_CONCURRENCY` overrides this.
 */
export function defaultJobConcurrency(totalMemory = os.totalmem()): number {
  return totalMemory >= 3 * 1024 ** 3 ? 2 : 1;
}

/**
 * The agent's background jobs. Reconciliation must not wait for an hour-long backup, so commands of
 * these types are queued here, report a heartbeat through `statuses()`, and deliver their result
 * through `drain()` on a later poll, even if the agent restarted in between.
 */
export class JobRunner {
  private readonly host: JobHost;
  private readonly active = new Map<string, Active>();
  private readonly queue: Queued[] = [];
  private results: CommandResult[] = [];
  private ready: Promise<void> | undefined;
  private settled: (() => void) | undefined;

  constructor(host: JobHost) {
    this.host = host;
  }

  /** Called whenever a job finishes, so the agent can report its result without waiting a full interval. */
  onSettled(callback: () => void): void {
    this.settled = callback;
  }

  private file(): string {
    return path.join(this.host.stateDir, RESULTS_FILE);
  }

  private async save(): Promise<void> {
    const data: Persisted = {
      results: this.results,
      running: [...this.active.keys(), ...this.queue.map((job) => job.command.id)],
    };
    await ensureDir(this.host.stateDir);
    await fs.writeFile(this.file(), JSON.stringify(data), { mode: 0o600 });
  }

  /** First use: remove helpers of a previous run and fail the jobs it never finished. */
  private init(): Promise<void> {
    this.ready ??= (async () => {
      await removeStaleJobContainers(this.host.docker).catch(() => 0);
      try {
        const saved = JSON.parse(await fs.readFile(this.file(), 'utf8')) as Persisted;
        this.results = saved.results ?? [];
        for (const commandId of saved.running ?? [])
          this.results.push({
            commandId,
            state: 'failed',
            result: { error: 'the agent restarted while the job was running' },
          });
        if (saved.running?.length) await this.save();
      } catch {
        /* no saved state */
      }
    })();
    return this.ready;
  }

  /** Starts cleanup of a previous process's leftovers; safe to call more than once. */
  warm(): Promise<void> {
    return this.init();
  }

  /** Queues a job; the command is acknowledged immediately and its result arrives later. */
  async start(command: Command): Promise<void> {
    await this.init();
    let payload: BackupJobPayload;
    try {
      payload = JSON.parse(command.payload_json ?? '{}') as BackupJobPayload;
      if (!payload.runId || !payload.repository || !payload.resticImage)
        throw new Error('the job payload is incomplete');
    } catch (error) {
      this.results.push({
        commandId: command.id,
        state: 'failed',
        result: { error: errMessage(error) },
      });
      await this.save();
      return;
    }
    this.queue.push({
      command,
      payload,
      lane: laneOf(command, payload),
      queuedAt: now(),
    });
    await this.save();
    this.pump();
  }

  /**
   * Stops a job: a queued one never starts and an active one is aborted (its helper containers are removed). Either way
   * a failed result says it was cancelled. Returns whether the job was found.
   */
  async cancel(commandId: string, reason = JOB_CANCELLED): Promise<boolean> {
    await this.init();
    const queued = this.queue.findIndex((job) => job.command.id === commandId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.results.push({ commandId, state: 'failed', result: { error: reason } });
      await this.save();
      this.settled?.();
      return true;
    }
    const active = this.active.get(commandId);
    if (!active) return false;
    active.controller.abort(new Error(reason));
    return true;
  }

  /** The job a queued one waits for: one running for the same project (they share a repository), else the oldest. */
  private blockerOf(job: Queued): Active | undefined {
    const running = [...this.active.values()];
    return running.find((a) => a.project === job.payload.project) ?? running[0];
  }

  /**
   * Starts what can start: the best lane first, oldest first inside a lane, never two jobs of one project at once (they
   * contend for the project's repository lock) and never more than `concurrency` in all.
   */
  private pump(): void {
    const limit = this.host.concurrency ?? defaultJobConcurrency();
    while (this.active.size < limit) {
      const busy = new Set([...this.active.values()].map((a) => a.project));
      let best = -1;
      this.queue.forEach((job, index) => {
        if (busy.has(job.payload.project)) return;
        if (best < 0 || LANE_ORDER[job.lane] < LANE_ORDER[this.queue[best].lane]) best = index;
      });
      if (best < 0) return;
      const [job] = this.queue.splice(best, 1);
      void this.execute(job.command, job.payload, job.lane);
    }
  }

  private async execute(command: Command, payload: BackupJobPayload, lane: JobLane): Promise<void> {
    const controller = new AbortController();
    const status: Active = {
      commandId: command.id,
      runId: payload.runId,
      phase: 'pulling',
      startedAt: now(),
      lane,
      project: payload.project,
      controller,
    };
    this.active.set(command.id, status);
    const timeout = setTimeout(
      () => controller.abort(new Error(`the job exceeded its ${payload.limits.timeoutSec}s limit`)),
      payload.limits.timeoutSec * 1000,
    );
    timeout.unref();
    let credentials: BackupCredentialsResponse | undefined;
    try {
      credentials = await this.host.fetchCredentials(command.id);
      const result = await runBackupJob(
        payload,
        command.id,
        {
          docker: this.host.docker,
          credentials,
          signal: controller.signal,
          onPhase: (phase: JobPhase, bytes?: number) => {
            status.phase = phase;
            if (bytes !== undefined) status.bytes = bytes;
          },
        },
        command.type === 'backup.check'
          ? 'backup.check'
          : command.type === 'backup.restore'
            ? 'backup.restore'
            : 'backup.run',
      );
      this.results.push({ commandId: command.id, state: 'succeeded', result });
    } catch (error) {
      const values = credentials ? Object.values(credentials.env) : [];
      this.results.push({
        commandId: command.id,
        state: 'failed',
        result: { error: redactSecrets(errMessage(controller.signal.reason ?? error), values) },
      });
    } finally {
      clearTimeout(timeout);
      this.active.delete(command.id);
      await this.save().catch(() => {});
      this.settled?.();
      this.pump();
    }
  }

  /** Jobs that are running or waiting, for the status report's heartbeat. */
  statuses(): JobStatus[] {
    return [
      ...[...this.active.values()].map(
        ({ controller: _controller, project: _project, ...status }) => status,
      ),
      ...this.queue.map((job) => ({
        commandId: job.command.id,
        runId: job.payload.runId,
        phase: 'queued' as const,
        startedAt: job.queuedAt,
        lane: job.lane,
        ...(this.blockerOf(job) ? { waitingFor: this.blockerOf(job)!.runId } : {}),
      })),
    ];
  }

  /** Finished results to put in the next status report. They are removed only after `acknowledge`. */
  pending(): CommandResult[] {
    return [...this.results];
  }

  /** Forgets results control has stored. */
  async acknowledge(delivered: CommandResult[]): Promise<void> {
    const ids = new Set(delivered.map((result) => result.commandId));
    this.results = this.results.filter((result) => !ids.has(result.commandId));
    await this.save().catch(() => {});
  }
}
