/** What `tug backup destination set --retention external` is for; appended to a retention failure the destination refused. */
export const EXTERNAL_RETENTION_HINT =
  'if the destination is append-only, run tug backup destination set --retention external, so old snapshots are removed from the storage side';

/**
 * A line of a Go stack, a goroutine dump or a progress ticker: restic ends a failed command with the stack of its
 * `init` or `main`, which says nothing about the cause and pushes the cause out of a tail.
 */
const NOISE =
  /^(\s|main\.|runtime\.|goroutine \d+|created by |github\.com\/|golang\.org\/|net\/http\.|os\/exec\.|syscall\.|\[\d+:\d+\] )|returned error, retrying/;
/** What a refused delete or an unreadable store says; the same words mean an append-only or read-restricted server. */
const REFUSED = /\b403\b|forbidden|append[- ]only|permission denied|not permitted|access denied/i;

/** The most characters of restic's own words a stored failure keeps. */
const LIMIT = 400;

/**
 * restic's meaningful lines of a failed command, without the stack that follows its `Fatal` or final error line and
 * without backend retry notices, joined by ` | `: the last four lines, and fewer when they would pass {@link LIMIT}.
 * Credentials are redacted by the caller before this reads the text. When the text shows a refusal (HTTP 403, an
 * append-only server, a permission error) the hint to set external retention is added, because a destination that
 * refuses deletes is the one case where retention can never succeed.
 */
export function summarizeRetentionFailure(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !NOISE.test(line));
  const kept = lines.slice(-4);
  while (kept.length > 1 && kept.join(' | ').length > LIMIT) kept.shift();
  const summary = (kept.join(' | ') || text.trim().slice(-LIMIT)).slice(-LIMIT);
  return REFUSED.test(text) ? `${summary} (${EXTERNAL_RETENTION_HINT})` : summary;
}
