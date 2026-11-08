import type { BackupDestinationRow, Db } from '../db/db.ts';
import { BACKUP_SECRET_PROJECT } from './destination.ts';
import { immediateTransaction } from '../db/transaction.ts';

interface DestinationSecret {
  id: string;
  name: string;
  encryptedValue: string;
}

/** Accepts encrypted values only. Encryption and credential parsing belong to the caller. */
export function backupDestinationQueries(db: Db) {
  return {
    find(): BackupDestinationRow | undefined {
      return db.get<BackupDestinationRow>("SELECT * FROM backup_destination WHERE id='default'");
    },
    secret(name: string): string | undefined {
      return db.get<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM secrets WHERE project_id=? AND name=?',
        BACKUP_SECRET_PROJECT,
        name,
      )?.encrypted_value;
    },
    replace(url: string, secrets: DestinationSecret[], at: string): void {
      immediateTransaction(db, () => {
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
    remove(): boolean {
      return immediateTransaction(db, () => {
        db.run('DELETE FROM secrets WHERE project_id=?', BACKUP_SECRET_PROJECT);
        return db.run("DELETE FROM backup_destination WHERE id='default'").changes > 0;
      });
    },
  };
}
