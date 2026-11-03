import type { Command } from 'commander';
import { print, projectOf, request } from './context.ts';
import type { CommonOpts } from './context.ts';

export function registerVolume(program: Command): void {
  const volume = program.command('volume').description("list and remove a project's volumes");
  volume
    .command('list')
    .description('list the volumes of the project and where they live')
    .action(async (o: CommonOpts) =>
      print(
        await request('GET', `/api/v1/volumes?project=${encodeURIComponent(await projectOf(o))}`),
      ),
    );
  volume
    .command('remove <name>')
    .description('remove a volume from the project')
    .option('--delete-data', 'delete underlying Docker volume data')
    .action(async (name: string, o: CommonOpts & { deleteData?: boolean }) =>
      print(
        await request(
          'DELETE',
          `/api/v1/volumes/${encodeURIComponent(name)}?project=${encodeURIComponent(await projectOf(o))}&deleteData=${Boolean(o.deleteData)}`,
        ),
      ),
    );
}
