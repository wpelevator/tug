/** The part of `GET /api/v1/backups` that `tug backup-list --check` judges. */
export interface BackupCheckInput {
  destinationConfigured: boolean;
  targets: { target: string; enabled: boolean; problem?: string | null }[];
}

/** What a monitor should be told: one line per problem, empty when every backup target is healthy. */
export function backupCheckProblems(listing: BackupCheckInput): string[] {
  const active = listing.targets.filter((target) => target.enabled);
  const problems = active
    .filter((target) => target.problem)
    .map((target) => `${target.target}: ${target.problem}`);
  if (active.length && !listing.destinationConfigured)
    problems.unshift('no backup destination is configured');
  return problems;
}
