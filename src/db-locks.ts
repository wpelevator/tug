import type { Db, LockRow } from './db.ts';

/** SQL persistence only; callers own lease clocks, heartbeats and conflict responses. */
export function lockQueries(db: Db) {
  return {
    purgeExpired(at: string): void {
      db.run('DELETE FROM locks WHERE expires_at < ?', at);
    },
    insert(lock: LockRow): void {
      db.run(
        'INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)',
        lock.name,
        lock.owner,
        lock.expires_at,
        lock.created_at,
      );
    },
    find(name: string): LockRow | undefined {
      return db.get<LockRow>('SELECT * FROM locks WHERE name=?', name);
    },
    owns(name: string, owner: string, at: string): boolean {
      return Boolean(
        db.get('SELECT 1 FROM locks WHERE name=? AND owner=? AND expires_at>?', name, owner, at),
      );
    },
    renew(name: string, owner: string, expiresAt: string): void {
      db.run('UPDATE locks SET expires_at=? WHERE name=? AND owner=?', expiresAt, name, owner);
    },
    release(name: string, owner: string): void {
      db.run('DELETE FROM locks WHERE name=? AND owner=?', name, owner);
    },
  };
}
