import { createHash } from 'node:crypto';
import type { Db } from '../db/db.ts';
import type { VerifyRecord } from './check.ts';

/** How often a repository is pruned and checked. */
export const MAINTENANCE_INTERVAL_MS = 7 * 24 * 3_600_000;
/** After a failed run the repository is tried again at this interval, not a week later. */
export const MAINTENANCE_RETRY_MS = 6 * 3_600_000;

/** The `meta` key prefix of the last maintenance record of one repository (a project, or `_control`). */
export const VERIFY_KEY = 'backup_verify:';
/** The `meta` key prefix of when a repository is next due. */
export const MAINTENANCE_NEXT_KEY = 'backup_maintenance_next:';

/** What the last maintenance of a repository found. It belongs to the destination and is dropped with it. */
export type MaintenanceRecord = VerifyRecord;

/**
 * Maintenance results live in `meta`, one row per repository, so they need no table: an older control still opens the
 * database. Replacing or removing the destination clears them, because they describe the repositories it held.
 */
export function maintenanceStore(db: Db) {
  const upsert = (key: string, value: string): void =>
    void db.run(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  return {
    record(repository: string): MaintenanceRecord | null {
      const row = db.get<{ value: string }>(
        'SELECT value FROM meta WHERE key=?',
        VERIFY_KEY + repository,
      );
      if (!row) return null;
      try {
        return JSON.parse(row.value) as MaintenanceRecord;
      } catch {
        return null;
      }
    },
    setRecord(repository: string, record: MaintenanceRecord): void {
      upsert(VERIFY_KEY + repository, JSON.stringify(record));
    },
    /** When the repository is next due, or null when it has not been seen yet. */
    nextAt(repository: string): number | null {
      const row = db.get<{ value: string }>(
        'SELECT value FROM meta WHERE key=?',
        MAINTENANCE_NEXT_KEY + repository,
      );
      const at = row ? Date.parse(row.value) : NaN;
      return Number.isNaN(at) ? null : at;
    },
    setNextAt(repository: string, at: number): void {
      upsert(MAINTENANCE_NEXT_KEY + repository, new Date(at).toISOString());
    },
    clear(): void {
      db.run(
        'DELETE FROM meta WHERE key LIKE ? OR key LIKE ?',
        `${VERIFY_KEY}%`,
        `${MAINTENANCE_NEXT_KEY}%`,
      );
    },
  };
}

/**
 * A repository seen for the first time is first due somewhere in the next week, chosen by its name, so projects on one
 * destination do not all prune at once and a restarted control picks the same slot.
 */
export function firstDueAt(repository: string, now: number): number {
  const slot = createHash('sha256').update(repository).digest().readUInt32BE(0);
  return now + (slot % (MAINTENANCE_INTERVAL_MS / 1000)) * 1000;
}

export type ProtectionLevel = 'off-host' | 'verified' | 'restore-tested';

/** A check this recent still vouches for the repository: the weekly interval plus a day for a retry and a long check. */
export const VERIFIED_WINDOW_MS = MAINTENANCE_INTERVAL_MS + 24 * 3_600_000;
/** A scratch restore this recent still shows the backup can be restored. */
export const RESTORE_TESTED_WINDOW_MS = 90 * 24 * 3_600_000;

/**
 * The strictest claim a target can make, never more than what ran:
 * - `off-host`: the destination is not a local path and the target has a recent success;
 * - `verified`: also, the repository's last `restic check` passed and finished within `VERIFIED_WINDOW_MS`. The check
 *   covers the repository as it was when it ran, so a backup made since keeps the level: a daily backup with a weekly
 *   check would otherwise be verified for under a day in seven;
 * - `restore-tested`: also, a scratch restore of the target succeeded within `RESTORE_TESTED_WINDOW_MS`.
 * Null when the target has nothing off-host: no recent success, or a destination on the same host.
 */
export function protectionLevel(input: {
  local: boolean;
  /** The target has a recent success: it is not stale, failed or missing. */
  healthy: boolean;
  lastSuccessAt: string | null;
  verify: MaintenanceRecord | null;
  /** When the newest successful scratch restore of the target finished. */
  restoreTestedAt: string | null;
  now?: number;
}): ProtectionLevel | null {
  if (input.local || !input.healthy || !input.lastSuccessAt) return null;
  const at = input.now ?? Date.now();
  const within = (when: string | null | undefined, window: number): boolean => {
    const time = when ? Date.parse(when) : NaN;
    return !Number.isNaN(time) && at - time <= window;
  };
  const verified =
    input.verify?.check === 'ok' && within(input.verify.finishedAt, VERIFIED_WINDOW_MS);
  if (!verified) return 'off-host';
  return within(input.restoreTestedAt, RESTORE_TESTED_WINDOW_MS) ? 'restore-tested' : 'verified';
}

/** The `--read-data-subset` forms restic accepts: `n/t`, a percentage or a size such as `500M`. */
export function parseSubset(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const subset = String(value).trim();
  if (!/^(\d{1,3}\/\d{1,3}|\d{1,3}(\.\d+)?%|\d+(\.\d+)?[KMGT]?)$/i.test(subset))
    throw new Error(
      `--read-data-subset ${JSON.stringify(subset)} is not a fraction (1/10), a percentage (5%) or a size (500M)`,
    );
  return subset;
}
