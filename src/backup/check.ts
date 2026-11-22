/** Retention as `GET /api/v1/backups` reports it for a target, or for control's own backup. */
export interface RetentionInput {
  state: 'ok' | 'failed' | 'external';
  message?: string;
  /** Consecutive runs whose retention failed. */
  failures: number;
  /** The newest failure was restic's lock exit code. */
  locked?: boolean;
}

/** The part of `GET /api/v1/backups` that `tug backup list --check` judges. */
export interface BackupCheckInput {
  destinationConfigured: boolean;
  targets: {
    target: string;
    enabled: boolean;
    problem?: string | null;
    retention?: RetentionInput | null;
  }[];
  control?: { problem: string | null; retention?: RetentionInput | null } | null;
}

/**
 * Retention failures that must fail a monitor: two in a row, or one that was a lock failure. A single failure is
 * often only an overlap: on a project with several nodes a prune takes an exclusive lock on the shared repository
 * while another node's backup holds a shared one. A run whose retention works clears it, so a recovery turns it green.
 */
export const RETENTION_STRIKES = 2;
export function retentionProblem(
  retention: RetentionInput | null | undefined,
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
  if (listing.control?.problem) problems.push(`control: ${listing.control.problem}`);
  const controlRetention = retentionProblem(
    listing.control?.retention,
    'tug backup unlock --control',
  );
  if (controlRetention) problems.push(`control: ${controlRetention}`);
  return problems;
}
