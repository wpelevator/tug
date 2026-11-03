import { selectHolds } from './selection.ts';
import type { Command } from 'commander';
import { print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';

export function registerHold(program: Command): void {
  const hold = program
    .command('hold')
    .description('services a deploy stopped because their data moved to another node');
  hold
    .command('release [services...]')
    .description(
      'start the services that `tug deploy --move` held, without restoring (all of them when none is named); a restore releases its own holds',
    )
    .option('--select', 'choose one or more move holds instead of releasing all')
    .action(async (services: string[], o: CommonOpts & { select?: boolean }) => {
      if (o.select && services.length)
        throw new Error('--select cannot be combined with explicit services');
      if (o.select) services = await selectHolds();
      return print(
        await request('POST', '/api/v1/holds/release', {
          project: await projectOf(o),
          services,
        }),
      );
    });
}
