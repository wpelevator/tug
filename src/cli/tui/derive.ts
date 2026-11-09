import { backupCheckProblems } from '../../backup/check.ts';
import { majorMinor } from '../../protocol.ts';
import type { StatusResponse } from '../status.ts';
import { ageOf, secondsSince } from './format.ts';
import type { Attention, Counters, Snapshot } from './types.ts';

/** A deployment still building or rolling out after this long is reported as stuck. */
export const STUCK_DEPLOYMENT_SECONDS = 15 * 60;
/** Events newer than this count toward the header and the attention list. */
export const RECENT_EVENT_SECONDS = 24 * 60 * 60;
/** The screen calls the control plane unreachable after this long without an answer. */
export const UNREACHABLE_SECONDS = 15;

export interface ServiceReport {
  name: string;
  /** The agent's rollout state, or the project's apply result when the agent sent no per-service state. */
  state: string;
  error?: string;
  image?: string;
  port?: number;
  revision?: string;
}
/** One node's last report for one project, with its connectivity, parsed from the stored report JSON. */
export interface NodeReport {
  project: string;
  node: string;
  nodeStatus: string;
  health: string;
  observedVersion: string | null;
  error?: string;
  services: ServiceReport[];
  unreadable: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** The per-node project reports in a status response, with `status_json` parsed defensively. */
export function nodeReports(status: StatusResponse): NodeReport[] {
  const nodes = new Map(status.nodes.map((node) => [node.id, node]));
  return status.statuses.map((report) => {
    const node = nodes.get(report.node_id);
    const base = {
      project: report.project_id,
      node: report.node || report.node_id,
      nodeStatus: node?.status ?? 'unknown',
      health: report.health,
      observedVersion: report.observed_version,
    };
    let detail: unknown;
    try {
      detail = JSON.parse(report.status_json);
    } catch {
      return { ...base, services: [], unreadable: true };
    }
    if (!isObject(detail)) return { ...base, services: [], unreadable: true };
    const states = isObject(detail.serviceStates) ? detail.serviceStates : {};
    const names = Array.isArray(detail.services)
      ? detail.services.filter((name): name is string => typeof name === 'string')
      : [];
    const services: ServiceReport[] = [...new Set([...names, ...Object.keys(states)])]
      .sort()
      .map((name) => {
        const state = isObject(states[name]) ? states[name] : undefined;
        return {
          name,
          state: text(state?.unstable) ? 'unstable' : (text(state?.rolloutState) ?? report.health),
          ...(text(state?.unstable)
            ? { error: text(state?.unstable) }
            : text(state?.rolloutError) && { error: text(state?.rolloutError) }),
          ...(text(state?.image) && { image: text(state?.image) }),
          ...(typeof state?.port === 'number' && { port: state.port }),
          ...(text(state?.rolloutRevision) && { revision: text(state?.rolloutRevision) }),
        };
      });
    return {
      ...base,
      ...(text(detail.error) && { error: text(detail.error) }),
      services,
      unreadable: false,
    };
  });
}

/** Whether a node's last report still describes the present: a stale, disabled or unknown node's does not. */
const isCurrent = (report: NodeReport): boolean =>
  report.nodeStatus === 'online' || report.nodeStatus === 'registered';

/**
 * When a service began failing on a node, from the agent's one `service.failed` event per failure: the newest
 * `service.failed` or `service.serving` event that names the service (and, if any does, the node) when it is a failure.
 * Status reports carry no start time (their timestamp changes on every poll), so without the event there is no age.
 */
function failingSince(
  snapshot: Snapshot,
  project: string,
  service: string,
  node: string,
): string | undefined {
  const mine = (snapshot.events.data ?? []).filter(
    (event) =>
      event.project_id === project &&
      (event.type === 'service.failed' || event.type === 'service.serving') &&
      event.message.includes(service),
  );
  const onNode = mine.filter((event) => event.message.includes(node));
  const newest = [...(onNode.length ? onNode : mine)].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )[0];
  return newest?.type === 'service.failed' ? newest.created_at : undefined;
}

const isFailedState = (state: string): boolean => state === 'failed';

/** Newest deployment of each project, by creation time (the status response is newest first, but not relied on). */
export function latestDeployments(
  status: StatusResponse,
): Map<string, StatusResponse['deployments'][number]> {
  const latest = new Map<string, StatusResponse['deployments'][number]>();
  for (const deployment of status.deployments) {
    if (!deployment.project_id) continue;
    const seen = latest.get(deployment.project_id);
    if (!seen || (deployment.created_at ?? '') > (seen.created_at ?? ''))
      latest.set(deployment.project_id, deployment);
  }
  return latest;
}

