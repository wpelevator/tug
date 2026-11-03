import { selectBackups } from './selection.ts';
import { withProgress } from '../cli-progress.ts';
import type { Command } from 'commander';
import { backupCheckProblems } from '../backup-check.ts';
import { collect, loadCfg, print, readStdin, request } from './context.ts';

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
}
interface BackupListing {
  destinationConfigured: boolean;
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
const formatBytes = (bytes: number | null): string =>
  bytes === null
    ? '-'
    : bytes < 1024 ** 2
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
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
    .action(async (targets: string[], o: { wait: boolean; timeout: string; select?: boolean }) => {
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
        for (const run of queued.runs) console.log(`queued ${run.target} as ${run.runId}`);
        let failed = queued.errors.length > 0;
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
                const ok = run.state === 'succeeded';
                failed ||= !ok;
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
        if (failed) process.exitCode = 1;
      });
    });
  backup
    .command('list')
    .description('show each backup target with its last success and next run, then recent runs')
    .option('--limit <n>', 'number of recent runs to show', '20')
    .option(
      '--check',
      'exit nonzero when a target is stale, or its last run failed or was missed, or there is no destination; for cron and monitors',
    )
    .action(async (o: { limit: string; check?: boolean }) => {
      const project = (await loadCfg()).project || 'site';
      const listing = await request<BackupListing>(
        'GET',
        `/api/v1/backups?project=${encodeURIComponent(project)}&limit=${encodeURIComponent(o.limit)}`,
      );
      if (!listing.destinationConfigured)
        console.error('no backup destination is configured; run tug backup destination set');
      if (!listing.targets.length)
        console.log('no backup targets; add x-tug.backup to a database service or volume');
      for (const t of listing.targets)
        console.log(
          `${t.target}\t${t.node ?? '-'}\t${t.schedule}\tlast success ${t.lastSuccessAt ?? 'never'}\tnext ${t.enabled ? t.nextRunAt : 'disabled'}`,
        );
      for (const r of listing.runs)
        console.log(
          `${r.finished_at ?? r.queued_at}\t${r.target}\t${r.trigger}\t${r.state}\t${r.snapshot_id?.slice(0, 8) ?? '-'}\t${formatBytes(r.size_bytes)}${r.error ? `\t${r.error}` : ''}`,
        );
      if (o.check) {
        const problems = backupCheckProblems(listing);
        for (const problem of problems) console.error(`PROBLEM ${problem}`);
        if (problems.length) process.exitCode = 1;
      }
    });
  backup
    .command('password')
    .description(
      "print the project's repository and its password for offline escrow; anyone holding the password and destination credentials can read the project's backups",
    )
    .action(async () => {
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
      'credential variable for the backend, such as AWS_ACCESS_KEY_ID (repeatable); each value is read from the variable of that name in your environment, else from a line on stdin',
      collect,
      [],
    )
    .action(async (url: string, o: { env: string[] }) => {
      const missing = o.env.filter((name) => process.env[name] === undefined);
      const lines = missing.length
        ? (await readStdin()).split(/\r?\n/).filter((line) => line.length > 0)
        : [];
      if (lines.length < missing.length)
        throw new Error(`expected a value on stdin for ${missing.slice(lines.length).join(', ')}`);
      const env = Object.fromEntries(
        o.env.map((name) => [name, process.env[name] ?? lines[missing.indexOf(name)]]),
      );
      console.log(
        JSON.stringify(await request('POST', '/api/v1/backup/destination', { url, env })),
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
