import type { Command } from 'commander';
import { print, projectOf, readStdin, request } from './context.ts';
import type { CommonOpts } from './context.ts';
import type { CliRuntime } from '../runtime.ts';

export function registerRegistry(rt: CliRuntime, program: Command): void {
  const registry = program
    .command('registry')
    .description('store the credentials control and agents use to pull private images');
  registry
    .command('login <host>')
    .description(
      'add a registry host (ghcr.io, registry.example.com) to the project secret TUG_REGISTRY_AUTH, keeping its other hosts; the token is read from stdin and never shown',
    )
    .requiredOption('-u, --username <name>', 'the account the token belongs to')
    .action(async (host: string, o: CommonOpts & { username: string }) => {
      if (rt.stdin.isTTY)
        throw new Error(
          `pipe the token in so it is not echoed or kept in your shell history, for example: printf %s "$TOKEN" | tug registry login ${host} --username ${o.username}`,
        );
      const password = (await readStdin(rt)).trim();
      if (!password) throw new Error('stdin was empty: pipe the registry token to this command');
      const result = await request<{ host: string; hosts: string[]; version: number }>(
        rt,
        'POST',
        '/api/v1/registry/login',
        { project: projectOf(rt, o), host, username: o.username, password },
      );
      print(rt, { ok: true, host: result.host, hosts: result.hosts, version: result.version });
    });
}
