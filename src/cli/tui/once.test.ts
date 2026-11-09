import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW,
  healthyStatus,
  snapshotOf,
  staleBackup,
  unhealthyStatus,
  event,
} from '../../../tests/tui-fixtures.ts';
import { formatOnce, onceReport } from './once.ts';

test('a healthy fleet is ok and says all clear', () => {
  const report = onceReport(snapshotOf(healthyStatus()), NOW, '1.2.0');
  assert.equal(report.ok, true, 'nothing wrong means ok');
  assert.match(formatOnce(report, NOW), /All clear/, 'the text says so');
});

test('rank 1 to 3 problems fail the check and list one line per problem, ranked', () => {
  const report = onceReport(
    snapshotOf(unhealthyStatus(), { backups: { data: { site: staleBackup }, fetchedAt: NOW } }),
    NOW,
    '1.2.0',
  );
  assert.equal(
    report.ok,
    false,
    'a failed apply, a stale node and a backup problem fail the check',
  );
  const text = formatOnce(report, NOW);
  assert.match(text, /Attention \(3\)/, 'the heading counts the problems');
  assert.match(text, /✖ site\/web on app2: failed to apply/, 'the failure is listed first');
  assert.deepEqual(
    report.attention.map((item) => item.rank),
    [1, 2, 3],
    'JSON carries the rank of each',
  );
  assert.equal(report.counters.nodesOnline, 3, 'JSON carries the counters');
});

test('rank 4 information alone does not fail a monitor', () => {
  const snapshot = snapshotOf(healthyStatus(), {
    events: {
      data: [
        event({ id: 'p', type: 'ports.public', message: 'web publishes 8080', level: 'warn' }),
      ],
      fetchedAt: NOW,
    },
  });
  const report = onceReport(snapshot, NOW, '1.2.0');
  assert.equal(report.attention.length, 1, 'the public-ports note is shown');
  assert.equal(report.ok, true, 'but it is informational, so the exit code stays zero');
  assert.match(
    formatOnce(report, NOW),
    /^ {2}· /m,
    'it is marked with a dot rather than a warning triangle',
  );
});
