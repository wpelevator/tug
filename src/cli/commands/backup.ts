import { selectBackups } from './selection.ts';
import { withProgress } from '../progress.ts';
import type { Command } from 'commander';
import { backupCheckProblems } from '../../backup/check.ts';
import { collectList, loadCfg, print, readEnvValues, request } from './context.ts';

interface BackupRunRecord {
  id: string;
  target: string;
  node_id: string | null;
  trigger: string;
  state: string;
  snapshot_id: string | null;
  size_bytes: number | null;
  added_bytes: number | null;
  finished_at: string | null;
  queued_at: string | null;
  error: string | null;
  /** What the node last said about a queued or running job. */
  phase?: string;
  waitingFor?: string;
}
interface BackupListing {
  destinationConfigured: boolean;
  /** Control's own backup in the destination; null while there is no destination. */
  control?: {
    lastSuccessAt: string | null;
    lastStatus: string | null;
    problem: string | null;
    /** A local path is for development: it is not protection against losing the host. */
    scope?: 'shared' | 'local';
  } | null;
  targets: {
    target: string;
    node: string | null;
    schedule: string;
    enabled: boolean;
    nextRunAt: string;
    lastSuccessAt: string | null;
    lastStatus: string | null;
    problem: string | null;
  }[];
  runs: BackupRunRecord[];
}
export const formatBytes = (bytes: number | null): string =>
  bytes === null
    ? '-'
    : bytes < 1024 ** 2
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
/** `queued behind bkr_…` or `running (uploading)` for a job the node reported on; the plain state otherwise. */
const runState = (run: BackupRunRecord): string =>
  run.phase === 'queued' && run.waitingFor
    ? `queued behind ${run.waitingFor}`
    : run.phase && run.phase !== 'queued' && run.state === 'running'
      ? `running (${run.phase})`
      : run.state;
const BACKUP_TERMINAL = ['succeeded', 'failed', 'missed', 'cancelled'];

