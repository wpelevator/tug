import type { BackupDestinationRow, Db } from '../db/db.ts';
import { BACKUP_SECRET_PROJECT } from './destination.ts';
import { immediateTransaction } from '../db/transaction.ts';
import type { RetentionMode } from '../protocol.ts';
import { maintenanceStore } from './maintenance.ts';

/**
 * Who prunes the destination lives in `meta` next to the destination row, not in a column: a column would be a schema
 * change that stops an older control from opening the database. `external` is stored; `managed` is the absence of the row.
 */
const RETENTION_KEY = 'backup_destination_retention';

interface DestinationSecret {
  id: string;
  name: string;
  encryptedValue: string;
}

/** Accepts encrypted values only. Encryption and credential parsing belong to the caller. */
export function backupDestinationQueries(db: Db) {
  const find = () =>
    db.get<BackupDestinationRow>("SELECT * FROM backup_destination WHERE id='default'");
  const retention = (): RetentionMode =>
    db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', RETENTION_KEY)?.value ===
    'external'
      ? 'external'
      : 'managed';
  const setRetention = (mode: RetentionMode): void => {
    if (mode === 'external')
      db.run(
        'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        RETENTION_KEY,
        mode,
      );
    else db.run('DELETE FROM meta WHERE key=?', RETENTION_KEY);
  };
  return {
    find,
    /** Who prunes the destination: tug (`managed`) or the storage side (`external`, an append-only server). */
    retention,
    /** Changes only the retention mode; the destination, its credentials and its check result stay. */
    setRetention: (mode: RetentionMode): void => immediateTransaction(db, () => setRetention(mode)),
    secret(name: string): string | undefined {
      return db.get<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM secrets WHERE project_id=? AND name=?',
        BACKUP_SECRET_PROJECT,
        name,
      )?.encrypted_value;
    },
    replace(
      url: string,
      secrets: DestinationSecret[],
      at: string,
      mode: RetentionMode = 'managed',
    ): void {
      immediateTransaction(db, () => {
        // The maintenance results describe the repositories of the destination being left.
        if (find()?.url !== url) maintenanceStore(db).clear();
        setRetention(mode);
        db.run('DELETE FROM secrets WHERE project_id=?', BACKUP_SECRET_PROJECT);
        for (const secret of secrets)
          db.run(
            'INSERT INTO secrets(id,project_id,name,encrypted_value,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
            secret.id,
            BACKUP_SECRET_PROJECT,
            secret.name,
            secret.encryptedValue,
            1,
            at,
            at,
          );
        db.run(
          `INSERT INTO backup_destination(id,url,env_names_json,checked_at,check_result_json,updated_at) VALUES('default',?,?,NULL,NULL,?)
          ON CONFLICT(id) DO UPDATE SET url=excluded.url,env_names_json=excluded.env_names_json,checked_at=NULL,check_result_json=NULL,updated_at=excluded.updated_at`,
          url,
          JSON.stringify(secrets.map((secret) => secret.name).sort()),
          at,
        );
      });
    },
    /**
     * Stores a check result, but only while the destination is still the one that was checked. `updatedAt` is the
     * value read before the check began; every replace sets a new one, so a changed URL or changed credentials drop
     * the stale result. False when it was dropped. `checkedAt` is null while the check is still running.
     */
    recordCheck(updatedAt: string, checkedAt: string | null, result: unknown): boolean {
      return (
        db.run(
          "UPDATE backup_destination SET checked_at=?,check_result_json=? WHERE id='default' AND updated_at=?",
          checkedAt,
          JSON.stringify(result),
          updatedAt,
        ).changes > 0
      );
    },
    /**
     * A check that was running when control stopped will never finish: mark it done and failed, so `show` and a CLI
     * that polls for it do not wait forever. Returns whether a running check was found.
     */
    interruptRunningCheck(at: string): boolean {
      const row = find();
      if (!row?.check_result_json) return false;
      let result: { state?: string; error?: string; nodes?: { state: string }[] };
      try {
        result = JSON.parse(row.check_result_json);
      } catch {
        return false;
      }
      if (result.state !== 'running') return false;
      const interrupted = {
        ...result,
        state: 'done',
        ok: false,
        checkedAt: at,
        error: 'control restarted before the check finished',
        nodes: (result.nodes ?? []).map((node) =>
          node.state === 'pending'
            ? { ...node, state: 'timeout', error: 'control restarted' }
            : node,
        ),
      };
      db.run(
        "UPDATE backup_destination SET checked_at=?,check_result_json=? WHERE id='default'",
        at,
        JSON.stringify(interrupted),
      );
      return true;
    },
    remove(): boolean {
      return immediateTransaction(db, () => {
        db.run('DELETE FROM secrets WHERE project_id=?', BACKUP_SECRET_PROJECT);
        setRetention('managed');
        maintenanceStore(db).clear();
        return db.run("DELETE FROM backup_destination WHERE id='default'").changes > 0;
      });
    },
  };
}
