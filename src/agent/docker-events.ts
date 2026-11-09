import { errMessage } from '../errors.ts';
import type { DockerApi, DockerEvent } from '../docker-api.ts';
import { LABEL_JOB, LABEL_PROJECT, LABEL_SERVICE } from '../container-spec.ts';

/** What the daemon told us went wrong with one managed container. */
export interface ContainerFailure {
  kind: 'exited' | 'oom' | 'unhealthy';
  project: string;
  service: string;
  container: string;
  exitCode?: number;
  /** Seconds since the epoch, from the daemon. */
  at: number;
}

/** Exit codes of a container that was stopped on purpose: clean exit, SIGTERM and SIGKILL (a `docker stop` that timed out). */
const STOPPED_EXIT_CODES = new Set([0, 137, 143]);
/** How long after an `oom` event a `die` of the same container is still its consequence. */
const OOM_WINDOW_SECONDS = 10;

/** The filters that keep the stream to managed containers and the three events worth reading. */
export const EVENT_FILTERS = {
  type: ['container'],
  event: ['die', 'oom', 'health_status'],
  label: [LABEL_PROJECT],
};

/**
 * Turns a daemon event into a failure, or nothing. Only containers Tug manages for a service count (one-off job
 * containers are expected to exit), and a `die` with the exit code of a deliberate stop is not a failure: the agent
 * itself stops the previous revision during a rollout. A kill by the out-of-memory killer is reported once, as `oom`,
 * and its following `die` is dropped through `recentOom`.
 */
export function classifyEvent(
  event: DockerEvent,
  recentOom: Map<string, number> = new Map(),
): ContainerFailure | undefined {
  if (event.Type !== 'container') return undefined;
  const labels = event.Actor?.Attributes ?? {};
  const project = labels[LABEL_PROJECT];
  const service = labels[LABEL_SERVICE];
  if (!project || !service || labels[LABEL_JOB]) return undefined;
  const container = labels.name ?? event.Actor.ID.slice(0, 12);
  const base = { project, service, container, at: event.time };
  const action = event.Action;
  if (action === 'oom') {
    recentOom.set(event.Actor.ID, event.time);
    return { ...base, kind: 'oom' };
  }
  if (action.startsWith('health_status')) {
    return action.includes('unhealthy') ? { ...base, kind: 'unhealthy' } : undefined;
  }
  if (action !== 'die') return undefined;
  const oomAt = recentOom.get(event.Actor.ID);
  if (oomAt !== undefined && event.time - oomAt <= OOM_WINDOW_SECONDS) return undefined;
  const exitCode = Number(labels.exitCode);
  if (!Number.isInteger(exitCode) || STOPPED_EXIT_CODES.has(exitCode)) return undefined;
  return { ...base, kind: 'exited', exitCode };
}

/** An event to send to control, in the shape of `POST /agent/v1/events`. */
export interface ReportedEvent {
  projectId: string;
  level: 'warn' | 'error';
  type: 'container.exited' | 'container.crashloop' | 'container.oom' | 'container.unhealthy';
  message: string;
  metadata: Record<string, unknown>;
}

/** Repeats of the same event type for one service within this window are not reported again. */
export const REPEAT_QUIET_MS = 60_000;
/** This many crashes within the window make a crash loop. */
export const CRASHLOOP_COUNT = 3;
export const CRASHLOOP_WINDOW_MS = 5 * 60_000;
/** A crash loop is announced again only after the service has been quiet this long. */
export const CRASHLOOP_RESET_MS = 15 * 60_000;

/**
 * Decides what to tell control, so one failing service cannot flood the event log: at most one event per type per
 * service a minute, and a repeated crash becomes a single `container.crashloop` event until the service has been quiet.
 */
export class FailureReporter {
  private readonly lastReport = new Map<string, number>();
  private readonly crashes = new Map<string, number[]>();
  private readonly loopReported = new Map<string, number>();
  private readonly nodeName: string;

  constructor(nodeName: string) {
    this.nodeName = nodeName;
  }

