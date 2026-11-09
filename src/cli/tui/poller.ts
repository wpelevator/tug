import { errMessage } from '../../errors.ts';
import type { StatusResponse } from '../status.ts';
import type { Api } from './actions.ts';
import { listKey } from './tables.ts';
import type {
  BackupListing,
  Diagnostics,
  EventRow,
  Feed,
  NodeRow,
  RestoreRow,
  Snapshot,
  ViewRef,
  Who,
} from './types.ts';

export interface Intervals {
  status: number;
  events: number;
  /** Backups, restores, nodes and diagnostics: slower facts. */
  slow: number;
  diagnostics: number;
  lists: number;
}
export const DEFAULT_INTERVALS: Intervals = {
  status: 3000,
  events: 5000,
  slow: 30_000,
  diagnostics: 60_000,
  lists: 15_000,
};
const MAX_BACKOFF = 8;
const LIST_VIEWS = new Set(['domains', 'volumes', 'secrets', 'credentials']);

type FeedName =
  'whoami' | 'version' | 'status' | 'events' | 'nodes' | 'backups' | 'restores' | 'diagnostics';

/**
 * Keeps a `Snapshot` fresh by polling the control API: `status` quickly (it is the only fast feed), events a little
 * slower, backups and restores and the admin-only nodes and diagnostics slowest. Every feed fails on its own: a
 * failure keeps the last data and records the error beside it, and repeated failures back off. A 403 turns an
 * admin-only feed off for good, since the credential will not gain a role while the screen is open.
 */
export class Poller {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<string, number>();
  private readonly denied = new Set<FeedName>();
  private readonly inflight = new Map<string, Promise<void>>();
  private stopped = true;
  private whoamiDone = false;

  private readonly api: Api;
  readonly snapshot: Snapshot;
  private readonly onChange: () => void;
  private readonly intervals: Intervals;

  constructor(
    api: Api,
    snapshot: Snapshot,
    onChange: () => void,
    intervals: Intervals = DEFAULT_INTERVALS,
  ) {
    this.api = api;
    this.snapshot = snapshot;
    this.onChange = onChange;
    this.intervals = intervals;
  }

