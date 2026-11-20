import { selectBackups } from './selection.ts';
import { withProgress } from '../progress.ts';
import type { Command } from 'commander';
import { backupCheckProblems } from '../../backup/check.ts';
import { collectList, loadCfg, print, readEnvValues, request } from './context.ts';
import { out, err } from '../runtime.ts';
import type { CliRuntime } from '../runtime.ts';

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
interface DestinationCheck {
  ok: boolean;
  checkedAt: string;
  from: 'control';
  url: string;
  repositories: {
    name: string;
    repository: string;
    state: 'ok' | 'initialized' | 'error';
    error?: string;
  }[];
}
/** Where the check runs, so a pass is not read as proof that every node can reach the destination. */
const CHECK_SCOPE =
  'Checked from the control host; each node connects to the destination at its first backup.';
/** Says why a failed check failed, one repository per line, on stderr. */
function reportFailedCheck(rt: CliRuntime, check: DestinationCheck, saved: boolean): void {
  err(
    rt,
    saved
      ? `The destination was saved but is not usable yet: ${check.repositories.filter((r) => r.state === 'error').length} repository check(s) failed.`
      : `The destination check failed for ${check.repositories.filter((r) => r.state === 'error').length} repository(ies).`,
  );
  for (const repository of check.repositories)
    if (repository.state === 'error')
      err(rt, `  ${repository.name} (${repository.repository}): ${repository.error ?? 'failed'}`);
}
const checkDestination = (rt: CliRuntime): Promise<DestinationCheck> =>
  withProgress(rt, 'Checking the backup destination', () =>
    request<DestinationCheck>(rt, 'POST', '/api/v1/backup/destination/check', {}),
  );
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

