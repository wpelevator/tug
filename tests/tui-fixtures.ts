import type { StatusResponse } from '../src/cli/status.ts';
import { emptySnapshot } from '../src/cli/tui/types.ts';
import type { BackupListing, EventRow, Snapshot } from '../src/cli/tui/types.ts';

/** A fixed "now" so ages in rendered text are stable. */
export const NOW = Date.parse('2026-11-09T12:00:00Z');
export const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

const report = (
  project: string,
  node_id: string,
  node: string,
  health: string,
  serviceStates: Record<string, { rolloutState: string; rolloutError?: string; image?: string }>,
  error?: string,
) => ({
  project_id: project,
  node_id,
  node,
  health,
  observed_version: 'v42',
  status_json: JSON.stringify({
    project,
    observedVersion: 'v42',
    health,
    services: Object.keys(serviceStates),
    serviceStates,
    ...(error && { error }),
  }),
});

/** Two projects on four nodes: `site/web` fails on app2 and app3 has gone stale. */
export function unhealthyStatus(): StatusResponse {
  return {
    projects: [
      { id: 'site', current_deployment_id: 'dep_site42' },
      { id: 'blog', current_deployment_id: 'dep_blog7' },
    ],
    deployments: [
      {
        id: 'dep_site42',
        project_id: 'site',
        version: 'v42',
        state: 'succeeded',
        error_message: null,
        created_at: ago(7200),
        actor: 'ci-github',
      },
      {
        id: 'dep_blog7',
        project_id: 'blog',
        version: 'v7',
        state: 'succeeded',
        error_message: null,
        created_at: ago(3 * 86400),
        actor: 'kaspars',
      },
    ],
    nodes: [
      { id: 'node_1', name: 'app1', status: 'online', last_seen_at: ago(3) },
      { id: 'node_2', name: 'app2', status: 'online', last_seen_at: ago(2) },
      { id: 'node_3', name: 'app3', status: 'stale', last_seen_at: ago(720) },
      { id: 'node_4', name: 'app4', status: 'online', last_seen_at: ago(4) },
    ],
    statuses: [
      report('site', 'node_1', 'app1', 'serving', {
        web: { rolloutState: 'serving' },
        db: { rolloutState: 'serving' },
      }),
      report(
        'site',
        'node_2',
        'app2',
        'failed',
        {
          web: {
            rolloutState: 'health_checking',
            rolloutError: 'health check GET /healthz returned 503',
            image: 'ghcr.io/acme/site@sha256:abc',
          },
        },
        'health check GET /healthz returned 503',
      ),
      report('site', 'node_3', 'app3', 'serving', { db: { rolloutState: 'serving' } }),
      report('blog', 'node_4', 'app4', 'serving', {
        web: { rolloutState: 'serving' },
        db: { rolloutState: 'serving' },
      }),
    ],
  };
}

/** The same fleet with nothing wrong. */
export function healthyStatus(): StatusResponse {
  const status = unhealthyStatus();
  status.nodes = status.nodes.map((node) => ({ ...node, status: 'online', last_seen_at: ago(3) }));
  status.statuses = [
    report('site', 'node_1', 'app1', 'serving', {
      web: { rolloutState: 'serving' },
      db: { rolloutState: 'serving' },
    }),
    report('site', 'node_2', 'app2', 'serving', { web: { rolloutState: 'serving' } }),
    report('blog', 'node_4', 'app4', 'serving', {
      web: { rolloutState: 'serving' },
      db: { rolloutState: 'serving' },
    }),
  ];
  return status;
}

export const event = (
  over: Partial<EventRow> & Pick<EventRow, 'id' | 'type' | 'message'>,
): EventRow => ({
  project_id: 'site',
  node_id: null,
  level: 'info',
  created_at: ago(60),
  actor: null,
  ...over,
});

export const staleBackup: BackupListing = {
  destinationConfigured: true,
  targets: [
    {
      target: 'service:db',
      node: 'app1',
      schedule: 'daily',
      enabled: true,
      nextRunAt: ago(-3600),
      lastSuccessAt: ago(31 * 3600),
      lastStatus: 'succeeded',
      problem: 'last success 31h ago, schedule daily',
    },
  ],
  runs: [],
};
export const okBackup: BackupListing = {
  destinationConfigured: true,
  targets: [{ ...staleBackup.targets[0], lastSuccessAt: ago(3600), problem: null }],
  runs: [],
};

/** A snapshot as the poller would leave it after one good pass. */
export function snapshotOf(status: StatusResponse, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    ...emptySnapshot(),
    status: { data: status, fetchedAt: NOW - 2000 },
    events: { data: [], fetchedAt: NOW - 2000 },
    whoami: { data: { name: 'root', role: 'admin', projects: null }, fetchedAt: NOW },
    version: { data: '1.2.0', fetchedAt: NOW },
    backups: {
      data: { site: okBackup, blog: { destinationConfigured: true, targets: [], runs: [] } },
      fetchedAt: NOW,
    },
    restores: { data: { site: [], blog: [] }, fetchedAt: NOW },
    ...extra,
  };
}
