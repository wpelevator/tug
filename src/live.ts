import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LIVE_MAX_FRAME_BYTES } from './protocol.ts';
import type { Readable, Writable } from 'node:stream';

export interface LiveProcess extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  /** PTY adapters implement this in terminal columns and rows. */
  resize?(columns: number, rows: number): void;
}
export type LiveSpawn = (file: string, args: string[]) => LiveProcess;
export type LiveRequest =
  | { operation: 'exec'; sessionId: string; container: string; command: string[]; interactive?: boolean; tty?: boolean; columns?: number; rows?: number }
  | { operation: 'logs'; sessionId: string; container: string; tail?: number; timestamps?: boolean }
  | { operation: 'ps'; sessionId: string; projects: string[] }
  | { operation: 'inspect'; sessionId: string; container: string };
export type LiveEvent =
  | { sessionId: string; type: 'output'; stream: 'stdout' | 'stderr'; data: string; encoding: 'base64' }
  | { sessionId: string; type: 'result'; result: Record<string, unknown>[] }
  | { sessionId: string; type: 'exit'; code: number | null; signal: string | null; cancelled: boolean; error?: string };
export interface LiveEngineOptions {
  emit: (event: LiveEvent) => void;
  spawn?: LiveSpawn;
  /** A real PTY adapter is required for interactive Docker exec. */
  spawnTty?: LiveSpawn;
  maxSessions?: number;
  maxResultBytes?: number;
  maxSessionMs?: number;
  queryTimeoutMs?: number;
}
interface Session {
  request: LiveRequest;
  child: LiveProcess;
  timer: ReturnType<typeof setTimeout>;
  cleanup: (awaitClose?: boolean) => void;
  output: Buffer[];
  bytes: number;
  errorOutput: Buffer[];
}
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function dimension(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 1000; }
function validate(value: unknown): asserts value is LiveRequest {
  if (!object(value) || typeof value.sessionId !== 'string' || !identifier.test(value.sessionId)) throw new Error('Invalid live session ID');
  if (!['exec', 'logs', 'ps', 'inspect'].includes(String(value.operation))) throw new Error('Invalid live operation');
  if (value.operation !== 'ps' && (typeof value.container !== 'string' || !identifier.test(value.container))) throw new Error('Invalid container');
  if (value.operation === 'exec') {
    if (!Array.isArray(value.command) || value.command.length < 1 || value.command.length > 256 || !value.command.every(arg => typeof arg === 'string' && !arg.includes('\0') && Buffer.byteLength(arg) <= 32768) || value.command[0].length === 0) throw new Error('Invalid exec command');
    if (value.interactive !== undefined && typeof value.interactive !== 'boolean') throw new Error('Invalid interactive flag');
    if (value.tty !== undefined && typeof value.tty !== 'boolean') throw new Error('Invalid TTY flag');
    if ((value.columns !== undefined && !dimension(value.columns)) || (value.rows !== undefined && !dimension(value.rows))) throw new Error('Invalid terminal dimensions');
  }
  if (value.operation === 'logs') {
    if (value.tail !== undefined && (!Number.isInteger(value.tail) || Number(value.tail) < 0 || Number(value.tail) > 10000)) throw new Error('Invalid log tail');
    if (value.timestamps !== undefined && typeof value.timestamps !== 'boolean') throw new Error('Invalid timestamps flag');
  }
  if (value.operation === 'ps' && (!Array.isArray(value.projects) || value.projects.length < 1 || value.projects.length > 256 || !value.projects.every(project => typeof project === 'string' && identifier.test(project)))) throw new Error('Invalid projects');
}
function argv(request: LiveRequest): string[] {
  switch (request.operation) {
    case 'exec': return ['exec', ...(request.interactive === false ? [] : ['-i']), ...(request.tty ? ['-t'] : []), request.container, ...request.command];
    case 'logs': return ['logs', '--follow', '--tail', String(request.tail ?? 100), ...(request.timestamps ? ['--timestamps'] : []), request.container];
    case 'ps': return ['ps', '--all', '--no-trunc', '--format', '{{json .}}', '--filter', `label=com.docker.compose.project=${request.projects[0]}`];
    case 'inspect': return ['inspect', '--type', 'container', request.container];
  }
}

