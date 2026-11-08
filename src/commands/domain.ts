import type { Command } from 'commander';
import { print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';

export function registerDomain(program: Command): void {
  const domain = program
    .command('domain')
    .description(
      "map extra hostnames onto a service's ingress route, without a deployment (WordPress multisite domain mapping)",
    );
  domain
    .command('add <host>')
    .description(
      'serve a hostname, or a *.zone wildcard, on a service that has x-tug.ingress; the edge applies it from its next poll',
    )
    .requiredOption('--service <service>', 'the service whose ingress route serves the hostname')
    .action(async (host: string, o: CommonOpts & { service: string }) =>
      print(
        await request('POST', '/api/v1/domains', {
          project: await projectOf(o),
          service: o.service,
          host,
        }),
      ),
    );
  domain
    .command('list')
    .alias('ls')
    .description('list the mapped domains of the project')
    .action(async (o: CommonOpts) =>
      print(
        await request('GET', `/api/v1/domains?project=${encodeURIComponent(await projectOf(o))}`),
      ),
    );
  domain
    .command('remove <host>')
    .description('stop serving a mapped domain')
    .action(async (host: string, o: CommonOpts) =>
      print(
        await request(
          'DELETE',
          `/api/v1/domains/${encodeURIComponent(host)}?project=${encodeURIComponent(await projectOf(o))}`,
        ),
      ),
    );
}