/**
 * The ranked list of things that are wrong, from the snapshot alone. Pure, so the same ranking drives the header
 * counters, the attention pane and `tug tui --once`:
 *
 * 1. a service failed to apply on a node, a restore is interrupted, control does not answer;
 * 2. a node is stale, a deployment failed or is stuck, or control rolled back by itself;
 * 3. a backup is stale, failed or missing its destination; a diagnostics warning; version skew;
 * 4. published ports bound publicly, services held.
 */
export function deriveAttention(snapshot: Snapshot, now: number, cliVersion?: string): Attention[] {
  const items: Attention[] = [];
  const { status } = snapshot;
  if (status.error !== undefined) {
    const seconds = secondsSince(
      status.fetchedAt ? new Date(status.fetchedAt).toISOString() : undefined,
      now,
    );
    // Before the first answer there is no baseline, so a failure is reported at once.
    if (seconds === undefined || seconds >= UNREACHABLE_SECONDS || !status.data)
      items.push({
        rank: 1,
        key: 'control',
        subject: 'control',
        reason: `no answer${seconds === undefined ? '' : ` for ${seconds}s`}: ${status.error}`,
        target: { name: 'overview' },
      });
  }
  const data = status.data;
  if (data) {
    const reports = nodeReports(data);
    for (const report of reports.filter(isCurrent)) {
      const failing = report.services.filter(
        (service) => service.error || isFailedState(service.state),
      );
      for (const service of failing)
        items.push({
          rank: 1,
          key: `service:${report.project}/${service.name}@${report.node}`,
          subject: `${report.project}/${service.name} on ${report.node}`,
          reason: service.error
            ? `failed to apply: ${service.error}`
            : `failed to apply (${service.state})`,
          since: failingSince(snapshot, report.project, service.name, report.node),
          target: {
            name: 'placement',
            project: report.project,
            service: service.name,
            node: report.node,
          },
          context: { project: report.project, service: service.name, node: report.node },
        });
      if (!failing.length && (report.error || report.health === 'failed'))
        items.push({
          rank: 1,
          key: `project:${report.project}@${report.node}`,
          subject: `${report.project} on ${report.node}`,
          reason: `failed to apply${report.error ? `: ${report.error}` : ''}`,
          since: failingSince(snapshot, report.project, '', report.node),
          target: { name: 'project', project: report.project },
          context: { project: report.project, node: report.node },
        });
      for (const service of report.services.filter((item) => item.state === 'held'))
        items.push({
          rank: 4,
          key: `held:${report.project}/${service.name}@${report.node}`,
          subject: `${report.project}/${service.name} on ${report.node}`,
          reason: 'held; release it with `tug hold release` or finish the restore',
          target: {
            name: 'placement',
            project: report.project,
            service: service.name,
            node: report.node,
          },
          context: { project: report.project, service: service.name, node: report.node },
        });
    }
    for (const node of data.nodes.filter((item) => item.status === 'stale')) {
      const hosted = [
        ...new Set(
          reports
            .filter((report) => report.node === node.name)
            .flatMap((report) =>
              report.services.length
                ? report.services.map((service) => `${report.project}/${service.name}`)
                : [report.project],
            ),
        ),
      ];
      items.push({
        rank: 2,
        key: `node:${node.name}`,
        subject: `node ${node.name}`,
        reason: `stale, last seen ${ageOf(node.last_seen_at, now)} ago${node.connected ? ' but its stream is still open' : ''}${hosted.length ? `; hosts ${hosted.join(', ')}` : ''}`,
        since: node.last_seen_at ?? undefined,
        target: { name: 'node', node: node.name },
        context: { node: node.name },
      });
    }
    for (const node of data.nodes.filter((item) => item.status === 'registered'))
      items.push({
        rank: 4,
        key: `unreported:${node.name}`,
        subject: `node ${node.name}`,
        reason: 'registered, but its agent has not connected yet',
        target: { name: 'node', node: node.name },
        context: { node: node.name },
      });
    for (const [project, deployment] of latestDeployments(data)) {
      const age = secondsSince(deployment.created_at, now);
      if (deployment.state === 'failed' || deployment.state === 'build_failed')
        items.push({
          rank: 2,
          key: `deployment:${deployment.id}`,
          subject: `${project} ${deployment.version}`,
          reason: `deployment ${deployment.state.replace('_', ' ')}${deployment.error_message ? `: ${deployment.error_message}` : ''}`,
          since: deployment.created_at,
          target: { name: 'deployments', project },
          context: { project, deployment: deployment.id, deploymentState: deployment.state },
        });
      else if (
        (deployment.state === 'building' || deployment.state === 'rolling_out') &&
        age !== undefined &&
        age > STUCK_DEPLOYMENT_SECONDS
      )
        items.push({
          rank: 2,
          key: `stuck:${deployment.id}`,
          subject: `${project} ${deployment.version}`,
          reason: `deployment ${deployment.state.replace('_', ' ')} for ${ageOf(deployment.created_at, now)}`,
          since: deployment.created_at,
          target: { name: 'deployments', project },
          context: { project, deployment: deployment.id, deploymentState: deployment.state },
        });
    }
  }
  const recentEvents = (snapshot.events.data ?? []).filter(
    (event) => (secondsSince(event.created_at, now) ?? Infinity) <= RECENT_EVENT_SECONDS,
  );
  const rolledBack = new Set<string>();
  for (const event of recentEvents) {
    const project = event.project_id ?? '';
    if (event.actor === 'system:auto-rollback' && !rolledBack.has(project)) {
      rolledBack.add(project);
      items.push({
        rank: 2,
        key: `auto-rollback:${project}`,
        subject: project || 'control',
        reason: `rolled back automatically ${ageOf(event.created_at, now)} ago: ${event.message}`,
        since: event.created_at,
        target: { name: 'events', project: project || undefined },
        context: project ? { project } : undefined,
      });
    }
  }
  for (const event of recentEvents.filter((item) => item.type === 'ports.public')) {
    items.push({
      rank: 4,
      key: `ports:${event.id}`,
      subject: event.project_id ?? 'control',
      reason: `published ports bound publicly: ${event.message}`,
      since: event.created_at,
      target: { name: 'events', project: event.project_id ?? undefined },
    });
  }
  for (const [project, restores] of Object.entries(snapshot.restores.data ?? {}))
    for (const restore of restores.filter((item) => item.state === 'interrupted'))
      items.push({
        rank: 1,
        key: `restore:${restore.id}`,
        subject: `${project} restore ${restore.target}`,
        reason: `interrupted${restore.error ? `: ${restore.error}` : ''}; writers stay held until resumed or released (tug restore resume ${restore.id})`,
        since: restore.state_changed_at ?? restore.started_at ?? undefined,
        target: { name: 'restores', project },
        context: { project },
      });
  for (const [project, listing] of Object.entries(snapshot.backups.data ?? {}))
    for (const problem of backupCheckProblems(listing))
      items.push({
        rank: 3,
        key: `backup:${project}:${problem}`,
        subject: `backup ${project}`,
        reason: problem,
        // The problem began some time after the last success; with no target to name, there is no age.
        since:
          listing.targets.find((target) => problem.startsWith(`${target.target}:`))
            ?.lastSuccessAt ?? undefined,
        target: { name: 'backups', project },
        context: { project },
      });
  for (const check of snapshot.diagnostics.data?.checks ?? []) {
    for (const warning of check.warnings ?? [])
      items.push({
        rank: 3,
        key: `diagnostic:${check.name}:${warning}`,
        subject: check.name,
        reason: warning,
        target: { name: 'nodes' },
      });
    if (!check.ok)
      items.push({
        rank: 3,
        key: `diagnostic:${check.name}`,
        subject: check.name,
        reason: check.error ?? 'check failed',
        target: { name: 'nodes' },
      });
  }
  const control = snapshot.version.data && majorMinor(snapshot.version.data);
  const cli = cliVersion && majorMinor(cliVersion);
  if (control && cli && (control[0] !== cli[0] || control[1] !== cli[1]))
    items.push({
      rank: 3,
      key: 'version-skew',
      subject: 'versions',
      reason: `control runs ${snapshot.version.data}, this CLI is ${cliVersion}`,
      target: { name: 'overview' },
    });
  return items.sort((a, b) => a.rank - b.rank || (a.since ?? '').localeCompare(b.since ?? ''));
}

/** The header's counters. `attention` is the length of the same list the attention pane shows. */
export function deriveCounters(snapshot: Snapshot, now: number, attention: Attention[]): Counters {
  const data = snapshot.status.data;
  const reports = data ? nodeReports(data) : [];
  // A stale node's services are still expected; they just cannot be counted as serving.
  const services = reports.flatMap((report) =>
    report.services.map((service) => ({ ...service, current: isCurrent(report) })),
  );
  const recent = (snapshot.events.data ?? []).filter(
    (event) => (secondsSince(event.created_at, now) ?? Infinity) <= RECENT_EVENT_SECONDS,
  );
  return {
    nodesOnline: data?.nodes.filter((node) => node.status === 'online').length ?? 0,
    nodesTotal: data?.nodes.length ?? 0,
    projects: data?.projects.length ?? 0,
    servicesServing: services.filter(
      (service) => service.current && service.state === 'serving' && !service.error,
    ).length,
    servicesTotal: services.length,
    backupProblems: attention.filter((item) => item.key.startsWith('backup:')).length,
    eventErrors: recent.filter((event) => event.level === 'error').length,
    eventWarnings: recent.filter((event) => event.level === 'warn').length,
    attention: attention.length,
  };
}
