import WebSocket from 'ws';
import { packageVersion } from '../images/image.ts';
import { clientTlsOptions } from '../pki.ts';
import type { Credential } from '../pki.ts';
import { CLIENT_VERSION_HEADER, LIVE_MAX_FRAME_BYTES, LIVE_START_TIMEOUT_MS } from '../protocol.ts';
import type { WatchChange, WatchEvent, WatchFrame } from '../protocol.ts';

export interface WatchClientOptions {
  credential: Credential;
  /** The connect target for the control API, as for every other request. */
  controlUrl: string;
  onFrame(frame: WatchFrame): void;
  /** True once control has said `watch.ready`, false when the socket is gone. */
  onState(connected: boolean): void;
  /** Substitutes the socket in tests. */
  createSocket?: (url: string, credential: Credential) => WebSocket;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const TOPICS = ['status', 'nodes', 'events', 'backups', 'restores'];

/** A frame from control, if it is one this client understands; anything else is dropped rather than trusted. */
export function parseWatchFrame(text: string): WatchFrame | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(frame) || frame.v !== 1) return undefined;
  if (frame.type === 'watch.ready')
    return Number.isSafeInteger(frame.cursor) && typeof frame.version === 'string'
      ? (frame as unknown as WatchFrame)
      : undefined;
  if (frame.type === 'watch.changed')
    return Array.isArray(frame.changes) &&
      frame.changes.every(
        (change): change is WatchChange =>
          isObject(change) &&
          TOPICS.includes(String(change.topic)) &&
          (change.project === undefined || typeof change.project === 'string'),
      )
      ? (frame as unknown as WatchFrame)
      : undefined;
  if (frame.type === 'watch.events')
    return Array.isArray(frame.events) &&
      frame.events.every(
        (event): event is WatchEvent =>
          isObject(event) && typeof event.id === 'string' && typeof event.created_at === 'string',
      ) &&
      Number.isSafeInteger(frame.cursor)
      ? (frame as unknown as WatchFrame)
      : undefined;
  if (frame.type === 'watch.resync' && typeof frame.reason === 'string')
    return frame as unknown as WatchFrame;
  return undefined;
}

/**
 * Keeps a `GET /api/v1/watch` socket open to control, reconnecting with backoff and jitter, and hands its frames to
 * `onFrame`. The channel only says that something changed, so a caller treats `ready` as "refetch everything" and its
 * own polling as the correctness backstop: losing the socket costs latency, never data.
 */
export class WatchClient {
  private readonly options: WatchClientOptions;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private failures = 0;

  constructor(options: WatchClientOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.on('error', () => {});
    socket?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(this.options.controlUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/watch`;
    let ready = false;
    let socket: WebSocket;
    try {
      socket = (this.options.createSocket ?? defaultSocket)(
        url.toString(),
        this.options.credential,
      );
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.on('message', (data, binary) => {
      if (binary || this.socket !== socket) return;
      const frame = parseWatchFrame(data.toString());
      if (!frame) return;
      if (frame.type === 'watch.ready') {
        ready = true;
        this.failures = 0;
        this.options.onState(true);
      }
      if (ready) this.options.onFrame(frame);
    });
    const lost = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (ready) this.options.onState(false);
      this.retry();
    };
    socket.on('close', lost);
    socket.on('error', () => {
      socket.terminate();
      lost();
    });
  }

  private retry(): void {
    if (this.stopped) return;
    const base = this.options.initialBackoffMs ?? 1000;
    const delay =
      Math.min(base * 2 ** this.failures, this.options.maxBackoffMs ?? 30_000) *
      (1 + Math.random() * 0.2);
    this.failures += 1;
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref?.();
  }
}

function defaultSocket(url: string, credential: Credential): WebSocket {
  return new WebSocket(url, {
    ...(clientTlsOptions(credential) as object),
    headers: { [CLIENT_VERSION_HEADER]: packageVersion() },
    followRedirects: false,
    maxPayload: LIVE_MAX_FRAME_BYTES,
    handshakeTimeout: LIVE_START_TIMEOUT_MS,
    perMessageDeflate: false,
  });
}
