import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { backupDestinationQueries } from './db-backup-destination.ts';
import { BACKUP_SECRET_PROJECT } from './backup-destination.ts';

const at = '2026-11-03T10:00:00.000Z';
const secret = (id: string, name: string) => ({ id, name, encryptedValue: `encrypted:${name}` });

test('destination replacement preserves other secrets, replaces credentials and clears stale checks', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  const destination = backupDestinationQueries(db);
  assert.equal(destination.find(), undefined, 'an unconfigured destination must return undefined');
  assert.equal(
    destination.secret('missing'),
    undefined,
    'missing credentials must return undefined',
  );
  db.run(
    'INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)',
    'site',
    'site',
    at,
    at,
  );
  db.run(
    'INSERT INTO secrets(id,project_id,name,encrypted_value,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    'app-secret',
    'site',
    'TOKEN',
    'app-value',
    1,
    at,
    at,
  );
  destination.replace('s3:old', [secret('old', 'OLD')], at);
  db.run(
    "UPDATE backup_destination SET checked_at=?,check_result_json=? WHERE id='default'",
    at,
    '{"ok":true}',
  );
  destination.replace('s3:new', [secret('z', 'Z'), secret('a', 'A')], at);
  assert.deepEqual(
    destination.find(),
    {
      id: 'default',
      url: 's3:new',
      env_names_json: '["A","Z"]',
      checked_at: null,
      check_result_json: null,
      updated_at: at,
    },
    'replacement must store sorted credential names and invalidate the previous check',
  );
  assert.equal(
    destination.secret('OLD'),
    undefined,
    'replacement must delete obsolete destination credentials',
  );
  assert.equal(
    destination.secret('A'),
    'encrypted:A',
    'credential reads must return the encrypted value',
  );
  assert.equal(
    db.get<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM secrets WHERE id=?',
      'app-secret',
    )?.encrypted_value,
    'app-value',
    'replacement must preserve application credentials',
  );
  assert.equal(destination.remove(), true, 'removing a configured destination must return true');
  assert.equal(destination.find(), undefined, 'removal must delete the destination');
  assert.equal(
    db.all('SELECT * FROM secrets WHERE project_id=?', BACKUP_SECRET_PROJECT).length,
    0,
    'removal must delete destination credentials',
  );
  assert.ok(
    db.get('SELECT 1 FROM secrets WHERE id=?', 'app-secret'),
    'removal must preserve application credentials',
  );
  assert.equal(destination.remove(), false, 'removing an absent destination must return false');
});

test('failed replacement restores the previous destination and credentials', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  const destination = backupDestinationQueries(db);
  destination.replace('s3:old', [secret('old', 'OLD')], at);
  const previous = destination.find();
  assert.throws(
    () =>
      destination.replace('s3:new', [secret('one', 'DUPLICATE'), secret('two', 'DUPLICATE')], at),
    /UNIQUE/,
    'duplicate credentials must fail replacement',
  );
  assert.deepEqual(
    destination.find(),
    previous,
    'failed replacement must preserve the old destination',
  );
  assert.equal(
    destination.secret('OLD'),
    'encrypted:OLD',
    'failed replacement must restore old credentials deleted at the start',
  );
  assert.equal(
    destination.secret('DUPLICATE'),
    undefined,
    'failed replacement must roll back inserted credentials',
  );
  db.exec(
    "CREATE TRIGGER reject_destination_update BEFORE UPDATE ON backup_destination BEGIN SELECT RAISE(ABORT, 'destination update failed'); END",
  );
  assert.throws(
    () => destination.replace('s3:new', [secret('new', 'NEW')], at),
    /destination update failed/,
    'a destination write failure must abort replacement',
  );
  assert.equal(
    destination.secret('OLD'),
    'encrypted:OLD',
    'a destination write failure must also restore the original credentials',
  );
  assert.equal(
    destination.secret('NEW'),
    undefined,
    'a destination write failure must discard new credentials',
  );
});

test('failed destination removal restores its credentials', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  const destination = backupDestinationQueries(db);
  destination.replace('s3:old', [secret('old', 'OLD')], at);
  db.exec(
    "CREATE TRIGGER reject_destination_delete BEFORE DELETE ON backup_destination BEGIN SELECT RAISE(ABORT, 'destination delete failed'); END",
  );
  assert.throws(
    () => destination.remove(),
    /destination delete failed/,
    'a destination delete failure must propagate',
  );
  assert.ok(destination.find(), 'a failed removal must preserve the destination');
  assert.equal(
    destination.secret('OLD'),
    'encrypted:OLD',
    'a failed removal must restore the destination credentials',
  );
});
