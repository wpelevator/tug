/** restic (0.17 and newer) exits with this code when the repository does not exist. */
export const RESTIC_EXIT_REPOSITORY_MISSING = 10;
/** restic (0.17 and newer) exits with this code when the repository password is wrong. */
export const RESTIC_EXIT_WRONG_PASSWORD = 12;

export type RepositoryProbe = 'ok' | 'missing' | 'error';

export interface ProbeResult {
  code: number | null;
  err: string;
  out: string;
}

/**
 * Classifies `restic cat config` by its exit code, the one signal restic documents for "no repository here": 0 is an
 * existing repository, 10 a missing one and anything else (a wrong password, a missing bucket, a refused login, an
 * unreachable store, a restic too old to report 10) is an error. Wording is never matched: a typo in an S3 bucket
 * name also says "does not exist" but must not make Tug create the bucket.
 */
export function classifyRepositoryProbe(result: ProbeResult): RepositoryProbe {
  if (result.code === 0) return 'ok';
  if (result.code === RESTIC_EXIT_REPOSITORY_MISSING) return 'missing';
  return 'error';
}

/**
 * Explains a failed probe in words. `detail` is restic's own (already summarized and redacted) message, which this
 * only prefixes: a wrong password and a restic too old to exit with 10 each get the hint that fixes them.
 */
export function describeProbeFailure(result: ProbeResult, detail: string): string {
  if (result.code === RESTIC_EXIT_WRONG_PASSWORD)
    return `wrong repository password (restic exit code ${RESTIC_EXIT_WRONG_PASSWORD}): ${detail}`;
  if (result.code === 1 && /Is there a repository at the following location/i.test(result.err))
    return `${detail} (restic older than 0.17 cannot report a missing repository, so TUG_RESTIC_IMAGE must be 0.17 or newer for repositories to be created automatically)`;
  return detail;
}
