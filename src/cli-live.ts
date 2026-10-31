import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import type { LiveRequest } from './protocol.ts';
export type { LiveRequest } from './protocol.ts';

export interface LiveInput {
  project: string;
  service?: string;
  node?: string;
  command?: string[];
  interactive?: boolean;
  tty?: boolean;
  tail?: string | number;
}

/** Command arguments are passed verbatim, never joined into a shell command. */
export function parseLiveRequest(operation: LiveRequest['operation'], input: LiveInput): LiveRequest {
  const name = (value: string | undefined, label: string): string => {
    if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error(`${label} must be a nonempty name containing letters, numbers, dots, underscores or hyphens`);
    return value;
  };
  const common = { project: name(input.project, 'project'), ...(input.node === undefined ? {} : { node: name(input.node, 'node') }) };
  if (operation === 'ps') return { operation, ...common };
  const service = name(input.service, 'service');
  if (operation === 'inspect') return { operation, ...common, service };
  if (operation === 'logs') {
    const raw = String(input.tail ?? 200);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('tail must be a nonnegative safe integer');
    return { operation, ...common, service, follow: true, tail: Number(raw) };
  }
  const command = input.command?.length ? [...input.command] : ['sh'];
  if (command.some(part => typeof part !== 'string' || part.includes('\0')) || !command[0]) throw new Error('exec command must have a nonempty executable and no NUL bytes');
  return { operation, ...common, service, command, interactive: input.interactive ?? false, tty: input.tty ?? false };
}

export type LiveClientMessage =
  | { type: 'stdin'; data: Uint8Array }
  | { type: 'stdin-end' }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'cancel' };

export type LiveEvent =
  | { type: 'stdout' | 'stderr'; data: Uint8Array }
  | { type: 'result'; value: unknown }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'disconnect'; message?: string };

/** Adapters must bound received buffering and unblock event iteration when closed. */
export interface CliLiveSession {
  events: AsyncIterable<LiveEvent>;
  send(message: LiveClientMessage): void | Promise<void>;
  close(): void | Promise<void>;
}
export interface CliLiveTransport {
  /** Respect abort during connection establishment; a late session is closed by the runner. */
  open(request: LiveRequest, signal: AbortSignal): Promise<CliLiveSession>;
}

export type CliLiveStdin = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown };
export type CliLiveStdout = Writable & { isTTY?: boolean; columns?: number; rows?: number };
export interface CliLiveIO {
  stdin?: CliLiveStdin;
  stdout?: CliLiveStdout;
  stderr?: Writable;
  signals?: EventEmitter;
  signal?: AbortSignal;
}
export class CliLiveError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliLiveError';
    this.exitCode = exitCode;
  }
}
export function formatLiveResult(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new CliLiveError('remote operation returned no JSON result');
  return `${json}\n`;
}

