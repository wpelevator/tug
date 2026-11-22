import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINTENANCE_INTERVAL_MS,
  firstDueAt,
  maintenanceStore,
  parseSubset,
  protectionLevel,
} from './maintenance.ts';
import type { MaintenanceRecord } from './maintenance.ts';
import { backupCheckProblems, verifyProblem } from './check.ts';
import { openDb } from '../db/db.ts';
import { verifyColumn } from '../cli/commands/backup.ts';

const record = (over: Partial<MaintenanceRecord> = {}): MaintenanceRecord => ({
  prune: 'ok',
  check: 'ok',
  startedAt: '2026-11-02T00:00:00.000Z',
  finishedAt: '2026-11-02T00:10:00.000Z',
  trigger: 'schedule',
  ok: true,
  failures: 0,
  ...over,
});
const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-11-05T00:00:00.000Z');
const base = {
  local: false,
  healthy: true,
  lastSuccessAt: '2026-11-04T03:00:00.000Z',
  verify: null,
  restoreTestedAt: null,
  now: NOW,
};

test('protection levels claim no more than ran: off-host, then verified by a recent passing check, then restore-tested by a recent restore', () => {
  assert.equal(protectionLevel(base), 'off-host', 'a recent success off-host is off-host');
  assert.equal(
    protectionLevel({ ...base, local: true }),
    null,
    'a destination on the same host is not off-host',
  );
  assert.equal(
    protectionLevel({ ...base, healthy: false }),
    null,
    'a failing or stale target is not protected',
  );
  assert.equal(protectionLevel({ ...base, lastSuccessAt: null }), null, 'no success, no level');
  assert.equal(
    protectionLevel({ ...base, verify: record() }),
    'verified',
    'a passing check from the last few days verifies the target',
  );
  assert.equal(
    protectionLevel({ ...base, lastSuccessAt: '2026-11-04T23:00:00.000Z', verify: record() }),
    'verified',
    'a backup made after the check keeps the level: a daily backup with a weekly check stays verified',
  );
  assert.equal(
    protectionLevel({ ...base, verify: record({ check: 'failed', ok: false, failures: 1 }) }),
    'off-host',
    'a failed check verifies nothing',
  );
  assert.equal(
    protectionLevel({
      ...base,
      verify: record({ finishedAt: new Date(NOW - 7 * DAY - 3_600_000).toISOString() }),
    }),
    'verified',
    'a check a week and an hour old still counts: the weekly job may be a little late',
  );
  assert.equal(
    protectionLevel({
      ...base,
      verify: record({ finishedAt: new Date(NOW - 9 * DAY).toISOString() }),
    }),
    'off-host',
    'a check more than about eight days old no longer vouches for the repository',
  );
  assert.equal(
    protectionLevel({ ...base, verify: record(), restoreTestedAt: '2026-10-01T00:00:00.000Z' }),
    'restore-tested',
    'a verified target with a scratch restore inside 90 days is restore-tested',
  );
  assert.equal(
    protectionLevel({
      ...base,
      verify: record(),
      restoreTestedAt: new Date(NOW - 91 * DAY).toISOString(),
    }),
    'verified',
    'a scratch restore older than 90 days no longer counts',
  );
  assert.equal(
    protectionLevel({ ...base, restoreTestedAt: '2026-11-01T00:00:00.000Z' }),
    'off-host',
    'a restore test without a verifying check does not skip a level',
  );
});

test('the read-data subset accepts restic forms only', () => {
  assert.equal(parseSubset(undefined), undefined, 'no subset is allowed');
  for (const good of ['1/10', '5%', '2.5%', '500M', '10G'])
    assert.equal(parseSubset(good), good, `${good} is a valid subset`);
  for (const bad of ['all', '--x', '5 %', '1/', '10 GB; rm'])
    assert.throws(() => parseSubset(bad), /read-data-subset/, `${bad} is rejected`);
});

test('a repository first seen is due within its first week, at the same time every time', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  for (const name of ['site', 'blog', 'shop', '_control']) {
    const due = firstDueAt(name, now);
    assert.ok(
      due >= now && due < now + MAINTENANCE_INTERVAL_MS,
      `${name} is first due inside the week`,
    );
    assert.equal(firstDueAt(name, now), due, `${name} gets the same slot after a restart`);
  }
  assert.notEqual(
    firstDueAt('site', now),
    firstDueAt('blog', now),
    'projects are spread, not pruned together',
  );
});

test('maintenance records live in meta and are cleared with the destination', async () => {
  const db = await openDb(':memory:');
  const store = maintenanceStore(db);
  assert.equal(store.record('site'), null, 'nothing is recorded before a run');
  store.setRecord('site', record());
  store.setNextAt('site', Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(store.record('site')?.check, 'ok', 'the record is read back');
  assert.equal(store.nextAt('site'), Date.parse('2026-11-09T00:00:00Z'), 'the due time is kept');
  assert.equal(store.nextAt('other'), null, 'an unseen repository has no due time');
  store.clear();
  assert.equal(store.record('site'), null, 'the record is dropped');
  assert.equal(store.nextAt('site'), null, 'the due time is dropped');
});

test('a failed repository check turns --check red until a later check passes', () => {
  const listing = (verify: MaintenanceRecord | null, control?: MaintenanceRecord | null) => ({
    destinationConfigured: true,
    targets: [{ target: 'service:db', enabled: true, problem: null }],
    verify,
    ...(control !== undefined ? { control: { problem: null, verify: control } } : {}),
  });
  const problemsAt = (input: ReturnType<typeof listing>) =>
    backupCheckProblems(input, { now: NOW });
  assert.deepEqual(problemsAt(listing(record())), [], 'a passing check is no problem');
  assert.deepEqual(problemsAt(listing(null)), [], 'no check yet is no problem');
  const failed = record({
    ok: false,
    check: 'failed',
    failures: 1,
    message: 'check failed: bad pack',
  });
  const [problem] = problemsAt(listing(failed));
  assert.match(problem, /repository check or prune failed.*bad pack/, 'the failure is named');
  assert.match(
    problemsAt(listing(record(), failed))[0],
    /^control: /,
    "control's own repository is judged too",
  );
  assert.equal(verifyProblem(record(), NOW), null, 'a passing record has no problem');
});

test('backup list prints the last repository check', () => {
  assert.equal(verifyColumn(null), '', 'nothing before a repository was checked');
  assert.match(verifyColumn(record()), /^\tverify ok \(2026-11-02, pruned\)$/, 'a pass says when');
  assert.match(
    verifyColumn(record({ trigger: 'manual', prune: 'skipped', subset: '5%' })),
    /verify ok \(2026-11-02, subset 5%, manual\)/,
    'a manual subset check says so',
  );
  assert.match(
    verifyColumn(record({ ok: false, failures: 1 })),
    /verify FAILED/,
    'a failure is loud',
  );
  assert.match(
    verifyColumn(record({ ok: false, failures: 1, transient: true })),
    /verify failed .*will retry/,
    'a first lock or timeout failure says it will be retried',
  );
});
