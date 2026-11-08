import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { lockQueries } from './locks.ts';
import { isUniqueViolation } from './driver.ts';

test('lock queries enforce exclusive names, owner checks and expiration boundaries', async (t) => {
  const db = await openDb(':memory:');
  t.after(() => db.close());
  const locks = lockQueries(db);
  const before = '2026-11-03T10:00:00.000Z';
  const expiry = '2026-11-03T10:10:00.000Z';
  const later = '2026-11-03T10:20:00.000Z';
  const lock = {
    name: 'project:site',
    owner: 'deploy:one',
    created_at: before,
    expires_at: expiry,
  };
  assert.equal(locks.find(lock.name), undefined, 'missing locks must return undefined');
  locks.insert(lock);
  assert.deepEqual(locks.find(lock.name), lock, 'stored lock fields must round-trip');
  assert.throws(
    () => locks.insert({ ...lock, owner: 'deploy:two' }),
    isUniqueViolation,
    'a second owner must not acquire the same lock',
  );
  assert.equal(
    locks.owns(lock.name, lock.owner, before),
    true,
    'the owner must hold an unexpired lease',
  );
  assert.equal(
    locks.owns(lock.name, 'other', before),
    false,
    'other owners must not hold the lease',
  );
  assert.equal(
    locks.owns(lock.name, lock.owner, expiry),
    false,
    'a lease expiring exactly now must not authorize publication',
  );
  locks.renew(lock.name, 'other', later);
  locks.release(lock.name, 'other');
  assert.deepEqual(
    locks.find(lock.name),
    lock,
    'another owner must neither renew nor release a lock',
  );
  locks.renew(lock.name, lock.owner, later);
  assert.equal(
    locks.find(lock.name)?.expires_at,
    later,
    'the owner must be able to renew the lease',
  );
  locks.purgeExpired(later);
  assert.ok(locks.find(lock.name), 'purging must preserve locks whose expiry equals the cutoff');
  locks.purgeExpired('2026-11-03T10:20:00.001Z');
  assert.equal(locks.find(lock.name), undefined, 'purging must remove locks older than the cutoff');
  locks.insert({ ...lock, owner: 'deploy:two' });
  locks.release(lock.name, lock.owner);
  assert.equal(
    locks.find(lock.name)?.owner,
    'deploy:two',
    'a stale owner must not release its successor lease',
  );
  locks.release(lock.name, 'deploy:two');
  assert.equal(
    locks.find(lock.name),
    undefined,
    'the current owner must be able to release its lease',
  );
});
