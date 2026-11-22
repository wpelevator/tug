import test from 'node:test';
import assert from 'node:assert/strict';
import { backupCheckProblems, NO_DESTINATION, NO_TARGETS } from './check.ts';
import type { VerifyRecord } from './check.ts';

const target = (name: string, problem: string | null = null, enabled = true) => ({
  target: name,
  enabled,
  problem,
});

test('a healthy project has no problems', () => {
  assert.deepEqual(
    backupCheckProblems({
      destinationConfigured: true,
      targets: [target('service:db'), target('volume:uploads')],
    }),
    [],
  );
});

test('each failing or stale target is reported by name, and a missing destination comes first', () => {
  assert.deepEqual(
    backupCheckProblems({
      destinationConfigured: false,
      targets: [target('service:db', 'the last run failed'), target('volume:uploads')],
    }),
    ['no backup destination is configured', 'service:db: the last run failed'],
  );
});

test('without requireProtection (the TUI), disabled targets and projects without targets are not problems', () => {
  assert.deepEqual(
    backupCheckProblems({
      destinationConfigured: false,
      targets: [target('service:old', 'the last run failed', false)],
    }),
    [],
    'a target removed from the Compose file stops being checked',
  );
  assert.deepEqual(backupCheckProblems({ destinationConfigured: false, targets: [] }), []);
});

test('a failed or stale control backup is a problem, and a healthy one is not', () => {
  assert.deepEqual(
    backupCheckProblems({
      destinationConfigured: true,
      targets: [],
      control: { problem: 'the last control backup failed: boom' },
    }),
    ['control: the last control backup failed: boom'],
    'the control backup problem is reported even when the project has no targets',
  );
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: true, targets: [], control: { problem: null } }),
    [],
    'a healthy control backup adds nothing',
  );
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: false, targets: [], control: null }),
    [],
    'no destination means no control backup to judge',
  );
});

test('--check (requireProtection) fails when nothing is protected', () => {
  const strict = { requireProtection: true };
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: false, targets: [] }, strict),
    [NO_DESTINATION, NO_TARGETS],
    'a project with no destination and no targets must not look healthy to a monitor',
  );
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: true, targets: [] }, strict),
    [NO_TARGETS],
    'a destination alone protects nothing in the project',
  );
  assert.deepEqual(
    backupCheckProblems(
      { destinationConfigured: true, targets: [target('service:old', null, false)] },
      strict,
    ),
    [NO_TARGETS],
    'only disabled targets count as no targets',
  );
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: true, targets: [target('service:db')] }, strict),
    [],
    'a destination and a healthy enabled target pass',
  );
});

test('--allow-empty accepts a project without targets but still requires a destination', () => {
  const lenient = { requireProtection: true, allowEmpty: true };
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: true, targets: [] }, lenient),
    [],
    'a stateless project with a destination passes with --allow-empty',
  );
  assert.deepEqual(
    backupCheckProblems({ destinationConfigured: false, targets: [] }, lenient),
    [NO_DESTINATION],
    'a missing destination still fails with --allow-empty',
  );
});

const withRetention = (retention: {
  state: 'ok' | 'failed' | 'external';
  failures: number;
  message?: string;
  locked?: boolean;
}) => ({
  ...target('service:db'),
  retention,
});

test('one retention failure is not a problem, two in a row are, and a recovery clears it', () => {
  const check = (retention: Parameters<typeof withRetention>[0]) =>
    backupCheckProblems({ destinationConfigured: true, targets: [withRetention(retention)] });
  assert.deepEqual(
    check({ state: 'failed', failures: 1, message: 'overlap' }),
    [],
    "a single failure is harmless: a prune can overlap another node's backup on a shared repository",
  );
  assert.match(
    check({ state: 'failed', failures: 2, message: 'prune failed' })[0],
    /service:db: retention is failing.*2 runs in a row.*prune failed/,
    'two consecutive failures make the monitor fail and say why',
  );
  assert.deepEqual(check({ state: 'ok', failures: 0 }), [], 'a prune that works again is green');
});

