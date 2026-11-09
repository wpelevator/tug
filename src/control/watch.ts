import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Db } from '../db/db.ts';
import { LIVE_MAX_BUFFERED_BYTES } from '../protocol.ts';
import type { WatchChange, WatchEvent, WatchFrame, WatchTopic } from '../protocol.ts';
import type { Actor } from './credentials.ts';

/** A node as the watch channel sees it: its derived status (never stored) and whether its stream socket is open. */
export interface WatchNode {
  id: string;
  name: string;
  status: string;
  connected: boolean;
}

export interface WatchOptions {
  db: Db;
  nodes(): WatchNode[];
  version: string;
  /** How often to look for changes nothing announced (deployment states, backups, restores, stale nodes). */
  tickMs?: number;
  /** Open watch sockets one credential may hold, and all together. */
  maxPerActor?: number;
  maxTotal?: number;
  pingMs?: number;
}

interface Subscriber {
  actor: Actor;
  ws: WebSocket;
  /** `seq` of the last event this subscriber was sent or skipped. */
  cursor: number;
  alive: boolean;
  ping?: NodeJS.Timeout;
}

/** Events pushed in one frame; more than this are sent in the following frames. */
const EVENT_BATCH = 100;
/** Changes that arrive together are sent together. */
const COALESCE_MS = 50;

const hash = (value: unknown): string =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');
const byProject = <T extends { project_id: string | null }>(rows: T[]): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.project_id ?? '';
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
};

/**
 * Tells operators something changed, as it happens, so a client need not poll to find out. It sends hints ("status of
 * `site` changed", "an event arrived") and new events, never state: the client refetches what a hint names, and the
 * HTTP API stays the truth. Hints come from two places. Handlers that already know call `mark` (an agent report that
 * changed a node's status). Everything else is found by `sweep`, which compares cheap fingerprints of the tables that
 * hold deployments, backups, restores, holds and derived node status, once a tick and after every request that
 * changed something. With no subscriber nothing runs.
 *
 * Every frame is filtered to what the credential may read, a slow subscriber is disconnected (it reconnects and
 * refetches), dead sockets are found by ping, and the channel is read-only.
 */
export class WatchHub {
  private readonly options: WatchOptions;
  private readonly subscribers = new Set<Subscriber>();
  private readonly pending = new Map<string, WatchChange>();
  private previous = new Map<string, string>();
  private tick?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;