/** Execute exact project-label queries sequentially; Docker label predicates must not broaden project scope. */
function spawnProjectQueries(spawnProcess: LiveSpawn, request: Extract<LiveRequest, { operation: 'ps' }>): LiveProcess {
  const projects = [...new Set(request.projects)];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let current: LiveProcess;
  let stopped = false;
  let detachOutput = () => {};
  const process = Object.assign(new EventEmitter(), {
    stdin: null,
    stdout,
    stderr,
    kill(signal?: NodeJS.Signals): boolean {
      stopped = true;
      detachOutput();
      return current.kill(signal);
    },
  });
  const next = () => {
    const child = spawnProcess('docker', argv({ ...request, projects: [projects.shift()!] }));
    current = child;
    const out = (data: Buffer | string) => { stdout.write(data); };
    const err = (data: Buffer | string) => { stderr.write(data); };
    const error = (cause: Error) => { process.emit('error', cause); };
    const close = (code: number | null, signal: string | null) => {
      child.off('error', error).off('close', close);
      child.stdout?.off('data', out);
      child.stderr?.off('data', err);
      if (!stopped && code === 0 && projects.length) {
        stdout.write('\n');
        if (stopped) { process.emit('close', null, null); return; }
        try { next(); } catch (cause) { process.emit('error', cause); }
      } else process.emit('close', code, signal);
    };
    detachOutput = () => { child.stdout?.off('data', out); child.stderr?.off('data', err); };
    child.stdout?.on('data', out);
    child.stderr?.on('data', err);
    child.on('error', error).on('close', close);
  };
  next();
  return process;
}

