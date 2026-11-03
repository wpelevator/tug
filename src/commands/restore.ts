import { selectMany } from '../cli-selection.ts';
import { selectBackup, selectRestore, selectSnapshot, serviceChoices } from './selection.ts';
import type { Command } from 'commander';
import { collect, loadCfg, request } from './context.ts';

interface RestorePlanView {
  target: string;
  node: string;
  snapshotId: string;
  snapshotTime: string | null;
  mode: string;
  scratchVolume?: string;
  writers: string[];
  safetyBackup: boolean;
}
interface RestoreRecord {
  id: string;
  target: string;
  state: string;
  mode: string;
  snapshot_id: string;
  scratch_volume: string | null;
  error: string | null;
  started_at: string | null;
}

export function registerRestore(program: Command): void {
  const restore = program
    .command('restore')
    .description('restore services and volumes from backups');
  restore
    .command('run [target]')
    .description(
      'restore a service or volume from a backup. Without --confirm it only prints the plan. An in-place restore locks the project, stops the services that write to the target, takes a safety backup, restores, then starts them again',
    )
    .option('--select-snapshot', 'choose a successful backup from the catalog')
    .option('--select-writers', 'choose services to stop instead of discovering writers')
    .option('--from <id>', 'backup run id, restic snapshot id, or latest', 'latest')
    .option(
      '--scratch',
      'restore a volume into a new volume next to the live one, touching nothing live',
    )
    .option(
      '--no-safety-backup',
      'skip the backup of the current data taken before an in-place restore',
    )
    .option(
      '--writers <service>',
      'service to stop during the restore, instead of discovering them (repeatable)',
      collect,
      [],
    )
    .option('--no-writers', 'restore without stopping any service')
    .option('--confirm', 'perform the restore')
    .option('--timeout <seconds>', 'give up waiting after this many seconds', '3600')
    .action(
      async (
        target: string,
        o: {
          from: string;
          selectSnapshot?: boolean;
          selectWriters?: boolean;
          scratch?: boolean;
          safetyBackup: boolean;
          writers: string[] | false;
          confirm?: boolean;
          timeout: string;
        },
        command: Command,
      ) => {
        if (o.selectSnapshot && command.getOptionValueSource('from') === 'cli')
          throw new Error('--select-snapshot cannot be combined with --from');
        if (o.selectWriters && (o.writers === false || o.writers.length))
          throw new Error('--select-writers cannot be combined with --writers or --no-writers');
        if (o.scratch && o.selectWriters)
          throw new Error('--select-writers does not apply to scratch restores');
        target = await selectBackup(target);
        if (o.selectSnapshot) o.from = await selectSnapshot(target);
        if (o.selectWriters)
          o.writers = await selectMany('Select services to stop for the restore', serviceChoices);
        const project = (await loadCfg()).project || 'site';
        const explicit = Array.isArray(o.writers) && o.writers.length > 0 ? o.writers : undefined;
        const result = await request<{
          confirmed: boolean;
          plan: RestorePlanView;
          restoreId?: string;
        }>('POST', '/api/v1/restores', {
          project,
          target,
          from: o.from,
          scratch: o.scratch === true,
          safetyBackup: o.safetyBackup,
          writers: explicit,
          noWriters: o.writers === false,
          confirm: o.confirm === true,
        });
        const plan = result.plan;
        console.log(`target:   ${plan.target} on ${plan.node}`);
        console.log(
          `snapshot: ${plan.snapshotId}${plan.snapshotTime ? ` (${plan.snapshotTime})` : ''}`,
        );
        console.log(
          `mode:     ${plan.mode}${plan.scratchVolume ? ` into new volume ${plan.scratchVolume}` : ''}`,
        );
        if (plan.mode === 'in-place') {
          console.log(`stops:    ${plan.writers.length ? plan.writers.join(', ') : 'nothing'}`);
          console.log(
            `safety:   ${plan.safetyBackup ? 'a backup of the current data is taken first' : 'none (--no-safety-backup)'}`,
          );
        }
        if (!result.confirmed) {
          console.log('\nNothing was changed. Run again with --confirm to restore.');
          return;
        }
        const deadline = Date.now() + Number(o.timeout) * 1000;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const { restores } = await request<{ restores: RestoreRecord[] }>(
            'GET',
            `/api/v1/restores?project=${encodeURIComponent(project)}`,
          );
          const record = restores.find((item) => item.id === result.restoreId);
          if (record?.state === 'succeeded') {
            if (record.error) console.error(`warning: ${record.error}`);
            console.log(
              `restore ${record.id} completed${record.scratch_volume ? `; files are in volume ${record.scratch_volume}` : ''}`,
            );
            return;
          }
          if (record && ['failed', 'interrupted', 'released'].includes(record.state)) {
            console.error(`restore ${record.id} ${record.state}: ${record.error ?? ''}`);
            if (record.state === 'interrupted')
              console.error(
                `the services stay stopped; run tug restore resume ${record.id} to try again or tug restore release ${record.id} to start them (data may be partly restored)`,
              );
            process.exitCode = 1;
            return;
          }
          if (Date.now() > deadline) {
            console.error(
              `timed out waiting; restore ${result.restoreId} continues on control (tug restore list)`,
            );
            process.exitCode = 1;
            return;
          }
        }
      },
    );
  restore
    .command('list')
    .description('show recent restores and their state')
    .action(async () => {
      const project = (await loadCfg()).project || 'site';
      const { restores } = await request<{ restores: RestoreRecord[] }>(
        'GET',
        `/api/v1/restores?project=${encodeURIComponent(project)}`,
      );
      if (!restores.length) console.log('no restores');
      for (const r of restores)
        console.log(
          `${r.started_at}\t${r.id}\t${r.target}\t${r.mode}\t${r.state}\t${r.snapshot_id.slice(0, 8)}${r.error ? `\t${r.error}` : ''}`,
        );
    });
  restore
    .command('resume [id]')
    .description('run an interrupted restore again; the stopped services stay stopped meanwhile')
    .action(async (id: string) =>
      console.log(
        JSON.stringify(
          await request(
            'POST',
            `/api/v1/restores/${encodeURIComponent(await selectRestore(id))}/resume`,
          ),
        ),
      ),
    );
  restore
    .command('release [id]')
    .description(
      'start the services an interrupted restore stopped and unlock the project; the data may be partly restored',
    )
    .action(async (id: string) =>
      console.log(
        JSON.stringify(
          await request(
            'POST',
            `/api/v1/restores/${encodeURIComponent(await selectRestore(id))}/release`,
          ),
        ),
      ),
    );
}
