import type { Command } from 'commander';
import { packageVersion } from '../../images/image.ts';
import { createCliLiveTransport } from '../live-transport.ts';
import { emptySnapshot } from '../tui/types.ts';
import type { ViewRef } from '../tui/types.ts';
import { runTui } from '../tui/app.ts';
import { formatOnce, onceReport } from '../tui/once.ts';
import { Poller } from '../tui/poller.ts';
import { COMMANDS, resolveCommand } from '../tui/state.ts';
import { loadCfg, print, request, transportFor } from './context.ts';

const VIEWS = COMMANDS.filter((name) => name !== 'help' && name !== 'quit');

/** The host the credential names, shown in the header so a screen left open says which control it watches. */
function controlLabel(url: string | undefined): string {
  try {
    return new URL(url ?? '').host;
  } catch {
    return 'control';
  }
}

export function registerTui(program: Command): void {
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
        const cfg = await loadCfg();
        const project = cfg.project || 'site';
        const name = view === undefined ? undefined : resolveCommand(view);
        if (view !== undefined && (!name || !(VIEWS as readonly string[]).includes(name)))
          throw new Error(`unknown view "${view}"; choose one of: ${VIEWS.join(', ')}`);
        const api = {
          request,
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        };
        if (o.once || o.json) {
          const snapshot = emptySnapshot();
          await new Poller(api, snapshot, () => {}).pollOnce();
          const report = onceReport(snapshot, Date.now(), packageVersion());
          if (o.json) print(report);
          else console.log(formatOnce(report, Date.now()));
          if (!report.ok) process.exitCode = 1;
          return;
        }
        await transportFor(cfg, 'probe').then((transport) => transport.close());
        const ref: ViewRef | undefined =
          name && name !== 'overview'
            ? {
                name: name as ViewRef['name'],
                ...(['domains', 'volumes', 'secrets'].includes(name) ? { project } : {}),
              }
            : undefined;
        process.exitCode = await runTui({
          api,
          transport: createCliLiveTransport(cfg.credential, cfg.controlUrl),
          io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
          readonly: Boolean(o.readonly),
          project,
          view: ref,
          controlLabel: controlLabel(cfg.credential?.url),
          cliVersion: packageVersion(),
        });
      },
    );
}
