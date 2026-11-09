import { formatTable } from './observe-format.ts';
/** The control status endpoint returns database rows and a JSON-encoded node report. */
export interface StatusResponse {
  projects: { id: string; current_deployment_id: string | null }[];
  deployments: {
    id: string;
    version: string;
    state: string;
    error_message: string | null;
    project_id?: string;
    created_at?: string;
    actor?: string | null;
  }[];
  nodes: {
    id: string;
    name: string;
    status: string;
    last_seen_at: string | null;
    /** Whether the node's agent holds its stream socket to control right now (absent from older controls). */
    connected?: boolean;
  }[];
  statuses: {
    project_id: string;
    node_id: string;
    node: string | null;
    health: string;
    observed_version: string | null;
    status_json: string;
  }[];
}

/** Render observations without treating a stale node's last report as current health. */
export function formatStatus(status: StatusResponse): string {
  const lines: string[] = [];
  const nodes = new Map(status.nodes.map((node) => [node.id, node]));
  for (const project of [...status.projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const deployment = status.deployments.find((item) => item.id === project.current_deployment_id);
    lines.push(`Project ${project.id}`);
    if (deployment) {
      lines.push(`  Deployment: ${deployment.version} (${deployment.state})`);
      if (deployment.error_message) lines.push(`  Error: ${deployment.error_message}`);
    } else {
      lines.push(
        project.current_deployment_id
          ? '  Deployment: current deployment not in recent results'
          : '  Deployment: none',
      );
    }
    const reports = status.statuses
      .filter((item) => item.project_id === project.id)
      .sort((a, b) => (a.node || a.node_id).localeCompare(b.node || b.node_id));
    if (!reports.length) lines.push('  No node reports');
    for (const report of reports) {
      const node = nodes.get(report.node_id);
      lines.push(
        `  Node ${report.node || report.node_id}: ${node?.status || 'unknown'}; last reported ${report.health}${report.observed_version ? ` (${report.observed_version})` : ''}`,
      );
      try {
        const detail: unknown = JSON.parse(report.status_json);
        if (
          detail &&
          typeof detail === 'object' &&
          'error' in detail &&
          typeof detail.error === 'string' &&
          detail.error
        )
          lines.push(`    Error: ${detail.error}`);
        if (
          detail &&
          typeof detail === 'object' &&
          'serviceStates' in detail &&
          detail.serviceStates &&
          typeof detail.serviceStates === 'object'
        ) {
          lines.push(...serviceStateLines(detail.serviceStates));
        }
      } catch {
        lines.push('    Report details unavailable');
      }
    }
  }
  if (!status.projects.length) lines.push('No projects');
  lines.push('', 'Nodes');
  if (!status.nodes.length) lines.push('  No nodes');
  for (const node of [...status.nodes].sort((a, b) => a.name.localeCompare(b.name)))
    lines.push(`  ${node.name}: ${node.status}; last seen ${node.last_seen_at || 'never'}`);
  return lines.join('\n');
}

export interface NodeListing {
  name: string;
  status: string;
  address: string | null;
  ingress: number | boolean;
  labels: string[];
  last_seen_at: string | null;
  disabled_at?: string | null;
}

/** A table of the registered nodes: state, inter-node address, ingress role, labels and last contact. */
export function formatNodes(nodes: NodeListing[]): string {
  if (!nodes.length) return 'No nodes';
  const rows = [
    ['NODE', 'STATUS', 'ADDRESS', 'INGRESS', 'LABELS', 'LAST SEEN'],
    ...[...nodes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((node) => [
        node.name,
        node.disabled_at ? 'disabled' : node.status,
        node.address || '-',
        node.ingress ? 'yes' : 'no',
        node.labels.join(',') || '-',
        node.last_seen_at || 'never',
      ]),
  ];
  return formatTable(rows);
}

function serviceStateLines(serviceStates: object): string[] {
  return Object.entries(serviceStates)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, state]) => {
      const item = (state && typeof state === 'object' ? state : {}) as {
        rolloutState?: unknown;
        rolloutError?: unknown;
        unstable?: unknown;
      };
      if (typeof item.rolloutState !== 'string') return [];
      const error =
        typeof item.rolloutError === 'string' && item.rolloutError ? ` — ${item.rolloutError}` : '';
      // A service that does not stay up is not serving, whatever the last rollout reached.
      if (typeof item.unstable === 'string' && item.unstable)
        return [`    ${name}: unstable — ${item.unstable}`];
      return [`    ${name}: ${item.rolloutState}${error}`];
    });
}
