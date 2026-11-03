import type { Command } from 'commander';
import { print, request } from './context.ts';

export function registerImage(program: Command): void {
  const image = program.command('image').description('manage the build archives kept on control');
  image
    .command('prune')
    .description(
      'delete build archives that rollback no longer needs: all but the newest N deployments of each project, the current one and any version a node still runs',
    )
    .option('--keep <n>', 'deployments per project whose archives are kept', '5')
    .option('--dry-run', 'list what would be deleted without deleting it')
    .action(async (o: { keep: string; dryRun?: boolean }) =>
      print(
        await request('POST', '/api/v1/images/prune', {
          keep: Number(o.keep),
          dryRun: Boolean(o.dryRun),
        }),
      ),
    );
}
