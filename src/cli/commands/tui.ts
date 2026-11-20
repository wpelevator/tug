import type { Command } from 'commander';
import { createCliLiveTransport } from '../live-transport.ts';
import { WatchClient } from '../watch-client.ts';
import { emptySnapshot } from '../tui/types.ts';
import type { ViewRef } from '../tui/types.ts';
import { runTui } from '../tui/app.ts';
import { formatOnce, onceReport } from '../tui/once.ts';
import { Poller } from '../tui/poller.ts';
import { COMMANDS, resolveCommand } from '../tui/state.ts';
import { loadCfg, print, request, transportFor } from './context.ts';
import { out } from '../runtime.ts';
import type { CliRuntime } from '../runtime.ts';

const VIEWS = COMMANDS.filter((name) => name !== 'help' && name !== 'quit');

/** The host the credential names, shown in the header so a screen left open says which control it watches. */
function controlLabel(url: string | undefined): string {
  try {
    return new URL(url ?? '').host;
  } catch {
    return 'control';
  }
}

export function registerTui(rt: CliRuntime, program: Command): void {
  program
    .command('tui [view]')
    .description(
      `a live full-screen view of the whole setup: what needs attention first, then projects, nodes, events, logs and a shell (views: ${VIEWS.join(', ')})`,
    )
    .option(
      '--once',
      'print the attention summary and exit nonzero when anything is wrong, for cron and prompts',
    )
    .option('--readonly', 'hide every key that changes something, including the shell')
    .option('--json', 'with --once, print the summary as JSON (implies --once)')
    .action(
      async (
        view: string | undefined,
        o: { once?: boolean; readonly?: boolean; json?: boolean },
      ) => {
        const cfg = loadCfg(rt);
        const project = cfg.project;
        const name = view === undefined ? undefined : resolveCommand(view);
        if (view !== undefined && (!name || !(VIEWS as readonly string[]).includes(name)))
          throw new Error(`unknown view "${view}"; choose one of: ${VIEWS.join(', ')}`);
        const api = {
          request: <T = unknown>(
            method: string,
            route: string,
            body?: unknown,
            multipart?: boolean,
          ) => request<T>(rt, method, route, body, multipart),
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        };
        if (o.once || o.json) {
          const snapshot = emptySnapshot();
          await new Poller(api, snapshot, () => {}).pollOnce();
          const report = onceReport(snapshot, Date.now(), rt.version);
          if (o.json) print(rt, report);
          else out(rt, formatOnce(report, Date.now()));
          if (!report.ok) rt.exitCode = 1;
          return;
        }
        await transportFor(rt, cfg, 'probe').then((transport) => transport.close());
        const ref: ViewRef | undefined =
          name && name !== 'overview'
            ? {
                name: name as ViewRef['name'],
                ...(['domains', 'volumes', 'secrets'].includes(name) ? { project } : {}),
              }
            : undefined;
        rt.exitCode = await runTui({
          api,
          transport: createCliLiveTransport(cfg.credential, cfg.controlUrl, rt.version),
          watch: (handlers) =>
            new WatchClient({
              credential: cfg.credential!,
              controlUrl: cfg.controlUrl,
              clientVersion: rt.version,
              ...handlers,
            }),
          io: { stdin: rt.stdin, stdout: rt.stdout, stderr: rt.stderr, signals: rt.signals },
          env: rt.env,
          readonly: Boolean(o.readonly),
          project,
          view: ref,
          controlLabel: controlLabel(cfg.credential?.url),
          cliVersion: rt.version,
        });
      },
    );
}
