import { selectResource } from './selection.ts';
import type { Command } from 'commander';
import { collectList, print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';
import { importValues } from './import-values.ts';
import type { ImportOpts } from './import-values.ts';
import { readValue } from './value-input.ts';
import type { ValueInputOpts } from './value-input.ts';

export function registerSecret(program: Command): void {
  const secret = program
    .command('secret')
    .description('manage the project secrets that Compose files reference');
  secret
    .command('set <name>')
    .description(
      'set a secret (never shown again); the value is a line on stdin, --value, or the exact contents of --from-file (- reads stdin to the end)',
    )
    .option('--value <value>')
    .option('--from-file <path>', 'read the exact contents of a file, newlines included')
    .action(async (name: string, o: CommonOpts & ValueInputOpts) => {
      const value = await readValue(name, o);
      print(await request('POST', '/api/v1/secrets', { project: await projectOf(o), name, value }));
    });
  secret
    .command('import [file]')
    .description(
      'store the entries of a dotenv file (default .env): secrets, or variables for names that do not look like credentials; values are never printed',
    )
    .option('--vars <names>', 'store these names as variables (comma-separated)', collectList, [])
    .option('--secrets <names>', 'store these names as secrets (comma-separated)', collectList, [])
    .option('--select', 'choose secret, variable or exclude for each entry in a terminal')
    .option('--overwrite', 'replace a name that already exists as the same kind')
    .option('-y, --yes', 'skip the confirmation in a terminal')
    .action(async (file: string | undefined, o: ImportOpts) => importValues(file, o, 'secret'));
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
