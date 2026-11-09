import { backupCheckProblems } from '../../backup/check.ts';
import { ageOf, sanitize } from './format.ts';
import { latestDeployments, nodeReports } from './derive.ts';
import type { NodeReport } from './derive.ts';
import type { StatusResponse } from '../status.ts';
import type { Row, Snapshot, Table, Tone, ViewRef } from './types.ts';

/** What a view shows: a table, or plain lines for a single record, under a title and optional intro. */
export interface Content {
  title: string;
  /** The breadcrumb entry for this view. */
  crumb: string;
  intro: string[];
  table?: Table;
  lines?: string[];
}

const cell = (value: unknown): string =>
  value === null || value === undefined || value === '' ? '-' : sanitize(String(value));
const serviceName = (report: NodeReport, service: string): string => `${report.project}/${service}`;
const toneOfState = (state: string, error?: string): Tone =>
  error || state === 'failed'
    ? 'error'
    : state === 'serving'
      ? 'ok'
      : state === 'held' || state === 'skipped'
        ? 'warn'
        : 'plain';
const currentNode = (report: NodeReport): boolean =>
  report.nodeStatus === 'online' || report.nodeStatus === 'registered';

/** The project's current deployment, or its newest one when the current is outside the rows control returned. */
function currentDeployment(status: StatusResponse, project: string) {
  const row = status.projects.find((item) => item.id === project);
  const current = status.deployments.find((item) => item.id === row?.current_deployment_id);
  return {
    current,
    latest: latestDeployments(status).get(project),
    missing: Boolean(row?.current_deployment_id && !current),
  };
}

function backupSummary(snapshot: Snapshot, project: string): string {
  const listing = snapshot.backups.data?.[project];
  if (!listing || !listing.targets.length) return '-';
  return backupCheckProblems(listing).length ? 'problem' : 'ok';
}

