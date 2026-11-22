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
  ...over,
});
const base = {
  local: false,
  healthy: true,
  lastSuccessAt: '2026-11-01T03:00:00.000Z',
  verify: null,
  restoreTested: false,
};

test('protection levels claim no more than ran: off-host, then verified after the latest backup, then restore-tested', () => {
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
    'a check that started after the latest backup verifies it',
  );
  assert.equal(
    protectionLevel({ ...base, lastSuccessAt: '2026-11-03T03:00:00.000Z', verify: record() }),
    'off-host',
    'a backup newer than the check is not covered by it',
  );
  assert.equal(
    protectionLevel({ ...base, verify: record({ check: 'failed', ok: false }) }),
    'off-host',
    'a failed check verifies nothing',
  );
  assert.equal(
    protectionLevel({ ...base, verify: record(), restoreTested: true }),
    'restore-tested',
    'a verified target with a succeeded scratch restore is restore-tested',
  );
  assert.equal(
    protectionLevel({ ...base, restoreTested: true }),
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
  assert.deepEqual(backupCheckProblems(listing(record())), [], 'a passing check is no problem');
  assert.deepEqual(backupCheckProblems(listing(null)), [], 'no check yet is no problem');
  const failed = record({ ok: false, check: 'failed', message: 'check failed: bad pack' });
  const [problem] = backupCheckProblems(listing(failed));
  assert.match(problem, /repository check or prune failed.*bad pack/, 'the failure is named');
  assert.match(
    backupCheckProblems(listing(record(), failed))[0],
    /^control: /,
    "control's own repository is judged too",
  );
  assert.equal(verifyProblem(record()), null, 'a passing record has no problem');
});

test('backup list prints the last repository check', () => {
  assert.equal(verifyColumn(null), '', 'nothing before a repository was checked');
  assert.match(verifyColumn(record()), /^\tverify ok \(2026-11-02, pruned\)$/, 'a pass says when');
  assert.match(
    verifyColumn(record({ trigger: 'manual', prune: 'skipped', subset: '5%' })),
    /verify ok \(2026-11-02, subset 5%, manual\)/,
    'a manual subset check says so',
  );
  assert.match(verifyColumn(record({ ok: false })), /verify FAILED/, 'a failure is loud');
});
