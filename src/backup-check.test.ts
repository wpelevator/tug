import test from 'node:test';
import assert from 'node:assert/strict';
import { backupCheckProblems } from './backup-check.ts';

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
