import fs from 'node:fs/promises';
import path from 'node:path';
import { runBackupJob, removeStaleJobContainers } from './backup-job.ts';
import { redactSecrets } from './backup-destination.ts';
import { ensureDir, errMessage, now } from './util.ts';
import type { DockerApi } from './docker-api.ts';
import type {
  BackupCredentialsResponse,
  BackupJobPayload,
  Command,
  CommandResult,
  JobPhase,
  JobStatus,
} from './protocol.ts';

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
}

/**
 * The agent's background jobs. Reconciliation must not wait for an hour-long backup, so commands of
 * these types are queued here, report a heartbeat through `statuses()`, and deliver their result
 * through `drain()` on a later poll, even if the agent restarted in between.
 */
export class JobRunner {
  private readonly host: JobHost;
  private readonly active = new Map<string, Active>();
  private readonly queue: { command: Command; payload: BackupJobPayload }[] = [];
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
    this.queue.push({ command, payload });
    await this.save();
    this.pump();
  }

  private pump(): void {
    const limit = this.host.concurrency ?? 1;
    while (this.active.size < limit && this.queue.length) {
      const job = this.queue.shift()!;
      void this.execute(job.command, job.payload);
    }
  }

  private async execute(command: Command, payload: BackupJobPayload): Promise<void> {
    const controller = new AbortController();
    const status: Active = {
      commandId: command.id,
      runId: payload.runId,
      phase: 'pulling',
      startedAt: now(),
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
      ...[...this.active.values()].map(({ controller: _controller, ...status }) => status),
      ...this.queue.map(({ command, payload }) => ({
        commandId: command.id,
        runId: payload.runId,
        phase: 'queued' as const,
        startedAt: now(),
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
