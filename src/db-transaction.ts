import type { Db } from './db-driver.ts';

/** Run synchronous work in an immediate transaction. Nested transactions are rejected by SQLite. */
export function immediateTransaction<T>(
  db: Db,
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  // Keep BEGIN outside the catch: a failed BEGIN must not roll back somebody else's transaction.
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    )
      throw new TypeError('Database transactions require synchronous callbacks');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Preserve the operation or commit failure. */
    }
    throw error;
  }
}
