import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { immediateTransaction } from './transaction.ts';

test('immediate transactions commit results and roll back all writes on failure', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE transaction_test(value TEXT)');
  const result = immediateTransaction(db, () => {
    db.run('INSERT INTO transaction_test VALUES(?)', 'committed');
    return 42;
  });
  assert.equal(result, 42, 'transactions must return the callback result after committing');
  const failure = new Error('operation failed');
  assert.throws(
    () =>
      immediateTransaction(db, () => {
        db.run('INSERT INTO transaction_test VALUES(?)', 'rolled back');
        throw failure;
      }),
    (error) => error === failure,
    'transactions must preserve the original callback failure',
  );
  assert.deepEqual(
    db.all('SELECT value FROM transaction_test'),
    [{ value: 'committed' }],
    'failed transactions must leave no partial writes',
  );
  immediateTransaction(db, () => db.run('INSERT INTO transaction_test VALUES(?)', 'next'));
  assert.equal(
    db.all('SELECT * FROM transaction_test').length,
    2,
    'the connection must be reusable after rollback',
  );
});

test('failed nested BEGIN leaves the outer transaction intact', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE transaction_test(value TEXT)');
  immediateTransaction(db, () => {
    db.run('INSERT INTO transaction_test VALUES(?)', 'outer');
    assert.throws(
      () => immediateTransaction(db, () => assert.fail('nested callback must not run')),
      /transaction/i,
      'nested transactions must fail before invoking their callback',
    );
  });
  assert.deepEqual(
    db.all('SELECT * FROM transaction_test'),
    [{ value: 'outer' }],
    'a rejected nested BEGIN must not roll back the outer transaction',
  );
});

test('commit failures roll back and rollback failures preserve the original error', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE transaction_test(value TEXT)');
  const failure = new Error('commit failed');
  const calls: string[] = [];
  const failingCommit = {
    ...db,
    exec(sql: string) {
      calls.push(sql);
      if (sql === 'COMMIT') throw failure;
      db.exec(sql);
    },
  };
  assert.throws(
    () =>
      immediateTransaction(failingCommit, () =>
        db.run('INSERT INTO transaction_test VALUES(?)', 'lost'),
      ),
    (error) => error === failure,
    'commit failures must propagate unchanged',
  );
  assert.deepEqual(
    calls,
    ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'],
    'commit failures must trigger rollback',
  );
  assert.deepEqual(
    db.all('SELECT * FROM transaction_test'),
    [],
    'failed commits must not retain writes',
  );
  const failingRollback = {
    ...db,
    exec(sql: string) {
      if (sql === 'ROLLBACK') {
        db.exec(sql);
        throw new Error('rollback failed');
      }
      db.exec(sql);
    },
  };
  assert.throws(
    () =>
      immediateTransaction(failingRollback, () => {
        throw failure;
      }),
    (error) => error === failure,
    'rollback failures must not mask the original error',
  );
});

test('transaction callbacks must finish synchronously', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE transaction_test(value TEXT)');
  const callback: () => unknown = () => {
    db.run('INSERT INTO transaction_test VALUES(?)', 'invalid');
    return { then() {} };
  };
  assert.throws(
    () => immediateTransaction(db, callback),
    /synchronous callbacks/,
    'thenable results must be rejected before commit',
  );
  assert.deepEqual(
    db.all('SELECT * FROM transaction_test'),
    [],
    'rejecting a thenable must roll back synchronous writes',
  );
});
