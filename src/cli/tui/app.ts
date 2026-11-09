import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { errMessage } from '../../errors.ts';
import type { LiveRequest } from '../../protocol.ts';
import { parseLiveRequest, runCliLive } from '../live.ts';
import type { CliLiveStdin, CliLiveStdout, CliLiveTransport, LiveEvent } from '../live.ts';
import { ACTIONS, runAction } from './actions.ts';
import type { Api } from './actions.ts';
import { deriveAttention } from './derive.ts';
import { createStyle, sanitize, wantsColor } from './format.ts';
import { Poller } from './poller.ts';
import type { Intervals } from './poller.ts';
import { render } from './render.ts';
import { initialState, reduce } from './state.ts';
import type { Effect, Input, Key, UiState } from './state.ts';
import { emptySnapshot } from './types.ts';
import type { Snapshot, Tone, ViewRef } from './types.ts';

export interface TuiIO {
  stdin: Readable & CliLiveStdin;
  stdout: Writable & CliLiveStdout;
  stderr?: Writable;
}
export interface TuiOptions {
  api: Api;
  transport: CliLiveTransport;
  io: TuiIO;
  readonly: boolean;
  /** The view to open on instead of the overview. */
  view?: ViewRef;
  /** The project the configuration resolves to. */
  project: string;
  /** Short name of the control plane for the header. */
  controlLabel: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  intervals?: Intervals;
  /** Ends the screen from outside (a test, or a signal). */
  signal?: AbortSignal;
}

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
const CLEAR = '\x1b[2J';
const MAX_LINE = 4000;

/** Whole lines out of a byte stream that arrives in arbitrary chunks, decoded as UTF-8 and made safe to draw. */
export class LineSplitter {
  private readonly decoder = new TextDecoder('utf-8');
  private partial = '';
  push(data: Uint8Array): string[] {
    this.partial += this.decoder.decode(data, { stream: true });
    const parts = this.partial.split(/\r\n|\n|\r/);
    this.partial = parts.pop() ?? '';
    return parts.map(clean);
  }
  flush(): string[] {
    const rest = this.partial + this.decoder.decode();
    this.partial = '';
    return rest ? [clean(rest)] : [];
  }
}
const clean = (line: string): string => sanitize(line).slice(0, MAX_LINE);

