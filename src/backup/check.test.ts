import test from 'node:test';
import assert from 'node:assert/strict';
import { backupCheckProblems } from './check.ts';

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

test('disabled targets and projects without targets are not problems', () => {
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
