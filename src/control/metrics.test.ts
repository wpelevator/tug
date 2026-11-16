import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { renderMetricsSnapshot } from './metrics.ts';

test('metrics render ages, report presence, deployment outcomes, backup state and queue values', () => {
  const now = Date.parse('2026-01-01T00:00:10.000Z');
  const output = renderMetricsSnapshot({
    now,
    nodes: [
      { name: 'edge-a', lastSeenAt: '2026-01-01T00:00:05.000Z' },
      { name: 'edge-b', lastSeenAt: null },
    ],
    deployments: [
      { project: 'shop', state: 'succeeded', outcome: 'success', count: 2 },
      { project: 'shop', state: 'failed', outcome: 'failure' },
      { project: 'shop', state: 'unexpected-secret-state', outcome: 'unexpected' },
    ],
    backups: [
      {
        project: 'shop',
        target: 'db',
        state: 'succeeded',
        succeededAt: '2026-01-01T00:00:02.000Z',
      },
      { project: 'shop', target: 'uploads', state: 'failed' },
    ],
    queue: { depth: 2.7, activeSince: '2026-01-01T00:00:08.000Z' },
  });

  assert.match(
    output,
    /tug_node_poll_age_seconds\{node="edge-a"\} 5/,
    'node poll age is in seconds',
  );
  assert.match(
    output,
    /tug_node_reported\{node="edge-b"\} 0/,
    'never-reported nodes are not presented as fresh',
  );
  assert.match(
    output,
    /tug_deployments\{project="shop",state="succeeded",outcome="success"\} 2/,
    'deployment row counts are aggregated',
  );
  assert.match(
    output,
    /state="other",outcome="other"/,
    'deployment labels are constrained to finite values',
  );
  assert.match(
    output,
    /tug_backup_success_age_seconds\{project="shop",target="db"\} 8/,
    'backup success age is in seconds',
  );
  assert.match(
    output,
    /tug_backup_targets\{project="shop",target="uploads",state="failed"\} 1/,
    'backup target states are reported from the supplied schedule snapshot',
  );
  assert.match(
    output,
    /tug_backup_has_success\{project="shop",target="uploads"\} 0/,
    'configured targets without a success are explicit',
  );
  assert.match(
    output,
    /tug_writer_queue_depth 2/,
    'global queue depth is non-negative and integral',
  );
  assert.match(output, /tug_writer_active_age_seconds 2/, 'global active queue age is in seconds');
  assert.ok(output.endsWith('\n'), 'Prometheus output ends in a newline');
});

test('metrics escape label values and never include resource IDs or error text', () => {
  const output = renderMetricsSnapshot({
    now: 1000,
    nodes: [{ name: 'edge"\\\nname', lastSeenAt: 0 }],
    deployments: [{ project: 'shop', state: 'failed' }],
  });

  assert.match(
    output,
    /node="edge\\"\\\\\\nname"/,
    'Prometheus labels escape quotes, backslashes and newlines',
  );
  assert.doesNotMatch(
    output,
    /deployment_id|error_message|failure detail/,
    'resource IDs and error details are never exported',
  );
});

test('global queue values are rendered without project or resource labels', () => {
  const output = renderMetricsSnapshot({ queue: { depth: 0 } });
  assert.match(
    output,
    /tug_writer_queue_depth 0/,
    'global queue depth has no project or resource labels',
  );
  assert.match(output, /tug_writer_active_age_seconds 0/, 'idle global queue age is zero seconds');
});

test('omitting global queue values omits samples from project-scoped snapshots', () => {
  const output = renderMetricsSnapshot({ deployments: [{ project: 'shop', state: 'succeeded' }] });
  assert.doesNotMatch(
    output,
    /tug_writer_queue_depth\s+\d/,
    'project metrics omit global writer queue depth',
  );
  assert.doesNotMatch(
    output,
    /tug_writer_active_age_seconds\s+\d/,
    'project metrics omit global writer age',
  );
});

test('every exported metric family is documented for operators', async () => {
  const docs = await fs.readFile(new URL('../../docs/observability.md', import.meta.url), 'utf8');
  const output = renderMetricsSnapshot({ queue: { depth: 0 } });
  for (const match of output.matchAll(/^# HELP (\w+)/gm))
    assert.ok(docs.includes(match[1]), 'observability docs must explain ' + match[1]);
});