function projectsTable(snapshot: Snapshot, now: number): Table {
  const status = snapshot.status.data;
  const reports = status ? nodeReports(status) : [];
  const rows: Row[] = [...(status?.projects ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((project) => {
      const mine = reports.filter((report) => report.project === project.id);
      const { current, latest, missing } = currentDeployment(status!, project.id);
      const shown = current ?? latest;
      const services = mine.flatMap((report) =>
        report.services.map((service) => ({ report, service })),
      );
      const serving = services.filter(
        ({ report, service }) =>
          currentNode(report) && service.state === 'serving' && !service.error,
      ).length;
      const nodesOk = mine.filter(
        (report) => currentNode(report) && report.health === 'serving',
      ).length;
      const failing = services.some(
        ({ report, service }) =>
          currentNode(report) && (service.error || service.state === 'failed'),
      );
      const backup = backupSummary(snapshot, project.id);
      const tone: Tone = failing
        ? 'error'
        : serving < services.length ||
            nodesOk < mine.length ||
            backup === 'problem' ||
            shown?.state === 'failed'
          ? 'warn'
          : mine.length
            ? 'ok'
            : 'plain';
      return {
        key: project.id,
        cells: [
          project.id,
          cell(shown?.version),
          missing ? 'not in recent results' : cell(shown?.state),
          mine.length ? `${serving}/${services.length}` : '-',
          mine.length ? `${nodesOk}/${mine.length}` : '-',
          backup,
          ageOf(shown?.created_at, now),
          cell(shown?.actor),
        ],
        tone,
        open: { name: 'project', project: project.id },
        context: {
          project: project.id,
          ...(shown && { deployment: shown.id, deploymentState: shown.state }),
        },
        record: { project, deployment: shown, reports: mine },
      };
    });
  return {
    columns: ['PROJECT', 'VERSION', 'DEPLOYMENT', 'SERVICES', 'NODES', 'BACKUP', 'AGE', 'BY'],
    rows,
    empty: status ? 'No projects' : 'Waiting for the control plane…',
  };
}

function nodesTable(snapshot: Snapshot, now: number): Table {
  const status = snapshot.status.data;
  const reports = status ? nodeReports(status) : [];
  const detailed = snapshot.nodes.data;
  const names = detailed
    ? detailed.map((node) => node.name)
    : (status?.nodes ?? []).map((node) => node.name);
  const rows: Row[] = [...names].sort().map((name) => {
    const basic = status?.nodes.find((node) => node.name === name);
    const full = detailed?.find((node) => node.name === name);
    const state = full?.disabled_at ? 'disabled' : (full?.status ?? basic?.status ?? 'unknown');
    const hosted = [
      ...new Set(
        reports
          .filter((report) => report.node === name)
          .flatMap((report) =>
            report.services.length
              ? report.services.map((service) => serviceName(report, service.name))
              : [report.project],
          ),
      ),
    ];
    const lastSeen = full?.last_seen_at ?? basic?.last_seen_at ?? null;
    const connected = full?.connected ?? basic?.connected;
    // `stream`: the agent holds its socket to control; `poll`: it does not (or uses the long-poll fallback); `-`: not reported.
    const link = connected === undefined ? '-' : connected ? 'stream' : 'poll';
    return {
      key: name,
      cells: [
        name,
        state,
        link,
        ...(detailed
          ? [cell(full?.address), full?.ingress ? 'yes' : 'no', cell(full?.labels?.join(','))]
          : []),
        ageOf(lastSeen, now),
        hosted.length ? sanitize(hosted.join(' ')) : '-',
      ],
      tone:
        state === 'online'
          ? 'ok'
          : state === 'disabled'
            ? 'dim'
            : state === 'stale'
              ? 'warn'
              : 'plain',
      open: { name: 'node', node: name },
      context: { node: name },
      record: { node: full ?? basic, hosts: hosted },
    };
  });
  return {
    columns: detailed
      ? ['NODE', 'STATUS', 'LINK', 'ADDRESS', 'INGRESS', 'LABELS', 'LAST SEEN', 'SERVICES']
      : ['NODE', 'STATUS', 'LINK', 'LAST SEEN', 'SERVICES'],
    rows,
    empty: status ? 'No nodes' : 'Waiting for the control plane…',
  };
}

/** One row per service per node, optionally limited to a project or a node. */
function servicesTable(snapshot: Snapshot, filter: { project?: string; node?: string }): Table {
  const status = snapshot.status.data;
  const rows: Row[] = [];
  for (const report of status ? nodeReports(status) : []) {
    if (filter.project && report.project !== filter.project) continue;
    if (filter.node && report.node !== filter.node) continue;
    const services = report.services.length
      ? report.services
      : [{ name: '(project)', state: report.health, error: report.error }];
    for (const service of services)
      rows.push({
        key: `${report.project}/${service.name}@${report.node}`,
        cells: [
          ...(filter.project ? [] : [report.project]),
          service.name,
          ...(filter.node ? [] : [report.node]),
          report.nodeStatus === 'online' || report.nodeStatus === 'registered'
            ? service.state
            : `${service.state} (node ${report.nodeStatus})`,
          cell(service.error),
        ],
        tone: currentNode(report) ? toneOfState(service.state, service.error) : 'warn',
        open: {
          name: 'placement',
          project: report.project,
          service: service.name,
          node: report.node,
        },
        context: { project: report.project, service: service.name, node: report.node },
        record: { report: { ...report, services: undefined }, service },
      });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return {
    columns: [
      ...(filter.project ? [] : ['PROJECT']),
      'SERVICE',
      ...(filter.node ? [] : ['NODE']),
      'STATE',
      'ERROR',
    ],
    rows,
    primary: -1,
    empty: status ? 'No services reported yet' : 'Waiting for the control plane…',
  };
}

function deploymentsTable(snapshot: Snapshot, now: number, project?: string): Table {
  const status = snapshot.status.data;
  const rows: Row[] = (status?.deployments ?? [])
    .filter((deployment) => !project || deployment.project_id === project)
    .map((deployment) => ({
      key: deployment.id,
      cells: [
        ...(project ? [] : [cell(deployment.project_id)]),
        cell(deployment.version),
        deployment.state,
        ageOf(deployment.created_at, now),
        cell(deployment.actor),
        cell(deployment.error_message),
      ],
      tone:
        deployment.state === 'failed' || deployment.state === 'build_failed'
          ? 'error'
          : deployment.state === 'succeeded'
            ? 'ok'
            : deployment.state === 'cancelled'
              ? 'dim'
              : 'warn',
      context: {
        project: deployment.project_id,
        deployment: deployment.id,
        deploymentState: deployment.state,
      },
      record: deployment,
    }));
  return {
    columns: [...(project ? [] : ['PROJECT']), 'VERSION', 'STATE', 'AGE', 'BY', 'ERROR'],
    rows,
    primary: -1,
    empty: status ? 'No recent deployments' : 'Waiting for the control plane…',
  };
}

export function eventsTable(snapshot: Snapshot, now: number, project?: string, limit = 500): Table {
  const rows: Row[] = (snapshot.events.data ?? [])
    .filter((event) => !project || event.project_id === project)
    .slice(0, limit)
    .map((event) => ({
      key: event.id,
      cells: [
        ageOf(event.created_at, now),
        event.level,
        cell(event.project_id),
        cell(event.type),
        cell(event.actor),
        cell(event.message),
      ],
      tone: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'plain',
      context: event.project_id ? { project: event.project_id } : undefined,
      record: event,
    }));
  return {
    columns: ['AGE', 'LEVEL', 'PROJECT', 'TYPE', 'ACTOR', 'MESSAGE'],
    rows,
    primary: -1,
    empty: snapshot.events.data ? 'No events' : 'Waiting for the control plane…',
  };
}

function backupsTable(snapshot: Snapshot, now: number, project?: string): Table {
  const rows: Row[] = [];
  for (const [name, listing] of Object.entries(snapshot.backups.data ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (project && name !== project) continue;
    for (const target of listing.targets) {
      const problem = target.enabled ? target.problem : 'disabled';
      rows.push({
        key: `${name}:${target.target}`,
        cells: [
          name,
          target.target,
          cell(target.node),
          cell(target.schedule),
          target.lastSuccessAt ? `${ageOf(target.lastSuccessAt, now)} ago` : 'never',
          cell(target.lastStatus),
          cell(problem),
        ],
        tone: !target.enabled ? 'dim' : target.problem ? 'warn' : 'ok',
        context: { project: name, backupTarget: target.target },
        record: target,
      });
    }
    if (!listing.destinationConfigured && listing.targets.length)
      rows.push({
        key: `${name}:destination`,
        cells: [name, '(destination)', '-', '-', '-', '-', 'no backup destination is configured'],
        tone: 'warn',
        context: { project: name },
      });
  }
  return {
    columns: ['PROJECT', 'TARGET', 'NODE', 'SCHEDULE', 'LAST SUCCESS', 'LAST RUN', 'PROBLEM'],
    rows,
    primary: -1,
    empty: snapshot.backups.data ? 'No backup targets' : 'Waiting for the control plane…',
  };
}

function restoresTable(snapshot: Snapshot, now: number, project?: string): Table {
  const rows: Row[] = [];
  for (const [name, restores] of Object.entries(snapshot.restores.data ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (project && name !== project) continue;
    for (const restore of restores)
      rows.push({
        key: restore.id,
        cells: [
          name,
          restore.target,
          restore.state,
          cell(restore.mode),
          ageOf(restore.state_changed_at ?? restore.started_at, now),
          cell(restore.error),
        ],
        tone:
          restore.state === 'interrupted' ? 'error' : restore.state === 'failed' ? 'warn' : 'plain',
        context: { project: name },
        record: restore,
      });
  }
  return {
    columns: ['PROJECT', 'TARGET', 'STATE', 'MODE', 'AGE', 'ERROR'],
    rows,
    primary: -1,
    empty: snapshot.restores.data ? 'No restores' : 'Waiting for the control plane…',
  };
}

/** The on-demand lists, whose rows are whatever the API returned for the selected project. */
export function listTable(
  name: 'domains' | 'volumes' | 'secrets' | 'credentials',
  snapshot: Snapshot,
  now: number,
  project: string,
): Table {
  const feed = snapshot.lists[listKey(name, project)];
  const rows = feed?.data ?? [];
  const empty = feed?.error
    ? `Cannot load ${name}: ${sanitize(feed.error)}`
    : feed?.data
      ? `No ${name}`
      : `Loading ${name}…`;
  const make = (
    columns: string[],
    cells: (row: Record<string, unknown>) => unknown[],
    key: (row: Record<string, unknown>) => string,
  ): Table => ({
    columns,
    rows: rows.map((row) => ({ key: key(row), cells: cells(row).map(cell), record: row })),
    empty,
  });
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (name) {
    case 'domains':
      return make(
        ['PROJECT', 'SERVICE', 'HOST', 'CREATED', 'BY'],
        (row) => [
          row.project_id,
          row.service,
          row.host,
          ageOf(str(row.created_at), now),
          row.created_by,
        ],
        (row) => str(row.host),
      );
    case 'volumes':
      return make(
        ['NAME', 'TYPE', 'NODE', 'PERSISTENT', 'USED BY'],
        (row) => [
          row.name,
          row.type,
          row.node,
          row.persistent ? 'yes' : 'no',
          Array.isArray(row.usedBy) ? row.usedBy.join(' ') : '',
        ],
        (row) => str(row.name),
      );
    case 'secrets':
      return make(
        ['NAME', 'VERSION', 'UPDATED'],
        (row) => [row.name, row.version, ageOf(str(row.updated_at), now)],
        (row) => str(row.name),
      );
    case 'credentials':
      return make(
        ['NAME', 'ROLE', 'PROJECTS', 'LAST USED', 'EXPIRES', 'REVOKED'],
        (row) => [
          row.name,
          row.role,
          Array.isArray(row.projects) ? row.projects.join(',') : 'all',
          ageOf(str(row.lastUsedAt), now),
          row.expiresAt ? str(row.expiresAt).slice(0, 10) : 'never',
          row.revokedAt ? 'yes' : 'no',
        ],
        (row) => str(row.name),
      );
  }
}
export const listKey = (name: string, project: string): string => `${name}:${project}`;
export const LIST_VIEWS = ['domains', 'volumes', 'secrets', 'credentials'] as const;

/** Lines describing one service on one node: rollout, error, image, port, revision and recent events. */
function placementLines(snapshot: Snapshot, ref: ViewRef, now: number): string[] {
  const status = snapshot.status.data;
  const report = status
    ? nodeReports(status).find((item) => item.project === ref.project && item.node === ref.node)
    : undefined;
  const service = report?.services.find((item) => item.name === ref.service);
  if (!report || !service) return ['This placement is no longer reported.'];
  const { current, latest } = currentDeployment(status!, report.project);
  const shown = current ?? latest;
  const lines = [
    `Service    ${report.project}/${service.name}`,
    `Node       ${report.node} (${report.nodeStatus})`,
    `Rollout    ${service.state}`,
    ...(service.error ? [`Error      ${sanitize(service.error)}`] : []),
    ...(service.image ? [`Image      ${sanitize(service.image)}`] : []),
    ...(service.port ? [`Port       ${service.port}`] : []),
    ...(service.revision ? [`Revision   ${sanitize(service.revision)}`] : []),
    `Project    ${report.project}; applying ${report.observedVersion ?? 'unknown version'}, reported ${report.health}`,
    ...(shown
      ? [
          `Deployment ${shown.version} (${shown.state}), ${ageOf(shown.created_at, now)} ago${shown.actor ? ` by ${sanitize(shown.actor)}` : ''}`,
        ]
      : []),
  ];
  const events = (snapshot.events.data ?? [])
    .filter(
      (event) =>
        event.project_id === report.project &&
        event.type.startsWith('service.') &&
        event.message.includes(service.name),
    )
    .slice(0, 8);
  if (events.length) {
    lines.push('', 'Recent events');
    for (const event of events)
      lines.push(
        `  ${ageOf(event.created_at, now).padStart(4)}  ${event.level.padEnd(5)} ${sanitize(event.type)}  ${sanitize(event.message)}`,
      );
  }
  return lines;
}

function nodeLines(snapshot: Snapshot, node: string, now: number): string[] {
  const full = snapshot.nodes.data?.find((item) => item.name === node);
  const basic = snapshot.status.data?.nodes.find((item) => item.name === node);
  if (!full && !basic) return ['This node is no longer registered.'];
  const state = full?.disabled_at ? 'disabled' : (full?.status ?? basic?.status);
  const lastSeen = full?.last_seen_at ?? basic?.last_seen_at ?? null;
  const lines = [
    `Node       ${node} (${state})`,
    `Last seen  ${lastSeen ? `${ageOf(lastSeen, now)} ago` : 'never'}`,
  ];
  if (full) {
    lines.push(
      `Address    ${full.address ?? '-'}`,
      `Ingress    ${full.ingress ? 'yes' : 'no'}`,
      `Labels     ${full.labels?.join(', ') || '-'}`,
    );
    if (full.cert_not_after) lines.push(`Cert       expires ${full.cert_not_after.slice(0, 10)}`);
  }
  if (state === 'stale')
    lines.push(
      '',
      `Stale means no recent agent contact, not that the machine is off. To investigate: ssh to the host and check the agent, or run tug node repair ${node}.`,
    );
  return lines;
}

/** Everything the current view displays, computed from the snapshot alone. */
export function contentFor(
  ref: ViewRef,
  snapshot: Snapshot,
  now: number,
  selectedProject: string,
): Content {
  switch (ref.name) {
    case 'overview':
      return { title: 'Overview', crumb: 'overview', intro: [] };
    case 'projects':
      return {
        title: 'Projects',
        crumb: 'projects',
        intro: [],
        table: projectsTable(snapshot, now),
      };
    case 'nodes':
      return { title: 'Nodes', crumb: 'nodes', intro: [], table: nodesTable(snapshot, now) };
    case 'services':
      return {
        title: 'Services',
        crumb: 'services',
        intro: [],
        table: servicesTable(snapshot, { project: ref.project }),
      };
    case 'deployments':
      return {
        title: 'Deployments',
        crumb: 'deployments',
        intro: [],
        table: deploymentsTable(snapshot, now, ref.project),
      };
    case 'events':
      return {
        title: ref.project ? `Events of ${ref.project}` : 'Events',
        crumb: 'events',
        intro: [],
        table: eventsTable(snapshot, now, ref.project),
      };
    case 'backups':
      return {
        title: 'Backups',
        crumb: 'backups',
        intro: [],
        table: backupsTable(snapshot, now, ref.project),
      };
    case 'restores':
      return {
        title: 'Restores',
        crumb: 'restores',
        intro: [],
        table: restoresTable(snapshot, now, ref.project),
      };
    case 'domains':
    case 'volumes':
    case 'secrets':
    case 'credentials':
      return {
        title: ref.name[0].toUpperCase() + ref.name.slice(1),
        crumb: ref.name,
        intro: [],
        table: listTable(ref.name, snapshot, now, ref.project ?? selectedProject),
      };
    case 'project': {
      const status = snapshot.status.data;
      const project = ref.project ?? selectedProject;
      const { current, latest, missing } = status ? currentDeployment(status, project) : {};
      const shown = current ?? latest;
      return {
        title: `Project ${project}`,
        crumb: project,
        intro: [
          shown
            ? `Deployment ${cell(shown.version)} (${shown.state}), ${ageOf(shown.created_at, now)} ago${shown.actor ? ` by ${sanitize(shown.actor)}` : ''}${shown.error_message ? `: ${sanitize(shown.error_message)}` : ''}`
            : missing
              ? 'Current deployment is not in the recent results'
              : 'No deployment yet',
        ],
        table: servicesTable(snapshot, { project }),
      };
    }
    case 'node': {
      const node = ref.node ?? '';
      return {
        title: `Node ${node}`,
        crumb: node,
        intro: nodeLines(snapshot, node, now),
        table: servicesTable(snapshot, { node }),
      };
    }
    case 'placement':
      return {
        title: `${ref.project}/${ref.service} on ${ref.node}`,
        crumb: `${ref.service}@${ref.node}`,
        intro: [],
        lines: placementLines(snapshot, ref, now),
      };
  }
}

/**
 * Rows matching a filter typed after `/`: a plain word is a case-insensitive substring of any cell, `!word` keeps the
 * rows without it, and `column=word` matches only that column (by header, case-insensitive).
 */
export function filterTable(table: Table, filter: string): Table {
  const text = filter.trim();
  if (!text) return table;
  const negate = text.startsWith('!');
  const body = negate ? text.slice(1) : text;
  const eq = body.indexOf('=');
  const column =
    eq > 0
      ? table.columns.findIndex((name) => name.toLowerCase() === body.slice(0, eq).toLowerCase())
      : -1;
  const needle = (column >= 0 ? body.slice(eq + 1) : body).toLowerCase();
  const matches = (row: Row): boolean =>
    (column >= 0 ? [row.cells[column] ?? ''] : row.cells).some((value) =>
      value.toLowerCase().includes(needle),
    );
  return { ...table, rows: table.rows.filter((row) => matches(row) !== negate) };
}
