import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { CliLiveSession, CliLiveTransport, LiveEvent } from '../src/cli/live.ts';
import type { LiveRequest } from '../src/protocol.ts';
import type { Api } from '../src/cli/tui/actions.ts';
import { runTui } from '../src/cli/tui/app.ts';
import type { TuiIO, TuiOptions } from '../src/cli/tui/app.ts';
import { staleBackup, unhealthyStatus } from './tui-fixtures.ts';

/** A fake terminal, API and live transport for driving `runTui` in tests. */
export const FAST = { status: 40, events: 40, slow: 40, diagnostics: 40, lists: 40 };

export function fakeTerminal(columns = 100, rows = 30) {
  const stdin = new PassThrough() as unknown as TuiIO['stdin'] & PassThrough;
  stdin.isTTY = true;
  stdin.isRaw = false;
  const rawModes: boolean[] = [];
  stdin.setRawMode = (mode: boolean) => {
    stdin.isRaw = mode;
    rawModes.push(mode);
    return stdin;
  };
  const stdout = new PassThrough() as unknown as TuiIO['stdout'] & PassThrough;
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  let output = '';
  stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { stdin, stdout, rawModes, output: () => output };
}

export { until } from './wait.ts';

export function fakeApi(status = unhealthyStatus) {
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const api: Api = {
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      calls.push({ method, route, body });
      const value: unknown =
        route === '/api/v1/whoami'
          ? { name: 'root', role: 'admin', projects: null }
          : route === '/api/v1/version'
            ? { v: '1.2.0' }
            : route === '/api/v1/status'
              ? status()
              : route.startsWith('/api/v1/events')
                ? { events: [] }
                : route.startsWith('/api/v1/backups?')
                  ? staleBackup
                  : route.startsWith('/api/v1/restores')
                    ? { restores: [] }
                    : route === '/api/v1/nodes'
                      ? { nodes: [] }
                      : route === '/api/v1/diagnostics'
                        ? { ok: true, checks: [] }
                        : route === '/api/v1/rollback'
                          ? { deployment: { id: 'dep_9', state: 'rolling_out' } }
                          : undefined;
      if (value === undefined) throw new Error(`${method} ${route}: 404 not found`);
      return value as T;
    },
    sleep: async () => {},
  };
  return { api, calls };
}

/** A live session the test drives by pushing events, recording what the screen asked for and whether it closed. */
export function fakeTransport() {
  const opened: LiveRequest[] = [];
  const sessions: { push(event: LiveEvent): void; closed: boolean }[] = [];
  const transport: CliLiveTransport = {
    async open(request): Promise<CliLiveSession> {
      opened.push(request);
      const queue: LiveEvent[] = [];
      let wake: (() => void) | undefined;
      const handle = {
        closed: false,
        push(event: LiveEvent) {
          queue.push(event);
          wake?.();
        },
      };
      sessions.push(handle);
      return {
        events: (async function* () {
          while (!handle.closed) {
            if (queue.length) yield queue.shift()!;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        })(),
        send() {},
        async close() {
          handle.closed = true;
          wake?.();
        },
      };
    },
  };
  return { transport, opened, sessions };
}

export function start(
  over: {
    status?: () => ReturnType<typeof unhealthyStatus>;
    readonly?: boolean;
    watch?: TuiOptions['watch'];
    intervals?: TuiOptions['intervals'];
  } = {},
) {
  const term = fakeTerminal();
  const { api, calls } = fakeApi(over.status);
  const live = fakeTransport();
  const done = runTui({
    api,
    transport: live.transport,
    io: term,
    readonly: over.readonly ?? false,
    project: 'site',
    controlLabel: 'control-3fa9.tug',
    cliVersion: '1.2.0',
    env: { NO_COLOR: '1' },
    intervals: over.intervals ?? FAST,
    watch: over.watch,
  });
  return { term, calls, live, done };
}
