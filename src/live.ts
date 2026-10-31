import { EventEmitter } from 'node:events';
import { LIVE_MAX_FRAME_BYTES } from './protocol.ts';
import type { DockerApi } from './docker-api.ts';
import type { Readable, Writable } from 'node:stream';

export interface LiveProcess extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  /** PTY adapters implement this in terminal columns and rows. */
  resize?(columns: number, rows: number): void;
}
export type LiveRequest =
  | {
      operation: 'exec';
      sessionId: string;
      container: string;
      command: string[];
      interactive?: boolean;
      tty?: boolean;
      columns?: number;
      rows?: number;
    }
  | { operation: 'logs'; sessionId: string; container: string; tail?: number; timestamps?: boolean }
  | { operation: 'ps'; sessionId: string; projects: string[] }
  | { operation: 'inspect'; sessionId: string; container: string };
export type LiveEvent =
  | {
      sessionId: string;
      type: 'output';
      stream: 'stdout' | 'stderr';
      data: string;
      encoding: 'base64';
    }
  | { sessionId: string; type: 'result'; result: Record<string, unknown>[] }
  | {
      sessionId: string;
      type: 'exit';
      code: number | null;
      signal: string | null;
      cancelled: boolean;
      error?: string;
    };
export interface LiveEngineOptions {
  emit: (event: LiveEvent) => void;
  /** The Engine API: exec (with a real PTY), logs, `ps` and `inspect` all go through it. */
  docker: DockerApi;
  maxSessions?: number;
  maxSessionMs?: number;
  queryTimeoutMs?: number;
}
interface Session {
  request: LiveRequest;
  /** Absent for `ps` and `inspect`, which are single API calls. */
  child?: LiveProcess;
  timer: ReturnType<typeof setTimeout>;
  cleanup: (awaitClose?: boolean) => void;
  /** Releases a query that is still waiting on the Engine when the session is closed early. */
  abort?: () => void;
}
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function dimension(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 1000;
}
function validate(value: unknown): asserts value is LiveRequest {
  if (!object(value) || typeof value.sessionId !== 'string' || !identifier.test(value.sessionId))
    throw new Error('Invalid live session ID');
  if (!['exec', 'logs', 'ps', 'inspect'].includes(String(value.operation)))
    throw new Error('Invalid live operation');
  if (
    value.operation !== 'ps' &&
    (typeof value.container !== 'string' || !identifier.test(value.container))
  )
    throw new Error('Invalid container');
  if (value.operation === 'exec') {
    if (
      !Array.isArray(value.command) ||
      value.command.length < 1 ||
      value.command.length > 256 ||
      !value.command.every(
        (arg) => typeof arg === 'string' && !arg.includes('\0') && Buffer.byteLength(arg) <= 32768,
      ) ||
      value.command[0].length === 0
    )
      throw new Error('Invalid exec command');
    if (value.interactive !== undefined && typeof value.interactive !== 'boolean')
      throw new Error('Invalid interactive flag');
    if (value.tty !== undefined && typeof value.tty !== 'boolean')
      throw new Error('Invalid TTY flag');
    if (
      (value.columns !== undefined && !dimension(value.columns)) ||
      (value.rows !== undefined && !dimension(value.rows))
    )
      throw new Error('Invalid terminal dimensions');
  }
  if (value.operation === 'logs') {
    if (
      value.tail !== undefined &&
      (!Number.isInteger(value.tail) || Number(value.tail) < 0 || Number(value.tail) > 10000)
    )
      throw new Error('Invalid log tail');
    if (value.timestamps !== undefined && typeof value.timestamps !== 'boolean')
      throw new Error('Invalid timestamps flag');
  }
  if (
    value.operation === 'ps' &&
    (!Array.isArray(value.projects) ||
      value.projects.length < 1 ||
      value.projects.length > 256 ||
      !value.projects.every((project) => typeof project === 'string' && identifier.test(project)))
  )
    throw new Error('Invalid projects');
}
/** Owns Engine API streams and their lifetimes; callers own authentication, authorization and transport backpressure. */
export class LiveOperationEngine {
  private readonly options: LiveEngineOptions;
  private readonly sessions = new Map<string, Session>();
  /** Sessions whose container stream is still being opened; a cancel marks them so they close on arrival. */
  private readonly starting = new Map<string, { cancelled: boolean }>();
  constructor(options: LiveEngineOptions) {
    for (const key of ['maxSessions', 'maxSessionMs', 'queryTimeoutMs'] as const) {
      if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! < 1))
        throw new Error(`Invalid ${key}`);
    }
    this.options = options;
  }
  get activeSessions(): number {
    return this.sessions.size + this.starting.size;
  }
  async start(value: unknown): Promise<void> {
    validate(value);
    if (this.sessions.has(value.sessionId) || this.starting.has(value.sessionId))
      throw new Error('Duplicate live session ID');
    if (this.activeSessions >= (this.options.maxSessions ?? 16))
      throw new Error('Live session limit reached');
    const request = structuredClone(value);
    const id = request.sessionId;
    const pending = { cancelled: false };
    this.starting.set(id, pending);
    const query = request.operation === 'ps' || request.operation === 'inspect';
    const timer = setTimeout(
      () => this.finish(id, null, null, false, 'Live operation timed out', true),
      query ? (this.options.queryTimeoutMs ?? 30000) : (this.options.maxSessionMs ?? 3600000),
    );
    timer.unref();
    let child: LiveProcess | undefined;
    try {
      if (query) {
        this.starting.delete(id);
        await this.query(request, timer);
        return;
      }
      child = await this.open(request);
    } catch (error) {
      clearTimeout(timer);
      this.starting.delete(id);
      throw error;
    }
    this.starting.delete(id);
    if (pending.cancelled) {
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* Already gone. */
      }
      this.options.emit({ sessionId: id, type: 'exit', code: null, signal: null, cancelled: true });
      return;
    }
    const live = child;
    const onError = (error: Error) => {
      if (this.sessions.get(id)?.child === live)
        this.finish(id, null, null, false, error.message, true);
    };
    const stopErrors = () => {
      live.off('error', onError).off('close', onClose);
      live.stdin?.off('error', onError);
    };
    const onClose = (code: number | null, signal: string | null) => {
      stopErrors();
      if (this.sessions.get(id)?.child === live) this.finish(id, code, signal, false);
    };
    const stdout = (data: Buffer | string) => this.output(id, 'stdout', data);
    const stderr = (data: Buffer | string) => this.output(id, 'stderr', data);
    this.sessions.set(id, {
      request,
      child: live,
      timer,
      cleanup: (awaitClose = false) => {
        clearTimeout(timer);
        if (!awaitClose) stopErrors();
        live.stdout?.off('data', stdout);
        live.stderr?.off('data', stderr);
      },
    });
    live.on('error', onError).on('close', onClose);
    live.stdout?.on('data', stdout);
    live.stderr?.on('data', stderr);
    live.stdin?.on('error', onError);
    if (request.operation === 'exec' && request.interactive === false) live.stdin?.end();
  }
  /** `ps` and `inspect` are one Engine API call whose JSON result is the whole session. */
  private async query(
    request: Extract<LiveRequest, { operation: 'ps' | 'inspect' }>,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    const id = request.sessionId;
    const session: Session = { request, timer, cleanup: () => clearTimeout(timer) };
    const aborted = new Promise<void>((resolve) => {
      session.abort = resolve;
    });
    this.sessions.set(id, session);
    let error: string | undefined;
    let result: Record<string, unknown>[] | undefined;
    let settled = false;
    const work = (async () => {
      try {
        if (request.operation === 'ps') {
          const lists = await Promise.all(
            [...new Set(request.projects)].map((project) =>
              this.options.docker.listContainers({ label: [`tug.project=${project}`] }),
            ),
          );
          result = lists.flat() as unknown as Record<string, unknown>[];
        } else result = [await this.options.docker.inspectContainer(request.container)];
        const frame = { v: 1, type: 'live.result', sessionId: id, result };
        if (Buffer.byteLength(JSON.stringify(frame)) > LIVE_MAX_FRAME_BYTES)
          throw new Error('Live result exceeds serialized frame size limit');
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      settled = true;
    })();
    await Promise.race([work, aborted]);
    // A cancel or timeout already closed the session while the call was in flight.
    if (!settled || !this.sessions.has(id)) return;
    clearTimeout(timer);
    this.sessions.delete(id);
    if (result && !error) this.options.emit({ sessionId: id, type: 'result', result });
    this.options.emit({
      sessionId: id,
      type: 'exit',
      code: error ? 1 : 0,
      signal: null,
      cancelled: false,
      ...(error ? { error: error.slice(0, 4096) } : {}),
    });
  }
  private async open(
    request: Exclude<LiveRequest, { operation: 'ps' | 'inspect' }>,
  ): Promise<LiveProcess> {
    const { docker } = this.options;
    if (request.operation === 'logs')
      return docker.logs(request.container, {
        follow: true,
        tail: request.tail ?? 100,
        timestamps: request.timestamps,
      });
    const proc = await docker.execStart(request.container, {
      cmd: request.command,
      stdin: request.interactive !== false,
      tty: Boolean(request.tty),
      columns: request.columns,
      rows: request.rows,
    });
    return proc;
  }
  /** Returns the writable backpressure signal; callers must pause transport input on false. */
  stdin(sessionId: string, data: Uint8Array): boolean {
    const session = this.requireExec(sessionId);
    if (!(data instanceof Uint8Array) || data.byteLength > 65536)
      throw new Error('Invalid stdin frame');
    const stdin = session.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded)
      throw new Error('Session stdin is closed');
    if (stdin.writableLength + data.byteLength > 262144)
      throw new Error('Live stdin queue exceeds size limit');
    return stdin.write(data);
  }
  endStdin(sessionId: string): void {
    this.requireExec(sessionId).child?.stdin?.end();
  }
  resize(sessionId: string, columns: number, rows: number): void {
    const session = this.requireExec(sessionId);
    if (!dimension(columns) || !dimension(rows)) throw new Error('Invalid terminal dimensions');
    if (!session.request.tty || !session.child?.resize) throw new Error('Session has no terminal');
    session.child.resize(columns, rows);
  }
  cancel(sessionId: string): void {
    const pending = this.starting.get(sessionId);
    if (pending) pending.cancelled = true;
    this.finish(sessionId, null, null, true, undefined, true);
  }
  dispose(): void {
    for (const id of [...this.sessions.keys(), ...this.starting.keys()]) this.cancel(id);
  }
  private requireExec(
    sessionId: string,
  ): Session & { request: Extract<LiveRequest, { operation: 'exec' }> } {
    const session = this.sessions.get(sessionId);
    if (!session || session.request.operation !== 'exec') throw new Error('Unknown exec session');
    return session as Session & { request: Extract<LiveRequest, { operation: 'exec' }> };
  }
  private output(id: string, stream: 'stdout' | 'stderr', data: Buffer | string): void {
    if (!this.sessions.has(id)) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (let offset = 0; offset < bytes.length && this.sessions.has(id); offset += 65536)
      this.options.emit({
        sessionId: id,
        type: 'output',
        stream,
        data: bytes.subarray(offset, offset + 65536).toString('base64'),
        encoding: 'base64',
      });
  }
  private finish(
    id: string,
    code: number | null,
    signal: string | null,
    cancelled: boolean,
    error?: string,
    kill = false,
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.abort?.();
    // Keep error handlers until close when killing: errors can arrive after cancellation.
    session.cleanup(kill);
    if (kill && session.child) {
      try {
        session.child.kill('SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    this.options.emit({
      sessionId: id,
      type: 'exit',
      code,
      signal,
      cancelled,
      ...(error ? { error: error.slice(0, 4096) } : {}),
    });
  }
}