/** Runs one session without exiting the process or owning the caller's streams. */
export async function runCliLive(request: LiveRequest, transport: CliLiveTransport, io: CliLiveIO = {}): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const signals = io.signals ?? process;
  const controller = new AbortController();
  let session: CliLiveSession | undefined;
  let complete = false;
  let rawChanged = false;
  let inputAttached = false;
  const wasRaw = Boolean(stdin.isRaw);
  const wasFlowing = stdin.readableFlowing === true;
  let failure: Error | undefined;
  let wake!: () => void;
  const stopped = new Promise<void>(resolve => { wake = resolve; });
  let queuedBytes = 0;
  let sending = Promise.resolve();
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    wake();
  };
  const send = (message: LiveClientMessage): void => {
    const size = message.type === 'stdin' ? message.data.byteLength : 0;
    queuedBytes += size;
    if (queuedBytes > 1024 * 1024) { fail(new CliLiveError('stdin exceeded the live session buffer limit')); return; }
    sending = sending.then(async () => {
      if (!complete && !controller.signal.aborted) await session!.send(message);
    }).catch(fail).finally(() => { queuedBytes -= size; });
  };
  const cancel = (): void => { controller.abort(); wake(); };
  const onData = (data: Buffer | string): void => { send({ type: 'stdin', data: Buffer.from(data) }); };
  const onEnd = (): void => { send({ type: 'stdin-end' }); };
  const onStreamError = (error: Error): void => { fail(error); };
  const resize = (): void => {
    if (Number.isInteger(stdout.columns) && stdout.columns! > 0 && Number.isInteger(stdout.rows) && stdout.rows! > 0) send({ type: 'resize', columns: stdout.columns!, rows: stdout.rows! });
  };
  const write = async (stream: Writable, data: Uint8Array | string): Promise<void> => {
    await new Promise<void>((resolve, reject) => { stream.write(data, error => { if (error) reject(error); else resolve(); }); });
  };
  const consume = async (): Promise<number> => {
    let result: unknown;
    let hasResult = false;
    for await (const event of session!.events) {
      if (complete || controller.signal.aborted) return 130;
      switch (event.type) {
        case 'stdout': await write(stdout, event.data); break;
        case 'stderr': await write(stderr, event.data); break;
        case 'result': result = event.value; hasResult = true; break;
        case 'error': throw new CliLiveError(event.message);
        case 'disconnect': throw new CliLiveError(event.message ?? 'live session disconnected before exit');
        case 'exit':
          if (!Number.isInteger(event.code) || event.code < 0 || event.code > 255) throw new CliLiveError('remote operation returned an invalid exit code');
          if (event.code === 0 && (request.operation === 'ps' || request.operation === 'inspect')) {
            if (!hasResult) throw new CliLiveError('remote operation exited without a JSON result');
            await write(stdout, formatLiveResult(result));
          }
          return event.code;
      }
    }
    throw new CliLiveError('live session disconnected before exit');
  };
  signals.on('SIGINT', cancel);
  io.signal?.addEventListener('abort', cancel, { once: true });
  stdout.on('error', onStreamError);
  stderr.on('error', onStreamError);
  try {
    if (io.signal?.aborted) cancel();
    if (controller.signal.aborted) return 130;
    if (request.operation === 'exec' && request.tty && (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)) throw new CliLiveError('TTY exec requires a local terminal on stdin and stdout');
    const openRequest = request.operation === 'exec' && request.tty ? { ...request, ...(stdout.columns && stdout.rows ? { columns: stdout.columns, rows: stdout.rows } : {}) } : request;
    const opening = transport.open(openRequest, controller.signal).then(async opened => {
      if (complete || controller.signal.aborted) { await opened.close(); return undefined; }
      return opened;
    });
    session = await Promise.race([opening, stopped.then(() => undefined)]);
    if (!session) { if (failure) throw failure; return 130; }
    if (request.operation === 'exec') {
      if (request.tty) {
        rawChanged = !wasRaw;
        if (rawChanged) stdin.setRawMode!(true);
        stdout.on('resize', resize);
        resize();
      }
      if (request.interactive) {
        inputAttached = true;
        stdin.on('data', onData).on('end', onEnd).on('error', onStreamError);
        stdin.resume();
        if (stdin.readableEnded) onEnd();
      }
    }
    const code = await Promise.race([consume(), stopped.then(() => { if (failure) throw failure; return 130; })]);
    if (failure) throw failure;
    return code;
  } finally {
    complete = true;
    signals.off('SIGINT', cancel);
    io.signal?.removeEventListener('abort', cancel);
    stdout.off('resize', resize);
    if (inputAttached) {
      stdin.off('data', onData).off('end', onEnd).off('error', onStreamError);
      if (!wasFlowing) stdin.pause();
    }
    try {
      if (rawChanged) stdin.setRawMode?.(wasRaw);
    } finally {
      try {
        if (session) {
          if (controller.signal.aborted || failure) { try { await session.send({ type: 'cancel' }); } catch {} }
          await session.close();
        }
      } finally {
        stdout.off('error', onStreamError);
        stderr.off('error', onStreamError);
      }
    }
  }
}