/** Owns Docker process lifetimes; callers own authentication, authorization and transport backpressure. */
export class LiveOperationEngine {
  private readonly options: LiveEngineOptions;
  private readonly sessions = new Map<string, Session>();
  constructor(options: LiveEngineOptions) {
    for (const key of ['maxSessions', 'maxResultBytes', 'maxSessionMs', 'queryTimeoutMs'] as const) {
      if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! < 1)) throw new Error(`Invalid ${key}`);
    }
    this.options = options;
  }
  get activeSessions(): number { return this.sessions.size; }
  start(value: unknown): void {
    validate(value);
    if (this.sessions.has(value.sessionId)) throw new Error('Duplicate live session ID');
    if (this.sessions.size >= (this.options.maxSessions ?? 16)) throw new Error('Live session limit reached');
    const request = structuredClone(value);
    const spawnProcess: LiveSpawn | undefined = request.operation === 'exec' && request.tty ? this.options.spawnTty : this.options.spawn ?? ((file, args) => spawn(file, args, { stdio: 'pipe', shell: false }));
    if (!spawnProcess) throw new Error('TTY exec requires a PTY adapter');
    const child = request.operation === 'ps' && request.projects.length > 1 ? spawnProjectQueries(spawnProcess, request) : spawnProcess('docker', argv(request));
    const query = request.operation === 'ps' || request.operation === 'inspect';
    const onError = (error: Error) => {
      if (this.sessions.get(request.sessionId)?.child === child) this.finish(request.sessionId, null, null, false, error.message, true);
    };
    const stopErrors = () => {
      child.off('error', onError).off('close', onClose);
      child.stdin?.off('error', onError);
    };
    const onClose = (code: number | null, signal: string | null) => {
      stopErrors();
      if (this.sessions.get(request.sessionId)?.child === child) this.finish(request.sessionId, code, signal, false);
    };
    const stdout = (data: Buffer | string) => this.output(request.sessionId, 'stdout', data);
    const stderr = (data: Buffer | string) => this.output(request.sessionId, 'stderr', data);
    const timer = setTimeout(() => this.finish(request.sessionId, null, null, false, 'Live operation timed out', true), query ? this.options.queryTimeoutMs ?? 30000 : this.options.maxSessionMs ?? 3600000);
    timer.unref();
    this.sessions.set(request.sessionId, { request, child, timer, output: [], errorOutput: [], bytes: 0, cleanup: (awaitClose = false) => {
      clearTimeout(timer);
      if (!awaitClose) stopErrors();
      child.stdout?.off('data', stdout);
      child.stderr?.off('data', stderr);
    } });
    child.on('error', onError).on('close', onClose);
    child.stdout?.on('data', stdout);
    child.stderr?.on('data', stderr);
    child.stdin?.on('error', onError);
    if (request.operation === 'exec' && request.interactive === false) child.stdin?.end();
    if (request.operation === 'exec' && request.tty) {
      if (!child.resize) { this.finish(request.sessionId, null, null, false, 'PTY adapter does not support resize', true); return; }
      try { child.resize(request.columns ?? 80, request.rows ?? 24); } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  /** Returns the writable backpressure signal; callers must pause transport input on false. */
  stdin(sessionId: string, data: Uint8Array): boolean {
    const session = this.requireExec(sessionId);
    if (!(data instanceof Uint8Array) || data.byteLength > 65536) throw new Error('Invalid stdin frame');
    if (!session.child.stdin || session.child.stdin.destroyed || session.child.stdin.writableEnded) throw new Error('Session stdin is closed');
    if (session.child.stdin.writableLength + data.byteLength > 262144) throw new Error('Live stdin queue exceeds size limit');
    return session.child.stdin.write(data);
  }
  endStdin(sessionId: string): void { this.requireExec(sessionId).child.stdin?.end(); }
  resize(sessionId: string, columns: number, rows: number): void {
    const session = this.requireExec(sessionId);
    if (!dimension(columns) || !dimension(rows)) throw new Error('Invalid terminal dimensions');
    if (!session.request.tty || !session.child.resize) throw new Error('Session has no terminal');
    session.child.resize(columns, rows);
  }
  cancel(sessionId: string): void { this.finish(sessionId, null, null, true, undefined, true); }
  dispose(): void { for (const id of this.sessions.keys()) this.cancel(id); }
  private requireExec(sessionId: string): Session & { request: Extract<LiveRequest, { operation: 'exec' }> } {
    const session = this.sessions.get(sessionId);
    if (!session || session.request.operation !== 'exec') throw new Error('Unknown exec session');
    return session as Session & { request: Extract<LiveRequest, { operation: 'exec' }> };
  }
  private output(id: string, stream: 'stdout' | 'stderr', data: Buffer | string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (session.request.operation === 'ps' || session.request.operation === 'inspect') {
      session.bytes += bytes.length;
      if (session.bytes > (this.options.maxResultBytes ?? 4194304)) { this.finish(id, null, null, false, 'Live result exceeds size limit', true); return; }
      (stream === 'stdout' ? session.output : session.errorOutput).push(bytes);
      return;
    }
    for (let offset = 0; offset < bytes.length && this.sessions.has(id); offset += 65536) this.options.emit({ sessionId: id, type: 'output', stream, data: bytes.subarray(offset, offset + 65536).toString('base64'), encoding: 'base64' });
  }
  private finish(id: string, code: number | null, signal: string | null, cancelled: boolean, error?: string, kill = false): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    // Keep error handlers until close when killing: spawn errors and pending stdin errors can arrive after cancellation.
    session.cleanup(kill);
    if (kill) { try { session.child.kill('SIGKILL'); } catch { /* Already exited. */ } }
    if (!error && !cancelled && (session.request.operation === 'ps' || session.request.operation === 'inspect')) {
      if (code !== 0) error = Buffer.concat(session.errorOutput).toString('utf8').trim() || `Docker exited with code ${code}`;
      else {
        try {
          const raw = Buffer.concat(session.output).toString('utf8').trim();
          const result: unknown = session.request.operation === 'ps' ? raw.split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(raw);
          if (!Array.isArray(result) || !result.every(object)) throw new Error('Expected an array of container objects');
          const frame = { v: 1, type: 'live.result', sessionId: id, result };
          if (Buffer.byteLength(JSON.stringify(frame)) > LIVE_MAX_FRAME_BYTES) throw new Error('Live result exceeds serialized frame size limit');
          this.options.emit({ sessionId: id, type: 'result', result });
        } catch (cause) { error = `Invalid Docker result: ${cause instanceof Error ? cause.message : String(cause)}`; }
      }
    }
    this.options.emit({ sessionId: id, type: 'exit', code, signal, cancelled, ...(error ? { error: error.slice(0, 4096) } : {}) });
  }
}
