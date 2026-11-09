/** The part of `GET /api/v1/backups` that `tug backup list --check` judges. */
export interface BackupCheckInput {
  destinationConfigured: boolean;
  targets: { target: string; enabled: boolean; problem?: string | null }[];
  control?: { problem: string | null } | null;
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
  const problems = active
    .filter((target) => target.problem)
    .map((target) => `${target.target}: ${target.problem}`);
  if (!listing.destinationConfigured && (active.length || options.requireProtection))
    problems.unshift(NO_DESTINATION);
  if (options.requireProtection && !options.allowEmpty && !active.length) problems.push(NO_TARGETS);
  if (listing.control?.problem) problems.push(`control: ${listing.control.problem}`);
  return problems;
}
