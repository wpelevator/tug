import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { databaseContract } from '../tests/db-contract.ts';
import { connectNodeDb } from './db-node.ts';
import { databaseAccess, openAgentDb, openDb, openSnapshotDb } from './db.ts';
import type { Db } from './db-driver.ts';

databaseContract('node:sqlite', connectNodeDb);

test('control and agent initialization is idempotent with WAL, foreign keys and a bounded timeout', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-db-init-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, open, table] of [
    ['control', openDb, 'projects'],
    ['agent', openAgentDb, 'applied_state'],
  ] as const) {
    const file = path.join(dir, name, 'state.db');
    const first = await open(file);
    assert.deepEqual(
      first.get('PRAGMA journal_mode'),
      { journal_mode: 'wal' },
      'writable databases must enable WAL',
    );
    assert.deepEqual(
      first.get('PRAGMA foreign_keys'),
      { foreign_keys: 1 },
      'connections must enforce foreign keys',
    );
    assert.deepEqual(
      first.get('PRAGMA busy_timeout'),
      { timeout: 1000 },
      'connections must cap busy waits at 1000 ms',
    );
    assert.ok(
      first.get('SELECT name FROM sqlite_master WHERE name=?', table),
      'the selected schema must be initialized',
    );
    first.exec(
      'CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(parent TEXT REFERENCES parent(id))',
    );
    assert.throws(
      () => first.run('INSERT INTO child VALUES(?)', 'missing'),
      Error,
      'foreign-key constraints must reject missing parents',
    );
    const created = first.get('SELECT * FROM sqlite_master WHERE name=?', table);
    if (name === 'agent') {
      first.run('INSERT INTO applied_state(project,version) VALUES(?,?)', 'site', 'v1');
      first.run('INSERT INTO event_state VALUES(?,?,?)', 'site', 'fingerprint', 'serving');
    }
    first.close();
    const second = await open(file);
    assert.deepEqual(
      second.get('SELECT * FROM sqlite_master WHERE name=?', table),
      created,
      'reopening must preserve the initialized schema',
    );
    if (name === 'agent') {
      assert.deepEqual(
        second.get('SELECT project,version FROM applied_state'),
        { project: 'site', version: 'v1' },
        'agent applied versions must survive reopening',
      );
      assert.deepEqual(
        second.get('SELECT * FROM event_state'),
        { project: 'site', fingerprint: 'fingerprint', phase: 'serving' },
        'event suppression state must survive reopening',
      );
    }
    second.close();
  }
});

test('snapshot initialization does not create application tables or switch journal mode', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-snapshot-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'snapshot.db');
  const raw = connectNodeDb(filename, { readOnly: false });
  raw.exec('CREATE TABLE saved(value TEXT)');
  raw.close();
  const snapshot = openSnapshotDb(filename);
  try {
    assert.equal(
      snapshot.get('SELECT name FROM sqlite_master WHERE name=?', 'meta'),
      undefined,
      'snapshot opening must not initialize control tables',
    );
    assert.deepEqual(
      snapshot.get('PRAGMA journal_mode'),
      { journal_mode: 'delete' },
      'snapshot opening must not enable writable WAL setup',
    );
    assert.throws(
      () => snapshot.exec('CREATE TABLE bad(value TEXT)'),
      Error,
      'snapshot policy must open read-only',
    );
  } finally {
    snapshot.close();
  }
});

test('failed schema initialization closes its connection and retains the original failure', async () => {
  const failure = new Error('schema failed');
  let closes = 0;
  const db = {
    exec: () => {
      throw failure;
    },
    close: () => {
      closes++;
      throw new Error('close failed');
    },
  } as unknown as Db;
  const access = databaseAccess(() => db);
  for (const open of [access.openDb, access.openAgentDb])
    await assert.rejects(
      open(':memory:'),
      (error) => error === failure,
      'configuration failures must preserve the original error',
    );
  assert.throws(
    () => access.openSnapshotDb('snapshot.db'),
    (error) => error === failure,
    'snapshot configuration failures must preserve the original error',
  );
  assert.equal(closes, 3, 'every failed opener must attempt to close its connection');
});

test('a control schema failure closes the opened handle before startup rejects', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-db-invalid-schema-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.db');
  const seed = connectNodeDb(filename, { readOnly: false });
  seed.exec('CREATE TABLE meta(key TEXT PRIMARY KEY)');
  seed.close();
  let handle: Db | undefined;
  let closes = 0;
  const access = databaseAccess((file, options) => {
    const db = connectNodeDb(file, options);
    handle = db;
    const close = db.close;
    db.close = () => {
      closes++;
      close();
    };
    return db;
  });
  await assert.rejects(
    access.openDb(filename),
    /no such column: value/,
    'invalid schemas must reject startup with the original SQL failure',
  );
  assert.equal(closes, 1, 'schema failures must close the opened handle exactly once');
  assert.throws(
    () => handle!.get('SELECT 1'),
    Error,
    'a failed startup must not leave a usable connection open',
  );
});
