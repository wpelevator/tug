import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectNodeDb } from './db-node.ts';
import { openAgentDb, openDb, openSnapshotDb } from './db.ts';
import { migrate, schemaVersion } from './db-migrate.ts';
import type { Migration } from './db-migrate.ts';
import type { Db } from './db-driver.ts';

const fixtures = new URL('../tests/fixtures/db/', import.meta.url);

async function tmp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-migrate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A control database file as an older release left it: its schema and a few rows, with no schema version. */
async function legacyDb(file: string, release: string): Promise<void> {
  const raw = new DatabaseSync(file);
  raw.exec(await fs.readFile(new URL(`control-${release}.sql`, fixtures), 'utf8'));
  raw.close();
}

function columns(db: Db, table: string): Map<string, string> {
  return new Map(
    db
      .all<{ name: string; type: string; notnull: number }>(`PRAGMA table_info(${table})`)
      .map((c) => [c.name, `${c.type}${c.notnull ? ' NOT NULL' : ''}`]),
  );
}
const tables = (db: Db): string[] =>
  db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);

for (const release of ['v0.2.0', 'v0.14.0']) {
  test(`a ${release} control database upgrades in place, keeps its rows and gets the current schema`, async (t) => {
    const dir = await tmp(t);
    const file = path.join(dir, 'tug.db');
    await legacyDb(file, release);
    const db = await openDb(file);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), 1, 'the upgrade must record the schema version');
    assert.equal(
      db.get<{ name: string }>("SELECT name FROM projects WHERE id='p1'")?.name,
      'site',
      'existing rows must survive the upgrade',
    );
    assert.equal(
      db.get<{ address: string }>("SELECT address FROM nodes WHERE id='node_a'")?.address,
      '10.0.0.5',
      'existing node rows must survive the upgrade',
    );
    const fresh = await openDb(path.join(dir, 'fresh', 'tug.db'));
    t.after(() => fresh.close());
    assert.deepEqual(
      tables(db).filter((n) => tables(fresh).includes(n)),
      tables(fresh),
      'every current table must exist after the upgrade',
    );
    for (const table of tables(fresh)) {
      const upgraded = columns(db, table);
      for (const [name, type] of columns(fresh, table))
        assert.equal(
          upgraded.get(name),
          type,
          `${release} upgraded to ${table}.${name} ${type}, exactly what a fresh database has: edit a new migration step, never the released baseline`,
        );
    }
    db.run(
      `INSERT INTO nodes(id,name,address,labels_json,key_hash,disabled_at,cert_not_after,last_renewed_at,clock_skew_ms,clock_observed_at) VALUES('node_b','app2','10.0.0.6','[]','h',NULL,'2027-01-01',NULL,5,'2026-11-01')`,
    );
    assert.ok(
      db.get("SELECT 1 AS ok FROM nodes WHERE id='node_b'"),
      'the current code can write every current column of an upgraded database',
    );
  });
}

test('an upgrade of a database with data copies it aside first, and a fresh database does not', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'tug.db');
  await legacyDb(file, 'v0.14.0');
  (await openDb(file)).close();
  const backup = `${file}.pre-v1.bak`;
  const copy = new DatabaseSync(backup, { readOnly: true });
  t.after(() => copy.close());
  assert.equal(
    (copy.prepare("SELECT name FROM projects WHERE id='p1'").get() as { name: string }).name,
    'site',
    'the pre-upgrade copy must hold the data as it was',
  );
  assert.equal(
    (copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    0,
    'the pre-upgrade copy must stay at the old schema version',
  );
  (await openDb(file)).close();
  const fresh = path.join(dir, 'fresh', 'tug.db');
  (await openDb(fresh)).close();
  await assert.rejects(
    fs.access(`${fresh}.pre-v1.bak`),
    'a new database has nothing to copy aside',
  );
});

test('opening a migrated database again changes nothing', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'tug.db');
  await legacyDb(file, 'v0.14.0');
  (await openDb(file)).close();
  const again = await openDb(file);
  t.after(() => again.close());
  assert.equal(schemaVersion(again), 1, 'the version stays put');
  assert.equal(again.all('SELECT * FROM projects').length, 1, 'rows are not duplicated');
});

test('a database from a newer Tug is refused untouched by writable and snapshot opens', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'tug.db');
  (await openDb(file)).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  await assert.rejects(
    openDb(file),
    /schema version 99, newer than the 1 this Tug supports/,
    'a control rolled back below its database must stop with the remedy, not run on a schema it does not know',
  );
  assert.throws(
    () => openSnapshotDb(file),
    /schema version 99, newer than the 1 this Tug supports/,
    'restoring a backup from a newer Tug must be refused',
  );
  const check = new DatabaseSync(file, { readOnly: true });
  t.after(() => check.close());
  assert.equal(
    (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    99,
    'the refused database must not be modified',
  );
});

test('an agent database gets the same versioning and refuses a newer one', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'agent.db');
  const db = await openAgentDb(file);
  assert.equal(schemaVersion(db), 1, 'a new agent database records its schema version');
  db.close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 7');
  raw.close();
  await assert.rejects(
    openAgentDb(file),
    /agent database is at schema version 7/,
    'an agent older than its state refuses it',
  );
});

test('a failing step rolls back completely and names the schema it stopped at', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'x.db');
  const db = connectNodeDb(file, { readOnly: false });
  t.after(() => db.close());
  const steps: Migration[] = [
    { version: 1, name: 'create', up: (d) => d.exec('CREATE TABLE a(x TEXT)') },
    {
      version: 2,
      name: 'broken',
      up: (d) => {
        d.exec('CREATE TABLE b(x TEXT)');
        d.exec('SELECT * FROM does_not_exist');
      },
    },
  ];
  assert.throws(
    () => migrate(db, steps, { label: 'test', filename: file }),
    /to schema 2 \(broken\) failed.*left at schema 1/s,
    'the failure must name the step and where the database stayed',
  );
  assert.equal(schemaVersion(db), 1, 'completed steps stay applied');
  assert.deepEqual(tables(db), ['a'], 'the failed step must leave none of its changes behind');
});

test('migration steps must be numbered from 1 without gaps', () => {
  const db = connectNodeDb(':memory:', { readOnly: false });
  assert.throws(
    () => migrate(db, [{ version: 2, name: 'late', up: () => {} }], { label: 'test' }),
    /must be version 1/,
    'a gap or a reordered step would make versions mean different schemas',
  );
  db.close();
});
