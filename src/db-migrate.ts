import fs from 'node:fs';
import type { Db } from './db-driver.ts';

/**
 * One ordered step of a database's schema history. `version` is the value of SQLite's `PRAGMA user_version` once the
 * step has run. Steps are append-only: a released step is never edited, because databases that already ran it would
 * not run it again. Version 1 is the schema every Tug release from 0.8 on shares; it also upgrades older databases.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

/** The schema version stored in the database file; 0 for a file no migration has touched. */
export function schemaVersion(db: Db): number {
  return Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
}

function latestVersion(migrations: readonly Migration[]): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`migration ${m.name} must be version ${i + 1}, not ${m.version}`);
  });
  return migrations.length;
}

/** The message for a database written by a newer Tug than this one, shared by writable and read-only opens. */
function tooNewMessage(label: string, found: number, supported: number): string {
  return `the ${label} database is at schema version ${found}, newer than the ${supported} this Tug supports; upgrade Tug, or restore a backup taken by this version`;
}

/** Refuses a database from a newer Tug without changing it; read-only snapshots use this instead of migrating. */
export function assertSchemaSupported(
  db: Db,
  label: string,
  migrations: readonly Migration[],
): void {
  const supported = latestVersion(migrations);
  const found = schemaVersion(db);
  if (found > supported) throw new Error(tooNewMessage(label, found, supported));
}

/** Adds a column an older release lacked; a no-op when it is already there. SQLite cannot `ADD COLUMN IF NOT EXISTS`. */
export function addColumnIfMissing(
  db: Db,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((c) => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Brings a database to the latest schema. Each pending step runs in its own transaction together with its version
 * bump, so a failure leaves the database at the last completed step. A database that already holds data is copied to
 * `<file>.pre-v<N>.bak` first (when the connection has a file), because an upgrade cannot be reversed by an older Tug.
 * A database from a newer Tug is refused untouched.
 */
export function migrate(
  db: Db,
  migrations: readonly Migration[],
  options: { label: string; filename?: string },
): void {
  const latest = latestVersion(migrations);
  const current = schemaVersion(db);
  if (current > latest) throw new Error(tooNewMessage(options.label, current, latest));
  const pending = migrations.filter((m) => m.version > current);
  if (!pending.length) return;
  let backup: string | undefined;
  const populated =
    Number(
      db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")?.n ?? 0,
    ) > 0;
  if (populated && options.filename) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    backup = `${options.filename}.pre-v${latest}.bak`;
    fs.copyFileSync(options.filename, backup);
    fs.chmodSync(backup, 0o600);
  }
  for (const step of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve the migration failure. */
      }
      throw new Error(
        `migrating the ${options.label} database to schema ${step.version} (${step.name}) failed: ${(error as Error).message}; it was left at schema ${step.version - 1}${backup ? ` and copied to ${backup}` : ''}`,
        { cause: error },
      );
    }
  }
}
