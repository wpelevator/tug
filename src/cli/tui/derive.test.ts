import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW,
  ago,
  event,
  healthyStatus,
  okBackup,
  snapshotOf,
  staleBackup,
  unhealthyStatus,
} from '../../../tests/tui-fixtures.ts';
import { UNREACHABLE_SECONDS, deriveAttention, deriveCounters, nodeReports } from './derive.ts';

const keys = (items: ReturnType<typeof deriveAttention>) => items.map((item) => item.key);

test('a healthy fleet has an empty attention list, which is what the screen shows as all clear', () => {
  const attention = deriveAttention(snapshotOf(healthyStatus()), NOW, '1.2.0');
  assert.deepEqual(attention, [], 'nothing is wrong, so nothing is listed');
});

test('a failed apply outranks a stale node, which outranks a backup problem', () => {
  const snapshot = snapshotOf(unhealthyStatus(), {
    backups: { data: { site: staleBackup }, fetchedAt: NOW },
  });
  const attention = deriveAttention(snapshot, NOW, '1.2.0');
  assert.deepEqual(
    attention.map((item) => item.rank),
    [1, 2, 3],
    'failed service, stale node and backup problem rank 1, 2 and 3 in that order',
  );
  assert.equal(
    attention[0].subject,
    'site/web on app2',
    'the failure names the project, service and node',
  );
  assert.match(
    attention[0].reason,
    /health check GET \/healthz returned 503/,
    'the failure carries the agent’s reason',
  );
  assert.match(
    attention[1].reason,
    /hosts site\/db/,
    'a stale node names what it hosts, so the blast radius is visible',
  );
  assert.deepEqual(
    attention[0].target,
    { name: 'placement', project: 'site', service: 'web', node: 'app2' },
    'Enter on the failure opens that placement',
  );
});

test('a stale node’s last report is not read as current health', () => {
  const status = unhealthyStatus();
  status.statuses[2].health = 'failed';
  status.statuses[2].status_json = JSON.stringify({
    health: 'failed',
    error: 'old error',
    serviceStates: { db: { rolloutState: 'health_checking', rolloutError: 'old error' } },
  });
  const attention = deriveAttention(snapshotOf(status), NOW);
  assert.ok(
    !keys(attention).some((key) => key.includes('@app3')),
    'a stale node is reported as stale, not as a failed apply',
  );
  const counters = deriveCounters(snapshotOf(status), NOW, attention);
  assert.equal(counters.servicesServing, 4, 'the stale node’s service is not counted as serving');
  assert.equal(counters.servicesTotal, 6, 'it is still counted as expected');
});

test('control is unreachable only after it has been silent for a while, and at once before the first answer', () => {
  const recent = snapshotOf(healthyStatus());
  recent.status = { data: recent.status.data, fetchedAt: NOW - 1000, error: 'ECONNRESET' };
  assert.deepEqual(
    deriveAttention(recent, NOW),
    [],
    'one failed poll right after a good one is not an alarm',
  );
  const silent = snapshotOf(healthyStatus());
  silent.status = {
    data: silent.status.data,
    fetchedAt: NOW - (UNREACHABLE_SECONDS + 5) * 1000,
    error: 'ECONNRESET',
  };
  const [item] = deriveAttention(silent, NOW);
  assert.equal(item.rank, 1, 'a silent control is the highest rank');
  assert.match(item.reason, /no answer for 20s: ECONNRESET/, 'the reason says how long and why');
  const never = snapshotOf(healthyStatus());
  never.status = { error: 'connect ECONNREFUSED' };
  assert.equal(
    deriveAttention(never, NOW)[0].key,
    'control',
    'a control that never answered is reported immediately',
  );
});

test('failed, stuck and automatically rolled back deployments are reported once per project', () => {
  const status = healthyStatus();
  status.deployments = [
    {
      id: 'dep_new',
      project_id: 'site',
      version: 'v43',
      state: 'failed',
      error_message: 'image pull denied',
      created_at: ago(300),
      actor: 'ci',
    },
    ...status.deployments,
    {
      id: 'dep_slow',
      project_id: 'blog',
      version: 'v8',
      state: 'rolling_out',
      error_message: null,
      created_at: ago(30 * 60),
      actor: 'kaspars',
    },
  ];
  const events = [
    event({
      id: 'evt_rb',
      type: 'deployment.auto_rollback',
      message: 'rolled back to v42',
      actor: 'system:auto-rollback',
    }),
  ];
  const attention = deriveAttention(
    snapshotOf(status, { events: { data: events, fetchedAt: NOW } }),
    NOW,
  );
  assert.ok(
    attention.some(
      (item) => item.key === 'deployment:dep_new' && /image pull denied/.test(item.reason),
    ),
    'the failed deployment names its error',
  );
  assert.ok(
    attention.some((item) => item.key === 'stuck:dep_slow'),
    'a rollout running for 30 minutes is reported as stuck',
  );
  assert.ok(
    attention.some((item) => item.key === 'auto-rollback:site'),
    'an automatic rollback in the last day is reported',
  );
});

