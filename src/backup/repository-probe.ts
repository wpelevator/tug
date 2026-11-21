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

/** The first restic that exits with code 10 for a missing repository. */
export const MIN_RESTIC_VERSION = [0, 17, 0] as const;

/** True when `version` (`0.16.4`) is known and older than {@link MIN_RESTIC_VERSION}. */
export function resticTooOld(version: string | undefined): boolean {
  const parts = version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== MIN_RESTIC_VERSION[i]) return parts[i] < MIN_RESTIC_VERSION[i];
  }
  return false;
}

/**
 * Explains a failed probe in words. `detail` is restic's own (already summarized and redacted) message, which this
 * only prefixes or suffixes. A wrong password (exit 12) is named. The old-restic hint needs the restic version: the
 * message text cannot tell it, because restic 0.19 appends "Is there a repository at the following location?" to
 * every exit-1 failure too (a mistyped bucket, a refused login).
 */
export function describeProbeFailure(
  result: ProbeResult,
  detail: string,
  resticVersion?: string,
): string {
  if (result.code === RESTIC_EXIT_WRONG_PASSWORD)
    return `wrong repository password (restic exit code ${RESTIC_EXIT_WRONG_PASSWORD}): ${detail}`;
  if (result.code === 1 && resticTooOld(resticVersion))
    return `${detail} (restic ${resticVersion} is older than 0.17 and cannot report a missing repository, so TUG_RESTIC_IMAGE must be 0.17 or newer for repositories to be created automatically)`;
  return detail;
}
