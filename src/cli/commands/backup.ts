import { selectBackups } from './selection.ts';
import { withProgress } from '../progress.ts';
import { Option } from 'commander';
import type { Command } from 'commander';
import { backupCheckProblems } from '../../backup/check.ts';
import type { RetentionInput } from '../../backup/check.ts';
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
/** The last weekly maintenance or `backup verify` of a repository. */
interface VerifyRecord {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  prune: 'ok' | 'skipped' | 'failed';
  check: 'ok' | 'failed';
  subset?: string;
  message?: string;
  error?: string;
  trigger: 'schedule' | 'manual';
}
interface BackupListing {
  destinationConfigured: boolean;
  /** The project repository's last maintenance; null before one ran. */
  verify?: VerifyRecord | null;
  maintenanceRunning?: boolean;
  /** Control's own backup in the destination; null while there is no destination. */
  control?: {
    lastSuccessAt: string | null;
    lastStatus: string | null;
    problem: string | null;
    /** A local path is for development: it is not protection against losing the host. */
    scope?: 'shared' | 'local';
    retention?: RetentionInput | null;
    lock?: { message?: string } | null;
    verify?: VerifyRecord | null;
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
    retention?: RetentionInput | null;
    lock?: { message?: string } | null;
    /** `off-host`, `verified` or `restore-tested`; null when nothing is off-host. */
    protection?: 'off-host' | 'verified' | 'restore-tested' | null;
  }[];
  runs: BackupRunRecord[];
}
/** `retention ok`, `retention failed (2 runs)`, `retention external` or nothing before a run applied it; with the lock state. */
export function retentionColumns(item: {
  retention?: RetentionInput | null;
  lock?: { message?: string } | null;
}): string {
  const retention = item.retention
    ? item.retention.state === 'failed'
      ? `\tretention failed (${item.retention.failures} run${item.retention.failures === 1 ? '' : 's'}${item.retention.locked ? ', locked' : ''})`
      : `\tretention ${item.retention.state}`
    : '';
  return `${retention}${item.lock ? '\tREPOSITORY LOCKED' : ''}`;
}
/** `verify ok (check 2026-11-01, subset 5%)`, `verify FAILED` or nothing before a repository was checked. */
export function verifyColumn(verify: VerifyRecord | null | undefined): string {
  if (!verify) return '';
  const when = verify.finishedAt.slice(0, 10);
  const detail = [
    verify.prune === 'ok' ? 'pruned' : '',
    verify.subset ? `subset ${verify.subset}` : '',
    verify.trigger === 'manual' ? 'manual' : '',
  ].filter(Boolean);
  return verify.ok
    ? `\tverify ok (${when}${detail.length ? `, ${detail.join(', ')}` : ''})`
    : `\tverify FAILED (${when})`;
}
interface DestinationCheck {
  checkId: string;
  state: 'running' | 'done';
  /** Set once the check is done. */
  ok?: boolean;
  checkedAt?: string;
  from: 'control';
  url: string;
  repositories: {
    name: string;
    repository: string;
    state: 'ok' | 'initialized' | 'error' | 'skipped';
    error?: string;
  }[];
  /** What each node that runs a project's backups saw; absent from a check that predates node checks. */
  nodes?: {
    project: string;
    node: string;
    state: 'ok' | 'missing' | 'error' | 'offline' | 'timeout' | 'pending';
    error?: string;
  }[];
  /** Why the check stopped before every part answered, such as a control restart. */
  error?: string;
  /** Who prunes the destination; absent from a check made by an older control. */
  retention?: 'managed' | 'external';
}
const CHECK_POLL_MS = 2000;
const CHECK_DEADLINE_MS = 10 * 60_000;
/** Where each part ran, so a pass is not read as more than it proves. */
function checkScope(check: DestinationCheck): string {
  return check.nodes?.length
    ? "Control's own repository was checked from the control host; each project repository from the node that runs its backups."
    : 'Checked from the control host only: no node has an enabled backup target yet, and a node connects to the destination at its first backup.';
}
/** One line per repository and per node on stderr, saying what the state means for the operator. */
function reportCheck(rt: CliRuntime, check: DestinationCheck): void {
  const host = "from control's host: ";
  for (const r of check.repositories) {
    if (r.state === 'ok') err(rt, `${host}ok: ${r.name} (${r.repository})`);
    else if (r.state === 'initialized')
      err(
        rt,
        `${host}created a new, empty repository at ${r.repository} (${r.name}); if backups should already be there, the destination path is wrong`,
      );
    else if (r.state === 'skipped')
      err(rt, `${host}skipped: ${r.name}: ${r.error ?? 'not checked'}`);
    else {
      err(rt, `${host}failed: ${r.name} (${r.repository}): ${r.error ?? 'failed'}`);
      if (r.name === '_control') err(rt, "  control's own nightly backup will fail");
    }
  }
  for (const n of check.nodes ?? []) {
    const who = `node ${n.node} (project ${n.project}): `;
    err(
      rt,
      who +
        (n.state === 'ok'
          ? 'reaches the destination'
          : n.state === 'missing'
            ? 'repository not created yet; the first backup creates it'
            : n.state === 'error'
              ? `cannot reach the destination: ${n.error ?? 'the check failed'}`
              : n.state === 'offline'
                ? `offline${n.error ? ` (${n.error})` : ''}; not checked`
                : n.state === 'timeout'
                  ? (n.error ?? 'did not answer in time')
                  : 'not answered yet'),
    );
  }
  if (check.error) err(rt, `the check stopped early: ${check.error}`);
  if (check.retention === 'external')
    err(
      rt,
      'retention: external. tug never prunes this destination, so pruning from the storage side is yours to do. This check does not test delete permission.',
    );
  else if (check.retention)
    err(
      rt,
      'retention: managed. tug prunes with restic forget --prune after each backup; an append-only destination refuses that, and a retention failure then shows in tug backup list --check. For an append-only destination run tug backup destination set <url> --retention external. This check does not test delete permission.',
    );
  err(rt, checkScope(check));
}
/** What failed, for the warning after `destination set`. */
const failedNames = (check: DestinationCheck): string =>
  [
    ...check.repositories.filter((r) => r.state === 'error').map((r) => r.name),
    ...(check.nodes ?? [])
      .filter((n) => ['error', 'offline', 'timeout'].includes(n.state))
      .map((n) => `node ${n.node} (project ${n.project})`),
  ].join(', ');
