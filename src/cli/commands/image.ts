import type { Command } from 'commander';
import { print, request } from './context.ts';
import type { CliRuntime } from '../runtime.ts';

export function registerImage(rt: CliRuntime, program: Command): void {
  const image = program.command('image').description('manage the build archives kept on control');
  image
    .command('prune')
    .description(
      'delete build archives that rollback no longer needs: all but the newest N distinct builds of each project, the current one and any version a node still runs',
    )
    .option('--keep <n>', 'distinct builds per project whose archives are kept', '5')
    .option('--dry-run', 'list what would be deleted without deleting it')
    .action(async (o: { keep: string; dryRun?: boolean }) =>
      print(
        rt,
        await request(rt, 'POST', '/api/v1/images/prune', {
          keep: Number(o.keep),
          dryRun: Boolean(o.dryRun),
        }),
      ),
    );
}