/**
 * Runs the full-screen UI until the person quits: polls the control plane, draws on the alternate screen, turns key
 * presses into state changes and carries out what those changes ask for (live logs, a shell, an action). The terminal
 * is restored on every way out. Resolves with the process exit code.
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const { io } = options;
  const { stdin, stdout } = io;
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)
    throw new Error(
      'tug tui needs a terminal on stdin and stdout; use `tug tui --once` for a summary in scripts',
    );

  const snapshot: Snapshot = emptySnapshot();
  const style = createStyle(wantsColor(stdout.isTTY, options.env ?? process.env));
  let state: UiState = initialState({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
    readonly: options.readonly,
    defaultProject: options.project,
    now: Date.now(),
    view: options.view,
  });
  let version = 0;
  let cached: { key: string; attention: ReturnType<typeof deriveAttention> } | undefined;
  const env = () => {
    const key = `${version}:${Math.floor(state.now / 1000)}`;
    if (cached?.key !== key)
      cached = { key, attention: deriveAttention(snapshot, state.now, options.cliVersion) };
    return { snapshot, attention: cached.attention };
  };

  let finished!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finished = resolve));
  let previous: string[] = [];
  let suspended = false;
  let scheduled = false;
  let live: AbortController | undefined;

  const draw = (full = false): void => {
    scheduled = false;
    if (suspended) return;
    const frame = render(state, env(), {
      style,
      controlLabel: options.controlLabel,
      cliVersion: options.cliVersion,
    });
    let out = full ? CLEAR : '';
    frame.forEach((line, index) => {
      if (full || previous[index] !== line) out += `\x1b[${index + 1};1H\x1b[2K${line}`;
    });
    if (out) stdout.write(out);
    previous = frame;
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => draw());
  };

  const poller = new Poller(
    options.api,
    snapshot,
    () => {
      version += 1;
      schedule();
    },
    options.intervals,
  );

  const flash = (text: string, tone: Tone): void => dispatch({ type: 'flash', text, tone });

  function dispatch(input: Input): void {
    const now = Date.now();
    state = { ...state, now };
    const result = reduce(state, input, env());
    state = result.state;
    for (const effect of result.effects) void perform(effect);
    schedule();
  }

  async function perform(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'quit':
        finished(0);
        return;
      case 'refresh':
        await poller.refresh();
        return;
      case 'load':
        await poller.load(effect.view);
        return;
      case 'logs.close':
      case 'text.close':
        live?.abort();
        live = undefined;
        return;
      case 'logs.open':
        live?.abort();
        live = new AbortController();
        void streamLogs(effect, live.signal);
        return;
      case 'text.open':
        live?.abort();
        live = new AbortController();
        void showResult(effect, live.signal);
        return;
      case 'shell':
        await shell(effect);
        return;
      case 'action': {
        const action = ACTIONS.find((item) => item.id === effect.action)!;
        const result = await runAction(action, options.api, effect.context);
        flash(result.message, result.ok ? 'ok' : 'error');
        await poller.refresh();
        return;
      }
    }
  }

  /** Follows a service's logs into the logs screen, as whole lines, until closed or the session ends. */
  async function streamLogs(
    effect: Extract<Effect, { type: 'logs.open' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const request: LiveRequest = parseLiveRequest('logs', {
      project: effect.project,
      service: effect.service,
      node: effect.node,
      tail: 200,
    });
    const splitter = new LineSplitter();
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushLines = (): void => {
      timer = undefined;
      if (pending.length && !signal.aborted) dispatch({ type: 'logs.append', lines: pending });
      pending = [];
    };
    const add = (lines: string[]): void => {
      pending.push(...lines);
      timer ??= setTimeout(flushLines, 40);
    };
    try {
      const session = await options.transport.open(request, signal);
      // Closing the screen aborts the signal; the session must be closed too, or its event stream never ends.
      signal.addEventListener('abort', () => void session.close(), { once: true });
      if (signal.aborted) void session.close();
      dispatch({ type: 'screen.status', status: 'connected' });
      try {
        for await (const event of session.events) {
          if (signal.aborted) break;
          if (event.type === 'stdout' || event.type === 'stderr') add(splitter.push(event.data));
          else if (event.type === 'error')
            dispatch({ type: 'screen.status', status: `error: ${event.message}` });
          else if (event.type === 'disconnect')
            dispatch({
              type: 'screen.status',
              status: `disconnected${event.message ? `: ${event.message}` : ''}`,
            });
          else if (event.type === 'exit')
            dispatch({ type: 'screen.status', status: `ended (exit ${event.code})` });
        }
      } finally {
        await session.close();
      }
    } catch (error) {
      if (!signal.aborted)
        dispatch({ type: 'screen.status', status: `error: ${errMessage(error)}` });
    } finally {
      if (timer) clearTimeout(timer);
      add(splitter.flush());
      flushLines();
    }
  }

  /** Runs `ps` or `inspect` over the live channel and puts the JSON result on a text screen. */
  async function showResult(
    effect: Extract<Effect, { type: 'text.open' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const request = parseLiveRequest(effect.op, {
      project: effect.project,
      service: effect.service,
      node: effect.node,
    });
    let result: unknown;
    let error: string | undefined;
    try {
      const session = await options.transport.open(request, signal);
      signal.addEventListener('abort', () => void session.close(), { once: true });
      if (signal.aborted) void session.close();
      try {
        for await (const event of session.events as AsyncIterable<LiveEvent>) {
          if (signal.aborted) return;
          if (event.type === 'result') result = event.value;
          else if (event.type === 'error') error = event.message;
          else if (event.type === 'disconnect')
            error ??= event.message ?? 'disconnected before the result arrived';
          else if (event.type === 'exit') {
            if (event.code !== 0) error ??= `exited with code ${event.code}`;
            break;
          }
        }
      } finally {
        await session.close();
      }
    } catch (caught) {
      error = errMessage(caught);
    }
    if (signal.aborted) return;
    const lines = error
      ? [`Could not read ${effect.op}: ${error}`]
      : (JSON.stringify(result ?? null, null, 2) ?? 'null').split('\n');
    dispatch({ type: 'text.set', lines: lines.map(clean) });
  }

  /** Hands the terminal to `exec -t`, then takes it back and redraws. */
  async function shell(effect: Extract<Effect, { type: 'shell' }>): Promise<void> {
    suspended = true;
    stdin.off('keypress', onKeypress);
    stdout.write(LEAVE);
    stdin.setRawMode!(false);
    let message: { text: string; tone: Tone } | undefined;
    try {
      const code = await runCliLive(
        parseLiveRequest('exec', {
          project: effect.project,
          service: effect.service,
          node: effect.node,
          command: ['sh'],
          interactive: true,
          tty: true,
        }),
        options.transport,
        { stdin, stdout, stderr: io.stderr },
      );
      if (code !== 0) message = { text: `shell exited with code ${code}`, tone: 'warn' };
    } catch (error) {
      message = { text: `shell failed: ${errMessage(error)}`, tone: 'error' };
    } finally {
      stdin.setRawMode!(true);
      stdout.write(ENTER);
      stdin.on('keypress', onKeypress);
      stdin.resume();
      suspended = false;
      previous = [];
      state = {
        ...state,
        columns: stdout.columns || state.columns,
        rows: stdout.rows || state.rows,
      };
    }
    if (message) flash(message.text, message.tone);
    draw(true);
  }

  function onKeypress(_text: string | undefined, key: Key | undefined): void {
    dispatch({ type: 'key', key: key ?? { sequence: _text } });
  }
  const onResize = (): void => {
    dispatch({ type: 'resize', columns: stdout.columns || 80, rows: stdout.rows || 24 });
    previous = [];
    draw(true);
  };

  const wasRaw = Boolean(stdin.isRaw);
  const ticker = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000);
  const onSignal = (): void => finished(0);
  const abort = (): void => finished(0);
  options.signal?.addEventListener('abort', abort, { once: true });
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  const restore = (): void => {
    try {
      stdout.write(LEAVE);
    } catch {
      // The terminal is already gone; nothing to restore.
    }
  };
  process.once('exit', restore);
  try {
    stdout.write(ENTER);
    stdin.setRawMode(true);
    readline.emitKeypressEvents(stdin);
    stdin.on('keypress', onKeypress);
    stdin.resume();
    stdout.on('resize', onResize);
    poller.start();
    if (options.view) void poller.load(options.view);
    draw(true);
    return await done;
  } finally {
    clearInterval(ticker);
    poller.stop();
    live?.abort();
    options.signal?.removeEventListener('abort', abort);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('exit', restore);
    stdout.off('resize', onResize);
    stdin.off('keypress', onKeypress);
    restore();
    try {
      stdin.setRawMode(wasRaw);
    } finally {
      stdin.pause();
    }
  }
}
