import type { Command } from 'commander';
import { projectOf, request, runLive, waitForCommand } from './context.ts';
import type { CommonOpts } from './context.ts';

export function registerService(program: Command): void {
  program
    .command('exec <service> [command...]')
    .description('execute a command on a service container (default: sh)')
    .option('-i, --interactive', 'forward stdin to the remote command')
    .option('-t, --tty', 'allocate a terminal (requires a local terminal and agent TTY support)')
    .option('--node <name>', 'select the node when a service has multiple placements')
    .action(
      async (
        service: string,
        command: string[],
        o: { interactive?: boolean; tty?: boolean; node?: string },
      ) => {
        await runLive('exec', { service, command, ...o });
      },
    );
  program
    .command('run <service> [command...]')
    .description(
      "run a one-off command in a new container from the service: same image, environment, secrets, network and mounts, removed afterwards (for example: tug run web -- wp core update-db). Exits with the command's exit code",
    )
    .option('--node <name>', 'select the node when a service has multiple placements')
    .action(async (service: string, command: string[], o: { node?: string }) => {
      if (!command.length)
        throw new Error('run needs a command, such as: tug run web -- wp core update-db');
      await runLive('exec', { service, command, node: o.node, oneOff: true });
    });
  program
    .command('ps')
    .description('print per-container state as JSON')
    .option('--node <name>', 'select one node')
    .action(async (o: { node?: string }) => {
      await runLive('ps', o);
    });
  program
    .command('inspect <service>')
    .description('print container details as JSON')
    .option('--node <name>', 'select one node')
    .action(async (service: string, o: { node?: string }) => {
      await runLive('inspect', { service, ...o });
    });
  program
    .command('logs <service>')
    .description('fetch service container logs from the node that runs the service')
    .option('--tail <n>', 'number of lines', '200')
    .option('-f, --follow', 'follow live logs')
    .option('--node <name>', 'select a node for followed logs')
    .action(
      async (svc: string, o: CommonOpts & { tail: string; follow?: boolean; node?: string }) => {
        if (o.follow) {
          await runLive('logs', { service: svc, node: o.node, tail: o.tail });
          return;
        }
        if (o.node) throw new Error('--node requires --follow for logs');
        const created = await request('POST', '/api/v1/logs', {
          project: await projectOf(o),
          service: svc,
          tail: Number(o.tail),
        });
        const cmd = await waitForCommand(created.commandId, 60);
        const result = JSON.parse(cmd.result_json || '{}');
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error) throw new Error(result.error);
      },
    );
}