export function registerBackup(rt: CliRuntime, program: Command): void {
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
        if (o.select) targets = await selectBackups(rt);
        return withProgress(rt, 'Queueing backups', async (progress) => {
          const project = loadCfg(rt).project || 'site';
          const queued = await request<{
            runs: { runId: string; target: string }[];
            errors: string[];
          }>(rt, 'POST', '/api/v1/backups/run', {
            project,
            targets: targets.length ? targets : undefined,
          });
          for (const message of queued.errors) err(rt, message);
          if (!o.json)
            for (const run of queued.runs) out(rt, `queued ${run.target} as ${run.runId}`);
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
                rt,
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
                    out(
                      rt,
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
              err(
                rt,
                `timed out waiting for ${pending.size} backup(s); they keep running on the node`,
              );
              failed = true;
            }
          }
          if (o.json)
            print(rt, {
              ok: !failed,
              queued: queued.runs,
              errors: queued.errors,
              ...(o.wait ? { finished } : {}),
            });
          if (failed) rt.exitCode = 1;
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
      const project = loadCfg(rt).project || 'site';
      const listing = await request<BackupListing>(
        rt,
        'GET',
        `/api/v1/backups?project=${encodeURIComponent(project)}&limit=${encodeURIComponent(o.limit)}`,
      );
      if (!listing.destinationConfigured)
        err(rt, 'no backup destination is configured; run tug backup destination set');
      if (o.json) print(rt, listing);
      else if (!listing.targets.length)
        out(rt, 'no backup targets; add x-tug.backup to a database service or volume');
      if (!o.json && listing.control)
        out(
          rt,
          `control\t-\tnightly\tlast success ${listing.control.lastSuccessAt ?? 'never'}${listing.control.scope === 'local' ? '\tlocal path only: not off-host' : ''}${listing.control.problem ? `\t${listing.control.problem}` : ''}`,
        );
      if (!o.json)
        for (const t of listing.targets)
          out(
            rt,
            `${t.target}\t${t.node ?? '-'}\t${t.schedule}\tlast success ${t.lastSuccessAt ?? 'never'}\tnext ${t.enabled ? t.nextRunAt : 'disabled'}`,
          );
      if (!o.json)
        for (const r of listing.runs)
          out(
            rt,
            `${r.finished_at ?? r.queued_at}\t${r.target}\t${r.trigger}\t${runState(r)}\t${r.snapshot_id?.slice(0, 8) ?? '-'}\t${formatBytes(r.size_bytes)}\t${r.id}${r.error ? `\t${r.error}` : ''}`,
          );
      if (o.check) {
        const problems = backupCheckProblems(listing, {
          requireProtection: true,
          allowEmpty: o.allowEmpty,
        });
        for (const problem of problems) err(rt, `PROBLEM ${problem}`);
        if (problems.length) rt.exitCode = 1;
      }
    });
  backup
    .command('cancel <run>')
    .description(
      'stop a queued or running backup (the run id is the last column of `tug backup list`); it is reported as cancelled and not retried',
    )
    .action(async (run: string) => {
      const project = loadCfg(rt).project || 'site';
      print(
        rt,
        await request(rt, 'POST', `/api/v1/backups/${encodeURIComponent(run)}/cancel`, { project }),
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
        return print(rt, await request(rt, 'GET', '/api/v1/backup/repository-password?control=1'));
      const project = loadCfg(rt).project || 'site';
      const result = await request<{ deployed?: boolean }>(
        rt,
        'GET',
        `/api/v1/backup/repository-password?project=${encodeURIComponent(project)}`,
      );
      print(rt, result);
      if (result.deployed === false)
        err(
          rt,
          `project ${project} has not been deployed yet: check the project name, because the password is derived from it`,
        );
    });

  const destination = backup
    .command('destination')
    .description('set, show or remove where backups go');
  destination
    .command('set <url>')
    .description(
      'set where backups go, such as s3:https://s3.example.com/bucket/tug-backups, rest:http://backup.internal:8000/tug or b2:bucket:tug; credentials are stored encrypted on control. Then checks the destination from the control host (creating missing repositories); nodes connect at their first backup. Exits nonzero when the check fails; --no-check skips it',
    )
    .option(
      '--env <name>',
      'credential variable for the backend, such as AWS_ACCESS_KEY_ID (repeat or comma-separate for several); each value is read from the variable of that name in your environment, else from a line on stdin',
      collectList,
      [],
    )
    .option('--no-check', 'save the destination without checking it')
    .action(async (url: string, o: { env: string[]; check: boolean }) => {
      const env = await readEnvValues(rt, o.env);
      const saved = await request<Record<string, unknown>>(
        rt,
        'POST',
        '/api/v1/backup/destination',
        { url, env },
      );
      const check = o.check ? await checkDestination(rt) : undefined;
      // One JSON document, so scripts that parse the output of `set` keep working.
      out(rt, JSON.stringify(check ? { ...saved, check } : saved));
      err(
        rt,
        'Control now backs itself up here every night. Keep its password with these credentials: tug backup password --control',
      );
      if (check) {
        err(rt, CHECK_SCOPE);
        if (!check.ok) {
          reportFailedCheck(rt, check, true);
          rt.exitCode = 1;
        }
      }
    });
  destination
    .command('check')
    .description(
      'check the destination from the control host: open the control repository and the repository of every project with a backup target, and create the ones that do not exist yet (which also proves write access). Exits nonzero when any repository cannot be used. Nodes connect to the destination at their first backup, so this does not prove every node can reach it',
    )
    .action(async () => {
      const check = await checkDestination(rt);
      print(rt, check);
      err(rt, CHECK_SCOPE);
      if (!check.ok) {
        reportFailedCheck(rt, check, false);
        rt.exitCode = 1;
      }
    });
  destination
    .command('show')
    .description(
      'show the backup destination and the names of its credential variables, never values',
    )
    .action(async () => print(rt, await request(rt, 'GET', '/api/v1/backup/destination')));
  destination
    .command('remove')
    .description(
      'remove the backup destination and its stored credentials; existing backups stay in the repository',
    )
    .action(async () =>
      out(rt, JSON.stringify(await request(rt, 'DELETE', '/api/v1/backup/destination'))),
    );
}