test("a retention failure that was restic's lock exit fails the check at once", () => {
  assert.match(
    backupCheckProblems({
      destinationConfigured: true,
      targets: [withRetention({ state: 'failed', failures: 1, locked: true })],
    })[0],
    /retention is failing.*repository is locked/,
    'a lock failure is not an overlap to wait out',
  );
});

test("external retention never fails the check, and control's retention follows the same rule", () => {
  assert.deepEqual(
    backupCheckProblems({
      destinationConfigured: true,
      targets: [withRetention({ state: 'external', failures: 0 })],
    }),
    [],
    'an append-only destination that is managed from the storage side is healthy',
  );
  assert.match(
    backupCheckProblems({
      destinationConfigured: true,
      targets: [],
      control: { problem: null, retention: { state: 'failed', failures: 2, message: 'denied' } },
    })[0],
    /^control: retention is failing/,
    "control's own backup is judged like a target",
  );
});

const maintenance = (over: Partial<VerifyRecord> = {}): VerifyRecord => ({
  startedAt: '2026-11-02T00:00:00.000Z',
  finishedAt: '2026-11-02T00:10:00.000Z',
  trigger: 'schedule',
  ok: false,
  prune: 'failed',
  check: 'ok',
  failures: 1,
  message: 'prune failed: unable to create lock',
  ...over,
});
const withVerify = (verify: VerifyRecord, now?: number) =>
  backupCheckProblems(
    { destinationConfigured: true, targets: [target('service:db')], verify },
    { now: now ?? Date.parse('2026-11-03T00:00:00Z') },
  );

test('a lock overlap, an unresponsive node or a timeout in maintenance is a problem only the second time in a row', () => {
  assert.deepEqual(
    withVerify(maintenance({ transient: true, locked: true })),
    [],
    'one locked prune may be another node holding a shared lock, so it does not fail --check',
  );
  assert.match(
    withVerify(maintenance({ transient: true, locked: true, failures: 2 }))[0],
    /repository check or prune failed.*2 times in a row/,
    'a second failure in a row fails --check and says how many',
  );
});

test('a maintenance failure that is not an overlap fails --check at once, and a pass clears it', () => {
  assert.match(
    withVerify(
      maintenance({ check: 'failed', prune: 'skipped', message: 'pack abc is damaged' }),
    )[0],
    /repository check or prune failed.*pack abc is damaged/,
    'restic finding a problem in the repository is reported on the first failure',
  );
  assert.deepEqual(
    withVerify(maintenance({ ok: true, prune: 'ok', failures: 0 })),
    [],
    'a passing maintenance is green',
  );
});

test('a repository nobody has maintained for more than 14 days is a problem, even when its last result passed', () => {
  const passing = maintenance({ ok: true, prune: 'ok', failures: 0 });
  const day = 24 * 3_600_000;
  const finished = Date.parse(passing.finishedAt);
  assert.deepEqual(
    withVerify(passing, finished + 13 * day),
    [],
    'a repository maintained 13 days ago is within the weekly cadence plus retries',
  );
  assert.match(
    withVerify(passing, finished + 15 * day)[0],
    /last checked 2026-11-02.*more than 14 days ago.*online node/,
    'a repository with no recent maintenance is reported, as the weekly job silently skips a project with no online node',
  );
  assert.deepEqual(
    backupCheckProblems(
      {
        destinationConfigured: true,
        targets: [target('service:db', null, false)],
        verify: passing,
      },
      { now: finished + 30 * day },
    ),
    [],
    'a project with no enabled targets has nothing to verify',
  );
  assert.match(
    backupCheckProblems(
      { destinationConfigured: true, targets: [], control: { problem: null, verify: passing } },
      { now: finished + 30 * day },
    )[0],
    /^control: the repository was last checked/,
    "control's own repository is held to the same cadence",
  );
});
