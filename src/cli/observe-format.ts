import type { HostResources } from '../host-resources.ts';
import { columnWidth, sanitizeTerminalText } from './width.ts';

/** Left-aligned columns separated by two spaces, each as wide as its widest cell, without trailing spaces. */
export function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => columnWidth(row[column] ?? ''))),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell + ' '.repeat(widths[column] - columnWidth(cell)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** The fields of a Docker container summary (`GET /containers/json`) that `tug ps` shows. */
export interface ContainerSummary {
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
  Ports?: { IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }[];
}

/** A pinned `name@sha256:…` reference shortened to twelve digest characters; anything else as written. */
export function shortImage(image: string): string {
  return image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@sha256:$1');
}

function ports(list: ContainerSummary['Ports']): string {
  const published = (list ?? [])
    .filter((port) => port.PublicPort)
    .map(
      (port) =>
        `${port.IP ? `${port.IP.includes(':') ? `[${port.IP}]` : port.IP}:` : ''}${port.PublicPort}->${port.PrivatePort}/${port.Type ?? 'tcp'}`,
    );
  return [...new Set(published)].join(',') || '-';
}

/** `tug ps` for people: one row per container, services first, then jobs and helpers by name. */
export function formatContainers(containers: ContainerSummary[]): string {
  if (!containers.length) return 'No containers';
  const rows = containers
    .map((container) => {
      const labels = container.Labels ?? {};
      const name = (container.Names?.[0] ?? '').replace(/^\//, '');
      const kind = labels['tug.service']
        ? labels['tug.service']
        : labels['tug.job']
          ? `job:${labels['tug.job']}`
          : '-';
      return [
        kind,
        container.State ?? '-',
        container.Status ?? '-',
        shortImage(container.Image ?? '-'),
        ports(container.Ports),
        name || '-',
      ];
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[5].localeCompare(b[5]));
  return formatTable([['SERVICE', 'STATE', 'STATUS', 'IMAGE', 'PORTS', 'CONTAINER'], ...rows]);
}

/** An event row from `GET /api/v1/events`. */
export interface EventRow {
  created_at?: string | null;
  level?: string | null;
  type?: string | null;
  project_id?: string | null;
  actor?: string | null;
  message?: string | null;
}

/** `tug events` for people: newest first as control returns them; the project column only when several can appear. */
export function formatEvents(events: EventRow[], options: { showProject: boolean }): string {
  if (!events.length) return 'No events';
  const header = ['TIME', 'LEVEL', 'TYPE', ...(options.showProject ? ['PROJECT'] : []), 'ACTOR'];
  const rows = events.map((event) =>
    [
      event.created_at ?? '-',
      event.level ?? '-',
      event.type ?? '-',
      ...(options.showProject ? [event.project_id ?? '-'] : []),
      event.actor ?? '-',
    ].map(sanitizeTerminalText),
  );
  // The message is free text of any length, so it trails the aligned columns instead of widening them.
  const table = formatTable([header, ...rows]).split('\n');
  return table
    .map((line, index) => {
      if (!index) return `${line}  MESSAGE`;
      const message = sanitizeTerminalText(events[index - 1].message ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return message ? `${line.padEnd(table[0].length)}  ${message}` : line;
    })
    .join('\n');
}

interface Check {
  name: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  output?: string;
  value?: unknown;
  stdout?: string;
  /** The reason a check did not run; the check then counts as neither passed nor failed. */
  skipped?: string;
  resources?: HostResources;
}

/** The `tug doctor` document; `--json` prints it unchanged. */
export interface DoctorReport {
  ok: boolean;
  warnings?: string[];
  local: Check[];
  control: { ok: boolean; error?: string; checks?: Check[] } | unknown;
  nodeDiagnostics?: {
    commands: {
      nodeId: string;
      state: string;
      result: { node?: string; checks?: Check[]; error?: string } | null;
    }[];
  };
}

/** A short single-line detail worth showing next to a passing check; long or multi-line output is left to `--json`. */
function detail(check: Check): string {
  const raw =
    check.output ??
    (typeof check.value === 'string' || typeof check.value === 'number'
      ? String(check.value)
      : check.stdout);
  if (raw === undefined) return '';
  const text = String(raw).trim();
  return text && !text.includes('\n') && text.length <= 60 ? text : '';
}

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;
const mib = (bytes: number) =>
  bytes >= 2 ** 30
    ? gib(bytes)
    : `${(bytes / 2 ** 20).toFixed(bytes >= 100 * 2 ** 20 ? 0 : 1)} MiB`;

/** The lines under a `resources` check: load, memory, disk and one line per container. */
export function resourceLines(resources: HostResources): string[] {
  const lines: string[] = [];
  const { load, memory, disk } = resources;
  if (load)
    lines.push(
      `load ${load.one.toFixed(2)} ${load.five.toFixed(2)} ${load.fifteen.toFixed(2)} on ${load.cpus} CPU${load.cpus === 1 ? '' : 's'}`,
    );
  if (memory)
    lines.push(`memory ${gib(memory.availableBytes)} available of ${gib(memory.totalBytes)}`);
  if (disk)
    lines.push(
      `disk ${gib(disk.freeBytes)} free of ${gib(disk.totalBytes)} (${disk.dockerRoot ? `Docker data root ${disk.dockerRoot}` : disk.path})`,
    );
  for (const c of resources.containers)
    lines.push(
      sanitizeTerminalText(
        c.error
          ? `${c.name} not measured: ${c.error.replace(/\s+/g, ' ').trim()}`
          : `${c.name} ${c.cpuPercent === undefined ? 'CPU unknown' : `${c.cpuPercent.toFixed(1)}% CPU`}, ${c.memoryBytes === undefined ? 'memory unknown' : mib(c.memoryBytes)}`,
      ),
    );
  return lines;
}

function checkLines(checks: Check[]): string[] {
  const rows = checks.map((check) => [
    check.skipped ? 'skip' : check.ok ? (check.warnings?.length ? 'warn' : 'ok') : 'FAIL',
    check.name,
    check.skipped
      ? check.skipped
      : check.ok
        ? detail(check)
        : (check.error ?? 'failed').replace(/\s+/g, ' ').trim(),
  ]);
  const lines = rows.length ? formatTable(rows).split('\n') : ['(no checks)'];
  return lines.flatMap((line, index) => [
    `  ${line}`,
    ...(checks[index]?.warnings ?? []).map((warning) => `        ${warning}`),
    ...(checks[index]?.resources ? resourceLines(checks[index].resources!) : []).map(
      (resource) => `        ${resource}`,
    ),
  ]);
}

/** `tug doctor` for people: one line per check grouped by where it ran, warnings under their check, and a verdict. */
export function formatDoctor(report: DoctorReport): string {
  const lines = ['This machine', ...checkLines(report.local)];
  const control = (report.control ?? {}) as { ok?: boolean; error?: string; checks?: Check[] };
  lines.push('Control');
  if (control.checks) lines.push(...checkLines(control.checks));
  else lines.push(`  FAIL  ${control.error ?? 'control diagnostics unavailable'}`);
  for (const command of report.nodeDiagnostics?.commands ?? []) {
    const node = command.result?.node ?? command.nodeId;
    lines.push(`Node ${node} (${command.state})`);
    if (command.result?.checks) lines.push(...checkLines(command.result.checks));
    else
      lines.push(
        `  FAIL  ${command.result?.error ?? `diagnostics ${command.state} without a result`}`,
      );
  }
  lines.push('', report.ok ? 'No problems found.' : 'Problems found: see FAIL lines above.');
  return lines.join('\n');
}
