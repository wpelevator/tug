import type { Command } from 'commander';
import { printResult, request, runLive, waitForCommand } from './context.ts';
import { formatIngressTls } from '../status.ts';
import type { IngressTlsNode } from '../status.ts';
import { selectIngressNode } from './selection.ts';

/** Shared by `tug ingress logs` and its `tug logs --ingress` shorthand. */
export async function ingressLogs(
  node: string | undefined,
  o: { tail: string; follow?: boolean },
): Promise<void> {
  node = await selectIngressNode(node);
  if (o.follow) {
    await runLive('ingress-logs', { node, tail: o.tail });
    return;
  }
  const created = await request('POST', '/api/v1/ingress/logs', { node, tail: Number(o.tail) });
  const cmd = await waitForCommand(created.commandId, 60);
  const result = JSON.parse(cmd.result_json || '{}');
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(result.error);
}

export function registerIngress(program: Command): void {
  const ingress = program
    .command('ingress')
    .description(
      'inspect the managed Caddy edge on ingress nodes (enable the role with `tug node ingress`)',
    );
  ingress
    .command('logs [node]')
    .description("print the managed Caddy container's logs on an ingress node (admin credential)")
    .option('--tail <n>', 'number of lines', '200')
    .option('-f, --follow', 'follow live logs')
    .action(async (node: string | undefined, o: { tail: string; follow?: boolean }) =>
      ingressLogs(node, o),
    );
  ingress
    .command('tls [node]')
    .description(
      "show, per ingress node, whether each named host serves a valid certificate (a TLS handshake against the node's Caddy), with the issuance error when it does not (admin credential)",
    )
    .option('--json', 'print the report as JSON')
    .action(async (node: string | undefined, o: { json?: boolean }) => {
      const { nodes } = await request<{ nodes: IngressTlsNode[] }>('GET', '/api/v1/ingress/tls');
      const shown = node ? nodes.filter((n) => n.node === node) : nodes;
      if (node && !shown.length) throw new Error(`node ${node} is not an enabled ingress node`);
      printResult(o.json, shown, formatIngressTls);
    });
}
