import { selectResource } from './selection.ts';
import type { Command } from 'commander';
import { print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';
import type { CliRuntime } from '../runtime.ts';

export function registerVolume(rt: CliRuntime, program: Command): void {
  const volume = program.command('volume').description("list and remove a project's volumes");
  volume
    .command('list')
    .description('list the volumes of the project and where they live')
    .action(async (o: CommonOpts) =>
      print(
        rt,
        await request(rt, 'GET', `/api/v1/volumes?project=${encodeURIComponent(projectOf(rt, o))}`),
      ),
    );
  volume
    .command('remove [name]')
    .description('remove a volume from the project')
    .option('--delete-data', 'delete underlying Docker volume data')
    .action(async (name: string, o: CommonOpts & { deleteData?: boolean }) =>
      print(
        rt,
        await request(
          rt,
          'DELETE',
          `/api/v1/volumes/${encodeURIComponent(await selectResource(rt, name, 'volumes'))}?project=${encodeURIComponent(projectOf(rt, o))}&deleteData=${Boolean(o.deleteData)}`,
        ),
      ),
    );
}
