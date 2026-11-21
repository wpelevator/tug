import type { Command } from 'commander';
import { print, projectOf, readStdin, request } from './context.ts';
import type { CommonOpts } from './context.ts';
import { canPrompt, prompter } from '../prompt.ts';
import type { CliRuntime } from '../runtime.ts';

export function registerRegistry(rt: CliRuntime, program: Command): void {
  const registry = program
    .command('registry')
    .description('store the credentials control and agents use to pull private images');
  registry
    .command('login <host>')
    .description(
      'add a registry host (ghcr.io, registry.example.com) to the project secret TUG_REGISTRY_AUTH, keeping its other hosts; the token is asked for without echo in a terminal, or read from stdin, and never shown',
    )
    .requiredOption('-u, --username <name>', 'the account the token belongs to')
    .action(async (host: string, o: CommonOpts & { username: string }) => {
      // A hidden prompt keeps the token off the screen and out of shell history; a pipe serves CI.
      const typed = rt.stdin.isTTY;
      if (typed && !canPrompt(rt))
        throw new Error(
          `no terminal to ask in: pipe the token, for example: printf %s "$TOKEN" | tug registry login ${host} --username ${o.username}`,
        );
      const password = (
        typed ? await prompter(rt)(`Token for ${o.username}@${host}: `, true) : await readStdin(rt)
      ).trim();
      if (!password)
        throw new Error(
          typed
            ? 'no token was entered'
            : 'stdin was empty: pipe the registry token to this command',
        );
      const result = await request<{ host: string; hosts: string[]; version: number }>(
        rt,
        'POST',
        '/api/v1/registry/login',
        { project: projectOf(rt, o), host, username: o.username, password },
      );
      print(rt, { ok: true, host: result.host, hosts: result.hosts, version: result.version });
    });
}