  /** Starts every feed's loop; the first pass runs at once. */
  start(): void {
    this.stopped = false;
    // Status and events need nothing else. The rest may depend on the role, so they start once `whoami` has answered.
    for (const name of ['status', 'events'] as const)
      void this.loop(name, () => this.fetch(name), this.every(name));
    void this.identify().then(() => {
      if (this.stopped) return;
      for (const name of ['backups', 'restores', 'nodes', 'diagnostics'] as const)
        void this.loop(name, () => this.fetch(name), this.every(name));
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private every(name: FeedName): number {
    return name === 'status'
      ? this.intervals.status
      : name === 'events'
        ? this.intervals.events
        : name === 'diagnostics'
          ? this.intervals.diagnostics
          : this.intervals.slow;
  }

  private async loop(name: string, run: () => Promise<void>, every: number): Promise<void> {
    if (this.stopped) return;
    await this.guarded(name, run);
    if (this.stopped) return;
    const backoff = 2 ** Math.min(this.failures.get(name) ?? 0, Math.log2(MAX_BACKOFF));
    const jitter = 1 + Math.random() * 0.1;
    const timer = setTimeout(() => void this.loop(name, run, every), every * backoff * jitter);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  /** At most one request in flight per feed. */
  private guarded(name: string, run: () => Promise<void>): Promise<void> {
    const running = this.inflight.get(name);
    if (running) return running;
    const promise = run()
      .then(
        () => this.failures.delete(name),
        () => this.failures.set(name, (this.failures.get(name) ?? 0) + 1),
      )
      .then(() => undefined)
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, promise);
    return promise;
  }

  /** Who this credential is and which control version answers; both are asked once. */
  private async identify(): Promise<void> {
    const [who, version] = await Promise.allSettled([
      this.api.request<Who>('GET', '/api/v1/whoami'),
      this.api.request<{ v: string }>('GET', '/api/v1/version'),
    ]);
    if (who.status === 'fulfilled')
      this.snapshot.whoami = { data: who.value, fetchedAt: Date.now() };
    else this.snapshot.whoami = { error: errMessage(who.reason) };
    if (version.status === 'fulfilled')
      this.snapshot.version = { data: version.value.v, fetchedAt: Date.now() };
    this.whoamiDone = true;
    this.onChange();
  }

  private mayUse(name: FeedName): boolean {
    if (this.denied.has(name)) return false;
    if (name !== 'nodes' && name !== 'diagnostics') return true;
    const role = this.snapshot.whoami.data?.role;
    // Before whoami answers, or on a control without it, try once and let a 403 decide.
    return role === 'admin' || (role === undefined && this.whoamiDone);
  }

  private async record<T>(
    name: FeedName,
    feed: () => Feed<T>,
    set: (next: Feed<T>) => void,
    load: () => Promise<T>,
  ): Promise<void> {
    try {
      set({ data: await load(), fetchedAt: Date.now() });
    } catch (error) {
      const message = errMessage(error);
      if (/\b403\b/.test(message) && (name === 'nodes' || name === 'diagnostics'))
        this.denied.add(name);
      set({ ...feed(), error: message });
      throw error;
    } finally {
      this.onChange();
    }
  }

  private projects(): string[] {
    return (this.snapshot.status.data?.projects ?? []).map((project) => project.id);
  }

  /** Fetches one feed once. A feed the credential may not use is skipped, not failed. */
  async fetch(name: FeedName): Promise<void> {
    const s = this.snapshot;
    if (!this.mayUse(name)) return;
    switch (name) {
      case 'status':
        return this.record(
          'status',
          () => s.status,
          (next) => (s.status = next),
          () => this.api.request<StatusResponse>('GET', '/api/v1/status'),
        );
      case 'events':
        return this.record(
          'events',
          () => s.events,
          (next) => (s.events = next),
          async () =>
            (await this.api.request<{ events: EventRow[] }>('GET', '/api/v1/events?limit=100'))
              .events,
        );
      case 'nodes':
        return this.record(
          'nodes',
          () => s.nodes,
          (next) => (s.nodes = next),
          async () => (await this.api.request<{ nodes: NodeRow[] }>('GET', '/api/v1/nodes')).nodes,
        );
      case 'diagnostics':
        return this.record(
          'diagnostics',
          () => s.diagnostics,
          (next) => (s.diagnostics = next),
          () => this.api.request<Diagnostics>('GET', '/api/v1/diagnostics'),
        );
      case 'backups':
        return this.record(
          'backups',
          () => s.backups,
          (next) => (s.backups = next),
          async () => {
            const entries = await Promise.all(
              this.projects().map(
                async (project) =>
                  [
                    project,
                    await this.api.request<BackupListing>(
                      'GET',
                      `/api/v1/backups?project=${encodeURIComponent(project)}&limit=20`,
                    ),
                  ] as const,
              ),
            );
            return Object.fromEntries(entries);
          },
        );
      case 'restores':
        return this.record(
          'restores',
          () => s.restores,
          (next) => (s.restores = next),
          async () => {
            const entries = await Promise.all(
              this.projects().map(
                async (project) =>
                  [
                    project,
                    (
                      await this.api.request<{ restores: RestoreRow[] }>(
                        'GET',
                        `/api/v1/restores?project=${encodeURIComponent(project)}`,
                      )
                    ).restores,
                  ] as const,
              ),
            );
            return Object.fromEntries(entries);
          },
        );
      default:
        return;
    }
  }

  /** One pass over every feed, for `--once` and tests. Rejects only when `status` itself fails. */
  async pollOnce(): Promise<void> {
    await this.identify();
    await this.guarded('status', () => this.fetch('status'));
    if (this.snapshot.status.error !== undefined && !this.snapshot.status.data)
      throw new Error(this.snapshot.status.error);
    await Promise.all(
      (['events', 'backups', 'restores', 'nodes', 'diagnostics'] as FeedName[]).map((name) =>
        this.guarded(name, () => this.fetch(name)),
      ),
    );
  }

  /** Polls everything now, for ctrl-r. */
  async refresh(): Promise<void> {
    await Promise.all(
      (['status', 'events', 'backups', 'restores', 'nodes', 'diagnostics'] as FeedName[]).map(
        (name) => this.guarded(name, () => this.fetch(name)),
      ),
    );
  }

  /** Loads one of the on-demand lists, and keeps it fresh while the screen stays open. */
  async load(view: ViewRef): Promise<void> {
    if (!LIST_VIEWS.has(view.name)) return;
    const project = view.project ?? '';
    const key = listKey(view.name, project);
    const route =
      view.name === 'credentials'
        ? '/api/v1/credentials'
        : `/api/v1/${view.name}?project=${encodeURIComponent(project)}`;
    const run = async () => {
      try {
        const body = await this.api.request<Record<string, Record<string, unknown>[]>>(
          'GET',
          route,
        );
        this.snapshot.lists[key] = { data: body[view.name] ?? [], fetchedAt: Date.now() };
      } catch (error) {
        this.snapshot.lists[key] = { ...this.snapshot.lists[key], error: errMessage(error) };
        throw error;
      } finally {
        this.onChange();
      }
    };
    await this.guarded(`list:${key}`, run);
    if (!this.stopped && !this.timers.has(`list:${key}`))
      this.timers.set(
        `list:${key}`,
        setTimeout(() => {
          this.timers.delete(`list:${key}`);
          void this.load(view);
        }, this.intervals.lists),
      );
  }
}