export function registerBackup(program: Command): void {
  const backup = program
    .command('backup')
    .description('run and inspect workload backups and set where they go');
  backup
    .command('run [targets...]')
    .description(
      'back up the named services or volumes now, or every backup target of the project; waits and exits nonzero if any backup fails',
    )
    .option('--select', 'choose one or more backup targets instead of backing up all')
    .option('--no-wait', 'return once the backups are queued')
    .option('--timeout <seconds>', 'give up waiting after this many seconds', '3600')
    .action(
      async (
        targets: string[],
        o: { wait: boolean; timeout: string; select?: boolean; json?: boolean },
      ) => {
        if (o.select && targets.length)
          throw new Error('--select cannot be combined with explicit targets');
        if (o.select) targets = await selectBackups();
        return withProgress('Queueing backups', async (progress) => {
          const project = (await loadCfg()).project || 'site';
          const queued = await request<{
            runs: { runId: string; target: string }[];
            errors: string[];
          }>('POST', '/api/v1/backups/run', {
            project,
            targets: targets.length ? targets : undefined,
          });
          for (const message of queued.errors) console.error(message);
          if (!o.json)
            for (const run of queued.runs) console.log(`queued ${run.target} as ${run.runId}`);
          let failed = queued.errors.length > 0;
          // With --json the outcome of each run is printed once, at the end.
          const finished: BackupListing['runs'] = [];
          if (o.wait) {
            const deadline = Date.now() + Number(o.timeout) * 1000;
            const pending = new Set(queued.runs.map((run) => run.runId));
            if (pending.size)
              progress.stage(
                `Waiting for backups: ${queued.runs.map((run) => run.target).join(', ')}`,
              );
            const states = new Map<string, string>();
            while (pending.size && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              const listing = await request<BackupListing>(
                'GET',
                `/api/v1/backups?project=${encodeURIComponent(project)}&limit=200`,
              );
              for (const run of listing.runs) {
                if (pending.has(run.id)) states.set(run.id, `${run.target}: ${run.state}`);
                if (pending.has(run.id) && BACKUP_TERMINAL.includes(run.state)) {
                  pending.delete(run.id);
                  finished.push(run);
                  const ok = run.state === 'succeeded';
                  failed ||= !ok;
                  if (!o.json)
                    console.log(
                      ok
                        ? `${run.target}: snapshot ${run.snapshot_id?.slice(0, 8)}, ${formatBytes(run.added_bytes)} added`
                        : `${run.target}: ${run.state}${run.error ? ` (${run.error})` : ''}`,
                    );
                }
              }
              if (pending.size)
                progress.stage(
                  `Backups: ${[...pending].map((id) => states.get(id) ?? id).join(', ')}`,
                );
            }
            if (pending.size) {
              console.error(
                `timed out waiting for ${pending.size} backup(s); they keep running on the node`,
              );
              failed = true;
            }
          }
          if (o.json)
            print({
              ok: !failed,
              queued: queued.runs,
              errors: queued.errors,
              ...(o.wait ? { finished } : {}),
            });
          if (failed) process.exitCode = 1;
        });
      },
    );
  backup
    .command('list')
    .description('show each backup target with its last success and next run, then recent runs')
    .option('--limit <n>', 'number of recent runs to show', '20')
    .option(
      '--check',
      'exit nonzero when a target is stale, or its last run failed or was missed, or nothing is protected (no destination, or no enabled target); for cron and monitors',
    )
    .option(
      '--allow-empty',
      'with --check, accept a project that has no enabled backup target (a destination is still required)',
    )
    .action(async (o: { limit: string; check?: boolean; allowEmpty?: boolean; json?: boolean }) => {
      const project = (await loadCfg()).project || 'site';
      const listing = await request<BackupListing>(
        'GET',
        `/api/v1/backups?project=${encodeURIComponent(project)}&limit=${encodeURIComponent(o.limit)}`,
      );
      if (!listing.destinationConfigured)
        console.error('no backup destination is configured; run tug backup destination set');
      if (o.json) print(listing);
      else if (!listing.targets.length)
        console.log('no backup targets; add x-tug.backup to a database service or volume');
      if (!o.json && listing.control)
        console.log(
          `control\t-\tnightly\tlast success ${listing.control.lastSuccessAt ?? 'never'}${listing.control.scope === 'local' ? '\tlocal path only: not off-host' : ''}${listing.control.problem ? `\t${listing.control.problem}` : ''}`,
        );
      if (!o.json)
        for (const t of listing.targets)
          console.log(
            `${t.target}\t${t.node ?? '-'}\t${t.schedule}\tlast success ${t.lastSuccessAt ?? 'never'}\tnext ${t.enabled ? t.nextRunAt : 'disabled'}`,
          );
      if (!o.json)
        for (const r of listing.runs)
          console.log(
            `${r.finished_at ?? r.queued_at}\t${r.target}\t${r.trigger}\t${runState(r)}\t${r.snapshot_id?.slice(0, 8) ?? '-'}\t${formatBytes(r.size_bytes)}\t${r.id}${r.error ? `\t${r.error}` : ''}`,
          );
      if (o.check) {
        const problems = backupCheckProblems(listing, {
          requireProtection: true,
          allowEmpty: o.allowEmpty,
        });
        for (const problem of problems) console.error(`PROBLEM ${problem}`);
        if (problems.length) process.exitCode = 1;
      }
    });
  backup
    .command('cancel <run>')
    .description(
      'stop a queued or running backup (the run id is the last column of `tug backup list`); it is reported as cancelled and not retried',
    )
    .action(async (run: string) => {
      const project = (await loadCfg()).project || 'site';
      print(
        await request('POST', `/api/v1/backups/${encodeURIComponent(run)}/cancel`, { project }),
      );
    });
  backup
    .command('password')
    .description(
      "print the project's repository and its password for offline escrow; anyone holding the password and destination credentials can read the project's backups. With --control it prints control's own repository and password instead",
    )
    .option(
      '--control',
      "print the control-plane repository and its password: the one value to keep off the server besides the destination credentials, because the control backup restores the master key every project's password derives from",
    )
    .action(async (o: { control?: boolean }) => {
      if (o.control)
        return print(await request('GET', '/api/v1/backup/repository-password?control=1'));
      const project = (await loadCfg()).project || 'site';
      print(
        await request(
          'GET',
          `/api/v1/backup/repository-password?project=${encodeURIComponent(project)}`,
        ),
      );
    });

  const destination = backup
    .command('destination')
    .description('set, show or remove where backups go');
  destination
    .command('set <url>')
    .description(
      'set where backups go, such as s3:https://s3.example.com/bucket/tug-backups; credentials are stored encrypted on control',
    )
    .option(
      '--env <name>',
      'credential variable for the backend, such as AWS_ACCESS_KEY_ID (repeat or comma-separate for several); each value is read from the variable of that name in your environment, else from a line on stdin',
      collectList,
      [],
    )
    .action(async (url: string, o: { env: string[] }) => {
      const env = await readEnvValues(o.env);
      console.log(
        JSON.stringify(await request('POST', '/api/v1/backup/destination', { url, env })),
      );
      console.error(
        'Control now backs itself up here every night. Keep its password with these credentials: tug backup password --control',
      );
    });
  destination
    .command('show')
    .description(
      'show the backup destination and the names of its credential variables, never values',
    )
    .action(async () => print(await request('GET', '/api/v1/backup/destination')));
  destination
    .command('remove')
    .description(
      'remove the backup destination and its stored credentials; existing backups stay in the repository',
    )
    .action(async () =>
      console.log(JSON.stringify(await request('DELETE', '/api/v1/backup/destination'))),
    );
}
