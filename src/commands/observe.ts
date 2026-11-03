import type { Command } from 'commander';
import { errMessage } from '../util.ts';
import { formatStatus } from '../cli-status.ts';
import type { StatusResponse } from '../cli-status.ts';
import { loadCfg, print, request, runCapture, waitForCommand } from './context.ts';
import type { CommonOpts } from './context.ts';

export function registerObserve(program: Command): void {
  program
    .command('status')
    .description('summarize projects, deployments and nodes')
    .option('--json', 'print the raw status as JSON for scripts')
    .action(async (o: { json?: boolean }) => {
      const status = await request<StatusResponse>('GET', '/api/v1/status');
      console.log(o.json ? JSON.stringify(status, null, 2) : formatStatus(status));
    });
  program
    .command('events')
    .description(
      'list recent events with the credential that caused each control action; defaults to the resolved project',
    )
    .option('--limit <n>', 'number of events', '100')
    .option(
      '--all',
      'list events across all projects (limited to your projects for scoped credentials)',
    )
    .action(async (o: CommonOpts & { limit: string; all?: boolean }) => {
      if (o.all && o.project) throw new Error('--all and --project cannot be combined');
      const cfg = await loadCfg();
      const project = o.all ? undefined : o.project || cfg.project;
      const query = `limit=${encodeURIComponent(o.limit)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
      print(await request('GET', `/api/v1/events?${query}`));
    });
  program
    .command('doctor')
    .description(
      'check this machine and the control plane: certificate expiry, node connectivity and clock skew',
    )
    .option('--nodes', 'also run host diagnostics on every node through its agent and wait')
    .option('--node <name>', 'run host diagnostics on one node through its agent and wait')
    .option('--timeout <seconds>', 'wait timeout for node diagnostics', '60')
    .action(async (o: { nodes?: boolean; node?: string; timeout: string }) => {
      const local: { name: string; ok: boolean; output?: string; error?: string }[] = [];
      for (const [name, cmd, args] of [
        ['node', 'node', ['--version']],
        ['docker', 'docker', ['version', '--format', '{{.Server.Version}}']],
        ['docker_compose', 'docker', ['compose', 'version']],
      ] as [string, string, string[]][]) {
        try {
          local.push({ name, ok: true, output: runCapture(cmd, args).trim() });
        } catch (e) {
          local.push({ name, ok: false, error: errMessage(e) });
        }
      }
      const controlDiagnostics = await request('GET', '/api/v1/diagnostics');
      const warnings = (controlDiagnostics.checks ?? []).flatMap(
        (check: { name: string; warnings?: string[] }) =>
          (check.warnings ?? []).map((warning) => `${check.name}: ${warning}`),
      );
      const output: {
        ok: boolean;
        warnings?: string[];
        local: typeof local;
        control: unknown;
        nodeDiagnostics?: unknown;
      } = {
        ok: local.every((c) => c.ok) && controlDiagnostics.ok,
        ...(warnings.length && { warnings }),
        local,
        control: controlDiagnostics,
      };
      if (o.nodes || o.node) {
        const queued = await request<{ commands: { commandId: string; nodeId: string }[] }>(
          'POST',
          '/api/v1/diagnostics/nodes',
          { node: o.node || null },
        );
        const commands = [];
        for (const command of queued.commands) {
          const finished = await waitForCommand(command.commandId, Number(o.timeout));
          commands.push({
            nodeId: command.nodeId,
            state: finished.state,
            result: JSON.parse(finished.result_json || '{}'),
          });
        }
        output.nodeDiagnostics = { commands };
        if (commands.some((command) => command.state !== 'succeeded')) output.ok = false;
      }
      print(output);
    });
}
