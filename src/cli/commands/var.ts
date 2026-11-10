import type { Command } from 'commander';
import { collectList, print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';
import { importValues } from './import-values.ts';
import type { ImportOpts } from './import-values.ts';
import { selectResource } from './selection.ts';
import { readValue } from './value-input.ts';
import type { ValueInputOpts } from './value-input.ts';

export function registerVar(program: Command): void {
  const vars = program
    .command('var')
    .description(
      'manage the project variables that Compose files reference: visible values such as image tags, hosts and ports (use tug secret for anything private)',
    );
  vars
    .command('set <name>')
    .description(
      'set a variable; the value is a line on stdin, --value, or the exact contents of --from-file (- reads stdin to the end). It takes effect on the next deploy',
    )
    .option('--value <value>')
    .option('--from-file <path>', 'read the exact contents of a file, newlines included')
    .action(async (name: string, o: CommonOpts & ValueInputOpts) => {
      const value = await readValue(name, o);
      const result = await request<{ version: number }>('POST', '/api/v1/vars', {
        project: await projectOf(o),
        name,
        value,
      });
      print(result);
      // On stderr, so a script reading the JSON result is unaffected.
      console.error(
        `variable ${name} stored (version ${result.version}); it takes effect on the next tug deploy. Variables are visible to anyone with a deploy credential: use tug secret set for private values`,
      );
    });
  vars
    .command('list')
    .description('list variable names and versions; --values also shows each value')
    .option('--values', 'show values (needs a deploy credential)')
    .action(async (o: CommonOpts & { values?: boolean }) =>
      print(
        await request(
          'GET',
          `/api/v1/vars${o.values ? '/values' : ''}?project=${encodeURIComponent(await projectOf(o))}`,
        ),
      ),
    );
  vars
    .command('remove [name]')
    .description(
      'delete a variable; deployments that already used it keep the value they were made with',
    )
    .action(async (name: string, o: CommonOpts) =>
      print(
        await request(
          'DELETE',
          `/api/v1/vars/${encodeURIComponent(await selectResource(name, 'vars'))}?project=${encodeURIComponent(await projectOf(o))}`,
        ),
      ),
    );
  vars
    .command('import [file]')
    .description(
      'store the entries of a dotenv file (default .env) as variables; name credentials with --secrets to store them as secrets instead',
    )
    .option('--secrets <names>', 'store these names as secrets (comma-separated)', collectList, [])
    .option('--select', 'choose secret, variable or exclude for each entry in a terminal')
    .option('--overwrite', 'replace a name that already exists as the same kind')
    .option('-y, --yes', 'skip the confirmation in a terminal')
    .action(async (file: string | undefined, o: Omit<ImportOpts, 'vars'>) =>
      importValues(file, { ...o, vars: [] }, 'var'),
    );
}