test('backup problems, a missing destination, interrupted restores and public ports are ranked and described', () => {
  const snapshot = snapshotOf(healthyStatus(), {
    backups: { data: { site: { ...okBackup, destinationConfigured: false } }, fetchedAt: NOW },
    restores: {
      data: {
        site: [
          {
            id: 'rst_1',
            target: 'service:db',
            state: 'interrupted',
            error: 'disk full',
            state_changed_at: ago(600),
          },
        ],
      },
      fetchedAt: NOW,
    },
    events: {
      data: [
        event({
          id: 'evt_p',
          type: 'ports.public',
          level: 'warn',
          message: 'web publishes 8080 publicly',
        }),
      ],
      fetchedAt: NOW,
    },
  });
  const attention = deriveAttention(snapshot, NOW);
  const byKey = new Map(attention.map((item) => [item.key, item]));
  assert.equal(
    byKey.get('restore:rst_1')?.rank,
    1,
    'an interrupted restore keeps writers held, so it is rank 1',
  );
  assert.match(
    byKey.get('restore:rst_1')?.reason ?? '',
    /tug restore resume rst_1/,
    'the reason says how to continue',
  );
  assert.ok(
    [...byKey.keys()].some(
      (key) =>
        key.startsWith('backup:site:') && /no backup destination/.test(byKey.get(key)!.reason),
    ),
    'a missing destination is a backup problem',
  );
  assert.equal(byKey.get('ports:evt_p')?.rank, 4, 'public ports are informational');
});

test('version skew and diagnostics warnings appear at rank 3', () => {
  const snapshot = snapshotOf(healthyStatus(), {
    version: { data: '1.3.0' },
    diagnostics: {
      data: {
        ok: true,
        checks: [
          { name: 'certificates', ok: true, warnings: ['app2 certificate expires in 6 days'] },
        ],
      },
    },
  });
  const attention = deriveAttention(snapshot, NOW, '1.2.0');
  assert.deepEqual(
    attention.map((item) => item.rank),
    [3, 3],
    'skew and the certificate warning are both rank 3',
  );
  assert.ok(
    attention.some((item) => /control runs 1.3.0, this CLI is 1.2.0/.test(item.reason)),
    'skew names both versions',
  );
});

test('an unreadable node report does not throw and is not counted as healthy', () => {
  const status = healthyStatus();
  status.statuses[0].status_json = '{not json';
  const reports = nodeReports(status);
  assert.equal(reports[0].unreadable, true, 'the report is flagged unreadable instead of throwing');
  assert.doesNotThrow(
    () => deriveAttention(snapshotOf(status), NOW),
    'a corrupt report cannot break the screen',
  );
});

test('counters equal what the attention list implies', () => {
  const snapshot = snapshotOf(unhealthyStatus(), {
    backups: { data: { site: staleBackup }, fetchedAt: NOW },
    events: {
      data: [
        event({ id: 'a', type: 'service.failed', message: 'x', level: 'error' }),
        event({ id: 'b', type: 'ports.public', message: 'y', level: 'warn' }),
      ],
      fetchedAt: NOW,
    },
  });
  const attention = deriveAttention(snapshot, NOW);
  const counters = deriveCounters(snapshot, NOW, attention);
  assert.equal(counters.nodesOnline, 3, 'three of four nodes are online');
  assert.equal(counters.nodesTotal, 4, 'four nodes are registered');
  assert.equal(counters.servicesServing, 4, 'four services are known to be serving');
  assert.equal(
    counters.servicesTotal,
    6,
    'six services are expected, including the one on the stale node',
  );
  assert.equal(counters.backupProblems, 1, 'one backup problem is counted');
  assert.deepEqual(
    [counters.eventErrors, counters.eventWarnings],
    [1, 1],
    'recent events are counted by level',
  );
  assert.equal(
    counters.attention,
    attention.length,
    'the header counter is the length of the attention list',
  );
});

test('a node that is registered but whose agent never connected is listed as information', () => {
  const status = healthyStatus();
  status.nodes.push({ id: 'node_9', name: 'new1', status: 'registered', last_seen_at: null });
  const attention = deriveAttention(snapshotOf(status), NOW);
  assert.deepEqual(
    attention.map((item) => [item.rank, item.subject]),
    [[4, 'node new1']],
    'a freshly registered node is rank 4: worth seeing, not a failure',
  );
});

test('a failed apply is dated from the agent’s failed event, and not at all once a later serving event says it recovered', () => {
  const failed = event({
    id: 'f',
    type: 'service.failed',
    level: 'error',
    message: 'web on app2: health check returned 503',
    created_at: ago(240),
  });
  const recovered = event({
    id: 's',
    type: 'service.serving',
    message: 'web on app2 serving',
    created_at: ago(30),
  });
  const since = (events: ReturnType<typeof event>[]) =>
    deriveAttention(
      snapshotOf(unhealthyStatus(), { events: { data: events, fetchedAt: NOW } }),
      NOW,
    ).find((item) => item.key.startsWith('service:'))?.since;
  assert.equal(since([failed]), ago(240), 'the failure is dated from its failed event');
  assert.equal(
    since([recovered, failed]),
    undefined,
    'a newer serving event means the failure is not dated by the old one',
  );
  assert.equal(
    since([]),
    undefined,
    'with no event there is no age, rather than the age of the last poll',
  );
});

test('a backup problem is dated from the target’s last success', () => {
  const snapshot = snapshotOf(healthyStatus(), {
    backups: { data: { site: staleBackup }, fetchedAt: NOW },
  });
  const [item] = deriveAttention(snapshot, NOW);
  assert.equal(item.since, ago(31 * 3600), 'the age is how long since the backup last worked');
});

test('an unstable service is not counted as serving and carries its reason', () => {
  const status = healthyStatus();
  const first = status.statuses[0];
  const detail = JSON.parse(first.status_json ?? '{}') as {
    serviceStates?: Record<string, Record<string, unknown>>;
  };
  const name = Object.keys(detail.serviceStates ?? {})[0];
  detail.serviceStates![name].unstable = 'restarting after exiting with code 1';
  first.status_json = JSON.stringify(detail);
  const before = deriveCounters(snapshotOf(healthyStatus()), NOW, []);
  const after = deriveCounters(snapshotOf(status), NOW, []);
  assert.equal(
    after.servicesServing,
    before.servicesServing - 1,
    'a crash-looping service must not count as serving',
  );
});
