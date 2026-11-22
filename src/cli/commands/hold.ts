import { selectHolds } from './selection.ts';
import type { Command } from 'commander';
import { print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';
import type { CliRuntime } from '../runtime.ts';

export function registerHold(rt: CliRuntime, program: Command): void {
  const hold = program
    .command('hold')
    .description(
      'services a deploy stopped: a service held by `tug deploy --hold`, or one that writes to a service whose data moved to another node',
    );
  hold
    .command('release [services...]')
    .description(
      'start services a deploy held, without restoring (all of them when none is named): the ones `tug deploy --hold` stopped, and the writers `--move` stopped. A credential that may deploy releases only `deploy hold` holds; a move hold needs an admin. A restore releases its own holds',
    )
    .option('--select', 'choose one or more move holds instead of releasing all')
    .action(async (services: string[], o: CommonOpts & { select?: boolean }) => {
      if (o.select && services.length)
        throw new Error('--select cannot be combined with explicit services');
      if (o.select) services = await selectHolds(rt);
      return print(
        rt,
        await request(rt, 'POST', '/api/v1/holds/release', {
          project: projectOf(rt, o),
          services,
        }),
      );
    });
}
