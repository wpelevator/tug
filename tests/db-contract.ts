import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbError, isUniqueViolation } from '../src/db-driver.ts';
import type { ConnectDb, Db, SqlValue } from '../src/db-driver.ts';

/** Run unchanged against any future SQLite runtime adapter. */
export function databaseContract(name: string, connect: ConnectDb) {
  function fixture(t: TestContext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tug-db-contract-'));
    const filename = path.join(dir, 'state.db');
    const connections: Db[] = [];
    t.after(() => {
      for (const db of connections) {
        try {
          db.close();
        } catch {
          /* Some tests close explicitly. */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const open = (readOnly = false) => {
      const db = connect(filename, { readOnly });
      connections.push(db);
      return db;
    };
    return { filename, open };
  }

  describe(`${name} database contract`, () => {
    test('bound values round-trip with ordinary rows, numeric counts and no SQL interpolation', (t) => {
      const db = fixture(t).open();
      db.exec(
        'CREATE TABLE values_test(id INTEGER PRIMARY KEY, text TEXT, optional TEXT, data BLOB, value REAL)',
      );
      const text = "Robert'); DROP TABLE values_test; --";
      assert.deepEqual(
        db.run(
          'INSERT INTO values_test VALUES(?,?,?,?,?)',
          1n,
          text,
          null,
          new Uint8Array([1, 255]),
          1.5,
        ),
        { changes: 1 },
        'inserts must expose a numeric change count',
      );
      assert.deepEqual(
        db.get('SELECT * FROM values_test'),
        { id: 1, text, optional: null, data: new Uint8Array([1, 255]), value: 1.5 },
        'bindings must preserve values and rows must be ordinary objects',
      );
      assert.deepEqual(
        db.all<{ id: number }>('SELECT id FROM values_test'),
        [{ id: 1 }],
        'all must return a list of ordinary typed rows',
      );
      assert.equal(
        db.get('SELECT * FROM values_test WHERE id=?', 2),
        undefined,
        'missing rows must return undefined',
      );
      assert.deepEqual(
        db.all('SELECT * FROM values_test WHERE id=?', 2),
        [],
        'empty queries must return an empty list',
      );
      assert.deepEqual(
        db.run('UPDATE values_test SET value=? WHERE id=?', 2, 99),
        { changes: 0 },
        'conditional writes must expose zero changes when no row matches',
      );
      assert.equal(
        JSON.stringify(db.get('SELECT id FROM values_test')),
        '{"id":1}',
        'integer results must remain JSON serializable',
      );
    });

    test('strict anonymous bindings ignore SQL literals, identifiers and comments', (t) => {
      const db = fixture(t).open();
      assert.deepEqual(
        db.get('SELECT \'?\' AS "?", ? AS [value] /* ? */ -- ?\n', 'bound'),
        { '?': '?', value: 'bound' },
        'only real placeholders must count toward binding arity',
      );
      for (const values of [[], [1, 2]])
        assert.throws(
          () => db.get('SELECT ?', ...values),
          TypeError,
          'missing and extra bindings must throw',
        );
      for (const placeholder of [':value', '$value', '@value', '?1'])
        assert.throws(
          () => db.get(`SELECT ${placeholder}`, 1),
          TypeError,
          'named and numbered bindings must be rejected',
        );
      for (const value of [undefined, true, {}, [], NaN, Infinity])
        assert.throws(
          () => db.get('SELECT ?', value as SqlValue),
          TypeError,
          'unsupported values must throw instead of binding NULL or coercing',
        );
    });

    test('safe integers round-trip and oversized integer reads throw', (t) => {
      const db = fixture(t).open();
      assert.deepEqual(
        db.get('SELECT ? AS value', BigInt(Number.MAX_SAFE_INTEGER)),
        { value: Number.MAX_SAFE_INTEGER },
        'safe integer reads must use numbers',
      );
      assert.throws(
        () => db.get('SELECT ? AS value', 9007199254740993n),
        RangeError,
        'unsafe integer reads must throw instead of rounding',
      );
    });

    test('only unique constraints receive the portable unique category', (t) => {
      const db = fixture(t).open();
      db.exec(
        'CREATE TABLE unique_test(id TEXT PRIMARY KEY, name TEXT UNIQUE, value TEXT NOT NULL)',
      );
      db.run('INSERT INTO unique_test VALUES(?,?,?)', 'one', 'name', 'value');
      for (const [id, name] of [
        ['one', 'other'],
        ['two', 'name'],
      ])
        assert.throws(
          () => db.run('INSERT INTO unique_test VALUES(?,?,?)', id, name, 'value'),
          (error) =>
            isUniqueViolation(error) && error instanceof Error && error.cause instanceof Error,
          'primary-key and unique errors must retain a portable category and original cause',
        );
      assert.throws(
        () => db.run('INSERT INTO unique_test VALUES(?,?,?)', 'three', 'third', null),
        (error) => !isUniqueViolation(error),
        'NOT NULL violations must not be misclassified as duplicates',
      );
      assert.throws(
        () => db.exec('INVALID SQL'),
        (error) => !isUniqueViolation(error),
        'unexpected SQL failures must not become unique errors',
      );
    });

    test('commit persists, rollback discards and handles close deterministically', (t) => {
      const f = fixture(t);
      const db = f.open();
      db.exec('CREATE TABLE tx(value TEXT); BEGIN IMMEDIATE');
      db.run('INSERT INTO tx VALUES(?)', 'committed');
      db.exec('COMMIT; BEGIN IMMEDIATE');
      db.run('INSERT INTO tx VALUES(?)', 'rolled back');
      db.exec('ROLLBACK');
      db.close();
      assert.throws(
        () => db.get('SELECT * FROM tx'),
        Error,
        'queries after close must fail synchronously',
      );
      assert.throws(() => db.close(), Error, 'closing twice must report a closed connection');
      assert.deepEqual(
        f.open().all('SELECT * FROM tx'),
        [{ value: 'committed' }],
        'reopening must preserve committed values without rolled-back writes',
      );
    });

    test('busy writes have a bounded wait and preserve the busy category', (t) => {
      const f = fixture(t);
      const db = f.open();
      db.exec('CREATE TABLE busy_test(value TEXT); BEGIN IMMEDIATE');
      const other = f.open();
      other.exec('PRAGMA busy_timeout=30');
      const start = performance.now();
      assert.throws(
        () => other.run('INSERT INTO busy_test VALUES(?)', 'blocked'),
        (error) =>
          error instanceof DbError && error.kind === 'busy' && error.cause instanceof Error,
        'contention must throw a portable busy error with its original cause',
      );
      assert.ok(performance.now() - start < 1000, 'a 30 ms busy wait must not stall for a second');
      db.exec('ROLLBACK');
      assert.deepEqual(
        other.run('INSERT INTO busy_test VALUES(?)', 'unblocked'),
        { changes: 1 },
        'the connection must remain usable after contention ends',
      );
    });

    test('read-only opening rejects missing files and writes without mutating existing data', (t) => {
      const f = fixture(t);
      assert.throws(() => f.open(true), Error, 'read-only open must reject a missing file');
      assert.equal(
        fs.existsSync(f.filename),
        false,
        'read-only open must never create the missing file',
      );
      const db = f.open();
      db.exec('CREATE TABLE snapshot(value TEXT)');
      db.run('INSERT INTO snapshot VALUES(?)', 'saved');
      db.close();
      const snapshot = f.open(true);
      assert.deepEqual(
        snapshot.get('SELECT * FROM snapshot'),
        { value: 'saved' },
        'read-only connections must read persisted data',
      );
      assert.throws(
        () => snapshot.run('INSERT INTO snapshot VALUES(?)', 'bad'),
        Error,
        'read-only connections must reject writes',
      );
      snapshot.close();
      fs.renameSync(f.filename, `${f.filename}.restored`);
      assert.equal(
        fs.existsSync(`${f.filename}.restored`),
        true,
        'closing must release the snapshot for file replacement',
      );
    });
  });
}
