import { selectResource } from './selection.ts';
import type { Command } from 'commander';
import { print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';

export function registerSecret(program: Command): void {
  const secret = program
    .command('secret')
    .description('manage the project secrets that Compose files reference');
  secret
    .command('set <name>')
    .description('set a secret, reading the value from stdin unless --value is given')
    .option('--value <value>')
    .action(async (name: string, o: CommonOpts & { value?: string }) => {
      const value =
        o.value ??
        (await new Promise<string>((resolve) => {
          process.stdout.write(`${name}: `);
          process.stdin.once('data', (d) => {
            // This command needs no more input; an open stdin can otherwise keep Node alive.
            process.stdin.destroy();
            resolve(String(d).trim());
          });
        }));
      print(await request('POST', '/api/v1/secrets', { project: await projectOf(o), name, value }));
    });
  secret
    .command('list')
    .description('list secret names and versions, never values')
    .action(async (o: CommonOpts) =>
      print(
        await request('GET', `/api/v1/secrets?project=${encodeURIComponent(await projectOf(o))}`),
      ),
    );
  secret
    .command('remove [name]')
    .description('delete a secret')
    .action(async (name: string, o: CommonOpts) =>
      print(
        await request(
          'DELETE',
          `/api/v1/secrets/${encodeURIComponent(await selectResource(name, 'secrets'))}?project=${encodeURIComponent(await projectOf(o))}`,
        ),
      ),
    );
}
