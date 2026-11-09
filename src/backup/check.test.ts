import test from 'node:test';
import assert from 'node:assert/strict';
import { backupCheckProblems, NO_DESTINATION, NO_TARGETS } from './check.ts';

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