  /** The event to send for this failure at `now` (milliseconds), or undefined when it is a repeat. */
  report(failure: ContainerFailure, now: number): ReportedEvent | undefined {
    const key = `${failure.project}\0${failure.service}`;
    const metadata = {
      service: failure.service,
      container: failure.container,
      node: this.nodeName,
      ...(failure.exitCode !== undefined && { exitCode: failure.exitCode }),
    };
    const quiet = (type: string): boolean => {
      const last = this.lastReport.get(`${key}\0${type}`);
      return last !== undefined && now - last < REPEAT_QUIET_MS;
    };
    const sent = (type: string): void => void this.lastReport.set(`${key}\0${type}`, now);
    if (failure.kind === 'oom') {
      if (quiet('oom')) return undefined;
      sent('oom');
      return {
        projectId: failure.project,
        level: 'error',
        type: 'container.oom',
        message: `${failure.service} on ${this.nodeName} was killed for running out of memory`,
        metadata,
      };
    }
    if (failure.kind === 'unhealthy') {
      if (quiet('unhealthy')) return undefined;
      sent('unhealthy');
      return {
        projectId: failure.project,
        level: 'warn',
        type: 'container.unhealthy',
        message: `${failure.service} on ${this.nodeName} reports unhealthy`,
        metadata,
      };
    }
    const history = [...(this.crashes.get(key) ?? []), now].filter(
      (at) => now - at <= CRASHLOOP_WINDOW_MS,
    );
    this.crashes.set(key, history);
    const loopAt = this.loopReported.get(key);
    if (history.length >= CRASHLOOP_COUNT) {
      if (loopAt !== undefined && now - loopAt < CRASHLOOP_RESET_MS) {
        this.loopReported.set(key, now);
        return undefined;
      }
      this.loopReported.set(key, now);
      return {
        projectId: failure.project,
        level: 'error',
        type: 'container.crashloop',
        message: `${failure.service} on ${this.nodeName} crashed ${history.length} times in ${Math.round(CRASHLOOP_WINDOW_MS / 60_000)} minutes (last exit code ${failure.exitCode})`,
        metadata: { ...metadata, crashes: history.length },
      };
    }
    // Inside a known loop the single crash loop event stands for every crash.
    if (loopAt !== undefined && now - loopAt < CRASHLOOP_RESET_MS) {
      this.loopReported.set(key, now);
      return undefined;
    }
    if (quiet('exited')) return undefined;
    sent('exited');
    return {
      projectId: failure.project,
      level: 'warn',
      type: 'container.exited',
      message: `${failure.service} on ${this.nodeName} exited with code ${failure.exitCode}`,
      metadata,
    };
  }
}

export interface WatcherOptions {
  docker: DockerApi;
  nodeName: string;
  /** Sends an event to control. Failures are the sender's to handle; the watcher never waits on them. */
  post: (event: ReportedEvent) => void | Promise<void>;
  /** Asks the agent to reconcile now: something it manages just failed. */
  wake: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** Events of the second a stream resumes from are replayed by the daemon; this many recent ones are remembered to skip repeats. */
const SEEN_LIMIT = 200;
/** Wakes are at most this often, so a crash loop cannot turn into a reconcile loop. */
const WAKE_MIN_INTERVAL_MS = 1000;

/**
 * Follows the daemon's event stream for managed containers, so a crashed or killed container is seen within a second
 * instead of at the next poll, and so crash loops (which a health check alone never notices) become events. The
 * stream resumes from the last event after a dropped connection or a daemon restart, with backoff.
 */
export class DockerEventWatcher {
  private readonly options: WatcherOptions;
  private readonly reporter: FailureReporter;
  private readonly recentOom = new Map<string, number>();
  private readonly seen: string[] = [];
  private controller?: AbortController;
  private lastWake = 0;
  private done?: Promise<void>;

  constructor(options: WatcherOptions) {
    this.options = options;
    this.reporter = new FailureReporter(options.nodeName);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.done = this.run(this.controller.signal);
  }

  /** Stops following and waits for the loop to end. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.done;
    this.controller = undefined;
    this.done = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const sleep =
      this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let since = Math.floor(this.now() / 1000);
    let backoff = INITIAL_BACKOFF_MS;
    while (!signal.aborted) {
      try {
        for await (const event of this.options.docker.events({
          since,
          filters: EVENT_FILTERS,
          signal,
        })) {
          backoff = INITIAL_BACKOFF_MS;
          since = Math.max(since, event.time);
          this.handle(event);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.options.log?.(`docker event stream failed: ${errMessage(error)}; retrying`);
      }
      if (signal.aborted) return;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** Handles one event; exposed so tests can drive it without a stream. */
  handle(event: DockerEvent): void {
    const id = `${event.timeNano ?? event.time}:${event.Actor?.ID}:${event.Action}`;
    if (this.seen.includes(id)) return;
    this.seen.push(id);
    if (this.seen.length > SEEN_LIMIT) this.seen.shift();
    const failure = classifyEvent(event, this.recentOom);
    if (!failure) return;
    const now = this.now();
    const reported = this.reporter.report(failure, now);
    if (reported)
      void Promise.resolve(this.options.post(reported)).catch((error) =>
        this.options.log?.(`could not report ${reported.type}: ${errMessage(error)}`),
      );
    if (now - this.lastWake >= WAKE_MIN_INTERVAL_MS) {
      this.lastWake = now;
      this.options.wake();
    }
  }
}