/**
 * Starts a check and polls the stored result until it is done. Control answers the start at once because probing
 * every repository and asking every node takes longer than one HTTP request may. When `TUG_CHECK_TIMEOUT_MS` (default
 * 10 minutes) passes first, `finished` is false and `check` is the latest partial result.
 */
/** Consecutive failed polls tolerated (about 30 s at the default interval) before the CLI gives up. */
const CHECK_POLL_RETRIES = 15;
async function checkDestination(
  rt: CliRuntime,
): Promise<{ check: DestinationCheck; finished: boolean }> {
  const pollMs = Number(rt.env.TUG_CHECK_POLL_MS) || CHECK_POLL_MS;
  const deadline = Date.now() + (Number(rt.env.TUG_CHECK_TIMEOUT_MS) || CHECK_DEADLINE_MS);
  return withProgress(rt, 'Checking the backup destination', async (progress) => {
    const { checkId } = await request<{ checkId: string }>(
      rt,
      'POST',
      '/api/v1/backup/destination/check',
      {},
    );
    let failures = 0;
    for (;;) {
      let shown: { configured: boolean; checkResult?: DestinationCheck | null };
      try {
        shown = await request(rt, 'GET', '/api/v1/backup/destination');
        failures = 0;
      } catch (error) {
        // Control restarting mid-check is brief, and on the way back it marks this check interrupted: keep polling.
        if (++failures > CHECK_POLL_RETRIES || Date.now() + pollMs > deadline) throw error;
        progress.stage('Waiting for control to answer');
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const check = shown.checkResult;
      if (!shown.configured || !check)
        throw new Error('the backup destination was changed while it was being checked');
      if (check.checkId !== checkId)
        throw new Error(
          'another destination check replaced this one; see tug backup destination show',
        );
      if (check.state === 'done') return { check, finished: true };
      const waiting = (check.nodes ?? []).filter((n) => n.state === 'pending');
      progress.stage(
        waiting.length
          ? `Waiting for nodes: ${waiting.map((n) => n.node).join(', ')}`
          : 'Checking the backup destination',
      );
      if (Date.now() + pollMs > deadline) return { check, finished: false };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  });
}
const STILL_RUNNING =
  'the check is still running on control; see its result with tug backup destination show';
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
          const project = loadCfg(rt).project;
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
      'exit nonzero when a target is stale, or its last run failed or was missed, or its retention failed twice in a row or found the repository locked, or the last repository check failed, or nothing is protected (no destination, or no enabled target); for cron and monitors',
    )
    .option(
      '--allow-empty',
      'with --check, accept a project that has no enabled backup target (a destination is still required)',
    )
    .action(async (o: { limit: string; check?: boolean; allowEmpty?: boolean; json?: boolean }) => {
      const project = loadCfg(rt).project;
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
          `control\t-\tnightly\tlast success ${listing.control.lastSuccessAt ?? 'never'}${listing.control.scope === 'local' ? '\tlocal path only: not off-host' : ''}${retentionColumns(listing.control)}${verifyColumn(listing.control.verify)}${listing.control.problem ? `\t${listing.control.problem}` : ''}`,
        );
      if (!o.json && (listing.verify || listing.maintenanceRunning))
        out(
          rt,
          `repository\t-\tweekly\t${listing.maintenanceRunning ? 'maintenance running' : ''}${verifyColumn(listing.verify).replace(/^\t/, '')}${listing.verify && !listing.verify.ok && (listing.verify.message ?? listing.verify.error) ? `\t${listing.verify.message ?? listing.verify.error}` : ''}`,
        );
      if (!o.json)
        for (const t of listing.targets)
          out(
            rt,
            `${t.target}\t${t.node ?? '-'}\t${t.schedule}\tlast success ${t.lastSuccessAt ?? 'never'}\tnext ${t.enabled ? t.nextRunAt : 'disabled'}${t.protection ? `\t${t.protection}` : ''}${retentionColumns(t)}`,
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
      const project = loadCfg(rt).project;
      print(
        rt,
        await request(rt, 'POST', `/api/v1/backups/${encodeURIComponent(run)}/cancel`, { project }),
      );
    });
  backup
    .command('verify')
    .description(
      "check the project's repository now with restic check, in the background; the result shows in `tug backup list`. Control also prunes and checks every repository once a week. Admin only",
    )
    .option(
      '--read-data-subset <subset>',
      'also read part of the stored data to detect corruption: a fraction (1/10), a percentage (5%) or a size (500M); the data is downloaded from the destination',
    )
    .option('--control', "check control's own backup repository instead of the project's")
    .action(async (o: { readDataSubset?: string; control?: boolean }) => {
      const project = loadCfg(rt).project;
      print(
        rt,
        await request(rt, 'POST', '/api/v1/backups/verify', {
          ...(o.control ? { control: true } : { project }),
          ...(o.readDataSubset ? { readDataSubset: o.readDataSubset } : {}),
        }),
      );
    });
  backup
    .command('unlock')
    .description(
      "remove stale restic locks from the project's repository, which is what a run says when it fails with 'the repository is locked'. Only locks that have gone stale are removed (restic's own rule), so a prune running elsewhere keeps its lock; run it again later if locks remain. Admin only",
    )
    .option('--control', "unlock control's own backup repository instead of the project's")
    .action(async (o: { control?: boolean }) => {
      const project = loadCfg(rt).project;
      print(
        rt,
        await request(
          rt,
          'POST',
          '/api/v1/backups/unlock',
          o.control ? { control: true } : { project },
        ),
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
      const project = loadCfg(rt).project;
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
      'set where backups go, such as s3:https://s3.example.com/bucket/tug-backups, rest:http://backup.internal:8000/tug or b2:bucket:tug; credentials are stored encrypted on control. Then checks the destination (see `backup destination check`). A failed check is a warning and the exit code stays 0, since the destination is saved; --no-check skips it',
    )
    .option(
      '--env <name>',
      'credential variable for the backend, such as AWS_ACCESS_KEY_ID (repeat or comma-separate for several); each value is read from the variable of that name in your environment, else from a line on stdin',
      collectList,
      [],
    )
    .addOption(
      new Option(
        '--retention <mode>',
        'who prunes old snapshots: managed (default; tug runs restic forget --prune after each backup) or external (an append-only destination such as rest-server --append-only: tug never prunes, so you prune from the storage side). Setting only this on the destination already in use keeps its credentials; when omitted, the current mode is kept for the same URL',
      ).choices(['managed', 'external']),
    )
    .option('--no-check', 'save the destination without checking it')
    .action(async (url: string, o: { env: string[]; check: boolean; retention?: string }) => {
      // Only the mode for the destination in use: no credentials are sent, so control keeps the stored ones.
      const env = o.env.length || !o.retention ? await readEnvValues(rt, o.env) : undefined;
      const saved = await request<Record<string, unknown>>(
        rt,
        'POST',
        '/api/v1/backup/destination',
        { url, ...(env ? { env } : {}), ...(o.retention ? { retention: o.retention } : {}) },
      );
      // Saving succeeded, so nothing below changes the exit code: a failed or unavailable check is a warning.
      let check: DestinationCheck | undefined;
      let finished = true;
      let unavailable = false;
      if (o.check)
        try {
          ({ check, finished } = await checkDestination(rt));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/destination\/check: 404/.test(message)) throw error;
          unavailable = true;
        }
      // One JSON document, so scripts that parse the output of `set` keep working.
      out(rt, JSON.stringify(check ? { ...saved, check } : saved));
      err(
        rt,
        'Control now backs itself up here every night. Keep its password with these credentials: tug backup password --control',
      );
      if (saved.retention === 'external')
        err(
          rt,
          "retention is external: tug will not prune this destination. You own pruning from the storage side, keeping snapshots tagged trigger:pre-restore, and a failed backup's partial snapshot cannot be cleaned up.",
        );
      if (unavailable)
        err(
          rt,
          'saved; this control is too old to check destinations (it has no destination check), so nothing was verified. Upgrade control to use tug backup destination check',
        );
      if (check && !finished) err(rt, `saved; ${STILL_RUNNING}`);
      else if (check) {
        reportCheck(rt, check);
        if (!check.ok)
          err(
            rt,
            `saved; the check failed for ${failedNames(check) || 'some repositories'}: fix it and run tug backup destination check`,
          );
      }
    });
  destination
    .command('check')
    .description(
      "check that backups can reach the destination: control's own repository from the control host, and each project's repository from the node that runs its backups. Control creates missing repositories (which also proves write access); a node only reports one as not created yet, since its first backup creates it. Exits nonzero when a repository cannot be used or a node is offline, fails or does not answer. Waits up to 10 minutes (TUG_CHECK_TIMEOUT_MS)",
    )
    .action(async () => {
      const { check, finished } = await checkDestination(rt);
      print(rt, check);
      if (!finished) {
        err(rt, STILL_RUNNING);
        rt.exitCode = 1;
        return;
      }
      reportCheck(rt, check);
      if (!check.ok) rt.exitCode = 1;
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
