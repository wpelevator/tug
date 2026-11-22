/**
 * Retention as `GET /api/v1/backups` reports it for a target, or for control's own backup: the newest outcome of
 * `restic forget` and the length of its failing streak. Pruning belongs to the weekly maintenance, see `VerifyRecord`.
 */
export interface RetentionStatus {
  state: 'ok' | 'failed' | 'external';
  message?: string;
  /** Consecutive runs, newest first, whose retention failed; 0 unless `state` is `failed`. */
  failures: number;
  /** The newest failure was restic's lock exit code. */
  locked?: boolean;
}

/**
 * The last weekly maintenance (prune and `restic check`) or `backup verify` of a repository, as `GET /api/v1/backups`
 * reports it. It belongs to the destination and is dropped with it.
 */
export interface VerifyRecord {
  startedAt: string;
  finishedAt: string;
  trigger: 'schedule' | 'manual';
  node?: string;
  /** True when both the prune (if it ran) and the check passed. */
  ok: boolean;
  prune: 'ok' | 'skipped' | 'failed';
  check: 'ok' | 'failed';
  /** restic's closing words for whichever step failed. */
  message?: string;
  locked?: boolean;
  subset?: string;
  /** A job that failed before it could report (the node was away, restic stalled). */
  error?: string;
  /** Consecutive maintenance runs of this repository that failed; 0 when this one passed. */
  failures: number;
  /**
   * The failure may be an overlap, not a fault: restic's lock exit code (another node holds a shared lock while a
   * prune wants the exclusive one), a node that did not answer, or a timeout. Such a failure needs a second one in a
   * row to count; any other (restic found a problem in the repository) counts at once.
   */
  transient?: boolean;
}

/** Failures in a row that turn a transient maintenance failure into a problem. */
export const MAINTENANCE_STRIKES = 2;
/** A repository whose last maintenance is older than this is reported, whatever it found: nothing is verifying it. */
export const MAINTENANCE_STALE_MS = 14 * 24 * 3_600_000;

/** Whether a maintenance record is a failure that must be reported: not an overlap that a retry may clear. */
export function verifyFailing(
  verify: Pick<VerifyRecord, 'ok' | 'failures' | 'transient'> | null | undefined,
): boolean {
  if (!verify || verify.ok) return false;
  return !verify.transient || verify.failures >= MAINTENANCE_STRIKES;
}

/** The part of `GET /api/v1/backups` that `tug backup list --check` judges. */
export interface BackupCheckInput {
  destinationConfigured: boolean;
  targets: {
    target: string;
    enabled: boolean;
    problem?: string | null;
    retention?: RetentionStatus | null;
  }[];
  /** The project repository's last maintenance; absent until one ran. */
  verify?: VerifyRecord | null;
  control?: {
    problem: string | null;
    retention?: RetentionStatus | null;
    verify?: VerifyRecord | null;
  } | null;
}

/**
 * A repository whose last `restic check` or prune failed and no later maintenance has cleared, or that nothing has
 * maintained for `MAINTENANCE_STALE_MS` (the weekly job skips a project with no online node, every attempt silently).
 */
export function verifyProblem(
  verify: VerifyRecord | null | undefined,
  at: number = Date.now(),
): string | null {
  if (!verify) return null;
  if (verifyFailing(verify)) {
    const why = verify.message ?? verify.error;
    return `the last repository check or prune failed (${verify.finishedAt})${verify.failures > 1 ? `, ${verify.failures} times in a row` : ''}${why ? `: ${why}` : ''}`;
  }
  const finished = Date.parse(verify.finishedAt);
  if (!Number.isNaN(finished) && at - finished > MAINTENANCE_STALE_MS)
    return `the repository was last checked ${verify.finishedAt}, more than 14 days ago; the weekly maintenance needs an online node that runs this project's backups`;
  return null;
}

/**
 * Retention failures that must fail a monitor: two in a row, or one that was a lock failure. A single failure is
 * often only an overlap: on a project with several nodes a prune takes an exclusive lock on the shared repository
 * while another node's backup holds a shared one. A run whose retention works clears it, so a recovery turns it green.
 */
export const RETENTION_STRIKES = 2;
export function retentionProblem(
  retention: RetentionStatus | null | undefined,
  unlock = 'tug backup unlock',
): string | null {
  if (retention?.state !== 'failed') return null;
  if (!retention.locked && retention.failures < RETENTION_STRIKES) return null;
  const why = retention.locked
    ? `the repository is locked, run ${unlock} to remove stale locks`
    : `it failed in ${retention.failures} runs in a row`;
  return `retention is failing, so old snapshots are not removed (${why})${retention.message ? `: ${retention.message}` : ''}`;
}

export interface BackupCheckOptions {
  /**
   * Treat an unprotected project as a problem: no destination at all, or (unless `allowEmpty`) no enabled
   * target. `backup list --check` sets this so a monitor cannot stay green before protection is configured;
   * views that summarize many projects leave it off, since a stateless project is not a fault.
   */
  requireProtection?: boolean;
  /** With `requireProtection`, accept a project with no enabled target (a stateless project) as long as a destination exists. */
  allowEmpty?: boolean;
  /** The current time, for tests. */
  now?: number;
}

export const NO_DESTINATION = 'no backup destination is configured';
export const NO_TARGETS =
  'no enabled backup targets; add x-tug.backup to a service or volume, or pass --allow-empty for a project without data';

/** What a monitor should be told: one line per problem, empty when every backup target is healthy. */
export function backupCheckProblems(
  listing: BackupCheckInput,
  options: BackupCheckOptions = {},
): string[] {
  const active = listing.targets.filter((target) => target.enabled);
  const problems = active.flatMap((target) =>
    [target.problem, retentionProblem(target.retention)]
      .filter((problem): problem is string => Boolean(problem))
      .map((problem) => `${target.target}: ${problem}`),
  );
  if (!listing.destinationConfigured && (active.length || options.requireProtection))
    problems.unshift(NO_DESTINATION);
  if (options.requireProtection && !options.allowEmpty && !active.length) problems.push(NO_TARGETS);
  const at = options.now ?? Date.now();
  const repository = verifyProblem(listing.verify, at);
  if (repository && active.length) problems.push(repository);
  const controlVerify = verifyProblem(listing.control?.verify, at);
  if (controlVerify) problems.push(`control: ${controlVerify}`);
  if (listing.control?.problem) problems.push(`control: ${listing.control.problem}`);
  const controlRetention = retentionProblem(
    listing.control?.retention,
    'tug backup unlock --control',
  );
  if (controlRetention) problems.push(`control: ${controlRetention}`);
  return problems;
}