  constructor(options: WatchOptions) {
    this.options = options;
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Whether another socket may open for `actor`: `actor` and `total` name the limit that is reached. */
  admits(actor: Actor): 'ok' | 'actor' | 'total' {
    if (this.subscribers.size >= (this.options.maxTotal ?? 200)) return 'total';
    let own = 0;
    for (const subscriber of this.subscribers) if (subscriber.actor.name === actor.name) own += 1;
    return own >= (this.options.maxPerActor ?? 8) ? 'actor' : 'ok';
  }

  /** Registers an authenticated socket and sends `watch.ready` with the current end of the event log. */
  subscribe(actor: Actor, ws: WebSocket): void {
    const subscriber: Subscriber = { actor, ws, cursor: this.lastSeq(), alive: true };
    if (!this.subscribers.size) {
      this.previous = this.fingerprints();
      this.tick = setInterval(
        () => this.sweep(),
        this.options.tickMs ?? Number(process.env.TUG_WATCH_TICK_MS || 1000),
      );
      this.tick.unref?.();
    }
    this.subscribers.add(subscriber);
    ws.on('error', () => {});
    // The channel is one-way: anything a client sends is a protocol error.
    ws.on('message', () => ws.close(1008, 'the watch channel is read-only'));
    ws.on('pong', () => {
      subscriber.alive = true;
    });
    subscriber.ping = setInterval(() => {
      if (!subscriber.alive) {
        ws.terminate();
        return;
      }
      subscriber.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, this.options.pingMs ?? 30_000);
    subscriber.ping.unref?.();
    ws.on('close', () => this.unsubscribe(subscriber));
    this.send(subscriber, {
      v: 1,
      type: 'watch.ready',
      cursor: this.visibleSeq(actor),
      version: this.options.version,
    });
  }

  private unsubscribe(subscriber: Subscriber): void {
    clearInterval(subscriber.ping);
    this.subscribers.delete(subscriber);
    if (!this.subscribers.size) {
      clearInterval(this.tick);
      clearTimeout(this.scheduled);
      this.tick = undefined;
      this.scheduled = undefined;
      this.pending.clear();
    }
  }

  /** Closes every socket, for shutdown. */
  closeAll(): void {
    for (const subscriber of [...this.subscribers])
      subscriber.ws.close(1001, 'control is shutting down');
  }

  private send(subscriber: Subscriber, frame: WatchFrame): boolean {
    const { ws } = subscriber;
    if (ws.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(frame);
    if (ws.bufferedAmount + Buffer.byteLength(data) > LIVE_MAX_BUFFERED_BYTES) {
      // It cannot keep up: let it reconnect and refetch rather than queue without bound.
      ws.close(1013, 'slow watch consumer; reconnect and refetch');
      return false;
    }
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private lastSeq(): number {
    return (
      this.options.db.get<{ seq: number | null }>('SELECT MAX(rowid) AS seq FROM events')?.seq ?? 0
    );
  }

  /** The newest event seq `actor` may read, which is what a scoped credential is told instead of the global end. */
  private visibleSeq(actor: Actor): number {
    if (!actor.projects) return this.lastSeq();
    if (!actor.projects.length) return 0;
    return (
      this.options.db.get<{ seq: number | null }>(
        `SELECT MAX(rowid) AS seq FROM events WHERE project_id IN (${actor.projects.map(() => '?').join(',')})`,
        ...actor.projects,
      )?.seq ?? 0
    );
  }

  /** Records a change a handler knows about and sends it shortly, together with others that arrive with it. */
  mark(topic: WatchTopic, project?: string): void {
    if (!this.subscribers.size) return;
    this.pending.set(`${topic}\0${project ?? ''}`, { topic, ...(project ? { project } : {}) });
    this.schedule();
  }

  /** Looks for changes nothing announced, soon: called after any request that wrote something. */
  poke(): void {
    if (!this.subscribers.size) return;
    this.schedule(true);
  }

  private schedule(sweep = false): void {
    if (this.scheduled) {
      if (sweep) this.sweepNext = true;
      return;
    }
    this.sweepNext = sweep;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      if (this.sweepNext) this.sweep();
      else this.flush();
    }, COALESCE_MS);
    this.scheduled.unref?.();
  }
  private sweepNext = false;

  private fingerprints(): Map<string, string> {
    const { db } = this.options;
    const out = new Map<string, string>();
    const statusRows = [
      ...db.all<{ project_id: string | null; id: string; state: string; updated_at: string }>(
        'SELECT project_id,id,state,updated_at FROM deployments ORDER BY created_at DESC LIMIT 100',
      ),
      ...db.all<{ project_id: string | null; id: string; current: string | null }>(
        'SELECT id AS project_id, id, current_deployment_id AS current FROM projects',
      ),
      ...db.all<{
        project_id: string | null;
        id: string;
        node_id: string;
        health: string;
        observed_version: string | null;
      }>('SELECT project_id,id,node_id,health,observed_version FROM node_statuses'),
    ];
    for (const [project, rows] of byProject(statusRows)) out.set(`status\0${project}`, hash(rows));
    out.set(`nodes\0`, hash(this.options.nodes()));
    const backupRows = [
      ...db.all<{ project_id: string | null; id: string; state: string }>(
        'SELECT project_id,id,state FROM backup_runs ORDER BY queued_at DESC LIMIT 200',
      ),
      ...db.all<{
        project_id: string | null;
        target: string;
        last_status: string | null;
        last_success_at: string | null;
        enabled: number;
      }>('SELECT project_id,target,last_status,last_success_at,enabled FROM backup_schedules'),
    ];
    for (const [project, rows] of byProject(backupRows)) out.set(`backups\0${project}`, hash(rows));
    const restoreRows = [
      ...db.all<{ project_id: string | null; id: string; state: string }>(
        'SELECT project_id,id,state FROM restore_runs ORDER BY started_at DESC LIMIT 100',
      ),
      ...db.all<{ project_id: string | null; service: string }>(
        'SELECT project_id,service FROM service_holds',
      ),
    ];
    for (const [project, rows] of byProject(restoreRows))
      out.set(`restores\0${project}`, hash(rows));
    return out;
  }

  /** Compares fingerprints with the last look, marks what differs, and sends. */
  sweep(): void {
    if (!this.subscribers.size) return;
    const next = this.fingerprints();
    const keys = new Set([...this.previous.keys(), ...next.keys()]);
    for (const key of keys) {
      if (this.previous.get(key) === next.get(key)) continue;
      const [topic, project] = key.split('\0');
      this.pending.set(key, { topic: topic as WatchTopic, ...(project ? { project } : {}) });
    }
    this.previous = next;
    this.flush();
  }

  /** Sends pending change hints, and any events past each subscriber's cursor, filtered per credential. */
  flush(): void {
    const changes = [...this.pending.values()];
    this.pending.clear();
    let more = false;
    for (const subscriber of [...this.subscribers]) {
      const visible = changes.filter(
        (change) =>
          !change.project ||
          !subscriber.actor.projects ||
          subscriber.actor.projects.includes(change.project),
      );
      if (visible.length) this.send(subscriber, { v: 1, type: 'watch.changed', changes: visible });
      more = this.pushEvents(subscriber) || more;
    }
    if (more) this.schedule();
  }

  /** Sends the subscriber's next batch of events; true when there are more after it. */
  private pushEvents(subscriber: Subscriber): boolean {
    const rows = this.options.db.all<WatchEvent>(
      'SELECT rowid AS seq,* FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?',
      subscriber.cursor,
      EVENT_BATCH,
    );
    if (!rows.length) return false;
    const { projects } = subscriber.actor;
    // Scoped credentials never see node-level or other projects' events, but their cursor still moves past them.
    const visible = projects
      ? rows.filter((row) => row.project_id !== null && projects.includes(row.project_id))
      : rows;
    const cursor = rows[rows.length - 1].seq;
    if (
      visible.length &&
      !this.send(subscriber, { v: 1, type: 'watch.events', events: visible, cursor })
    )
      return false;
    subscriber.cursor = cursor;
    return rows.length === EVENT_BATCH;
  }
}
