import { createHash } from 'node:crypto';
import { parseCron } from './cron.ts';
import type {
  BackupConfig,
  BackupRetention,
  BackupSpec,
  BackupType,
  ComposeFile,
  ComposeService,
} from './protocol.ts';

/** One backup target after defaults and placement are resolved. */
export interface ResolvedBackup {
  /** `service:db` or `volume:uploads`, unique within a project. */
  target: string;
  kind: 'service' | 'volume';
  name: string;
  /** `command` for a service, `volume` for a volume. */
  type: BackupType;
  schedule: string;
  retention: BackupRetention;
  jitterSeconds: number;
  timeoutSec: number;
  /** Service targets: the command run in the service's container, and the snapshot file it is stored as. */
  command?: string[];
  /** Run in the service container to restore; the stored file arrives on its standard input. */
  restore?: string[];
  filename?: string;
  verify?: string;
  /** Volume targets. */
  exclude?: string[];
  /** Services held during a restore; unset means "discover from the Compose file". */
  writers?: string[];
  /** The one node the backup runs on, when it is known from literal placement. Label placement resolves at deploy time. */
  node?: string;
}

export const DEFAULT_RETENTION: BackupRetention = { daily: 7, weekly: 4, monthly: 6 };
export const DEFAULT_BACKUP_TIMEOUT_SEC = 2 * 3600;
const MIN_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 24 * 3600;
const MAX_JITTER_SEC = 3600;
const RETENTION_KEYS = ['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const;
const COMMON_KEYS = ['schedule', 'retention', 'jitter', 'timeout', 'writers'];
const SERVICE_KEYS = [...COMMON_KEYS, 'command', 'restore', 'filename', 'verify'];
const VOLUME_KEYS = [...COMMON_KEYS, 'exclude'];
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `30m`, `2h`, `90s` or a number of seconds. */
export function parseBackupTimeout(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const match = typeof value === 'string' ? value.match(/^(\d+)(s|m|h)$/) : null;
  if (!match) return null;
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
}

/** Deterministic delay in `[0, 900)` seconds so many sites on one node do not start together. */
export function defaultJitterSeconds(project: string, target: string): number {
  const digest = createHash('sha256').update(`${project}\0${target}`).digest();
  return digest.readUInt32BE(0) % 900;
}

function validateRetention(
  label: string,
  value: unknown,
  errors: string[],
): BackupRetention | undefined {
  if (!isObject(value)) {
    errors.push(`${label}.retention must be an object such as { daily: 7, weekly: 4 }`);
    return undefined;
  }
  const retention: BackupRetention = {};
  for (const [key, count] of Object.entries(value)) {
    if (!(RETENTION_KEYS as readonly string[]).includes(key))
      errors.push(
        `${label}.retention.${key} is not supported (supported: ${RETENTION_KEYS.join(', ')})`,
      );
    else if (!Number.isInteger(count) || (count as number) < 1)
      errors.push(`${label}.retention.${key} must be a whole number of at least 1`);
    else retention[key as keyof BackupRetention] = count as number;
  }
  if (!Object.keys(value).length)
    errors.push(
      `${label}.retention is empty, which would keep no snapshots; set at least one of ${RETENTION_KEYS.join(', ')}`,
    );
  return retention;
}

function validateSchedule(label: string, value: unknown, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${label}.schedule must be a cron string such as "0 3 * * *" or @daily`);
    return undefined;
  }
  try {
    parseCron(value);
  } catch (error) {
    errors.push(`${label}.schedule: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  return value.trim();
}

/** Validates the project-level defaults in `x-tug.backup`. */
export function validateBackupDefaults(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push('x-tug.backup must be an object');
    return;
  }
  for (const key of Object.keys(value))
    if (key !== 'schedule' && key !== 'retention')
      errors.push(`x-tug.backup.${key} is not supported (supported: schedule, retention)`);
  if (value.schedule !== undefined) validateSchedule('x-tug.backup', value.schedule, errors);
  if (value.retention !== undefined) validateRetention('x-tug.backup', value.retention, errors);
}

function normalizeConfig(config: BackupConfig): BackupSpec | null {
  if (config === false) return null;
  if (config === true) return {};
  if (typeof config === 'string') return { schedule: config };
  return config;
}

/** The argv of a `command`: a list is used as is, a string runs through `sh -c` like a shell one-liner. */
export function commandArgv(command: unknown): string[] | null {
  if (typeof command === 'string') return command.trim() ? ['sh', '-c', command] : null;
  return Array.isArray(command) &&
    command.length &&
    command.every((part) => typeof part === 'string' && part)
    ? (command as string[])
    : null;
}

function serviceNodes(svc: ComposeService): {
  nodes: string[];
  dynamic: boolean;
  global: boolean;
} {
  const lp = svc['x-tug'] || {};
  const placement = lp.placement || {};
  return {
    nodes: placement.nodes || [],
    dynamic: Array.isArray(placement.labels) && placement.labels.length > 0,
    global: lp.global === true || placement.global === true,
  };
}

function mountedVolumes(svc: ComposeService): string[] {
  return (svc.volumes || []).flatMap((mount) =>
    typeof mount === 'object' && mount && mount.type === 'volume' && mount.source
      ? [String(mount.source)]
      : [],
  );
}

interface Resolved {
  targets: ResolvedBackup[];
  errors: string[];
}

/**
 * Resolves and validates every `x-tug.backup` in a Compose file. Tug knows nothing about what a service
 * is: a service backup is a command whose output is stored, a volume backup is its files. `project`
 * seeds the default jitter. Errors name the key, so they can be shown to the operator as they are.
 */
export function resolveBackups(compose: ComposeFile, project = ''): Resolved {
  const errors: string[] = [];
  const targets: ResolvedBackup[] = [];
  const defaults = compose['x-tug']?.backup;
  const defaultSchedule = isObject(defaults) ? defaults.schedule : undefined;
  const defaultRetention = (
    isObject(defaults) && isObject(defaults.retention) ? defaults.retention : DEFAULT_RETENTION
  ) as BackupRetention;

  const common = (
    label: string,
    kind: 'service' | 'volume',
    name: string,
    spec: BackupSpec,
  ): Pick<ResolvedBackup, 'schedule' | 'retention' | 'jitterSeconds' | 'timeoutSec'> | null => {
    const allowed = kind === 'service' ? SERVICE_KEYS : VOLUME_KEYS;
    for (const key of Object.keys(spec))
      if (!allowed.includes(key))
        errors.push(
          `${label}.${key} is not supported${
            key === 'command' || key === 'restore' || key === 'filename' || key === 'verify'
              ? ' on a volume; a volume backup archives its files'
              : key === 'exclude'
                ? ' on a service; it applies to volumes'
                : ''
          } (supported: ${allowed.join(', ')})`,
        );
    const before = errors.length;
    const schedule =
      spec.schedule !== undefined
        ? validateSchedule(label, spec.schedule, errors)
        : typeof defaultSchedule === 'string'
          ? defaultSchedule.trim()
          : undefined;
    if (spec.schedule === undefined && schedule === undefined)
      errors.push(`${label} needs a schedule: set ${label}.schedule or x-tug.backup.schedule`);
    const retention =
      spec.retention !== undefined
        ? validateRetention(label, spec.retention, errors)
        : defaultRetention;
    let jitterSeconds = defaultJitterSeconds(project, `${kind}:${name}`);
    if (spec.jitter !== undefined) {
      if (!Number.isInteger(spec.jitter) || spec.jitter < 0 || spec.jitter > MAX_JITTER_SEC)
        errors.push(
          `${label}.jitter must be a whole number of seconds from 0 to ${MAX_JITTER_SEC}`,
        );
      else jitterSeconds = spec.jitter;
    }
    let timeoutSec = DEFAULT_BACKUP_TIMEOUT_SEC;
    if (spec.timeout !== undefined) {
      const parsed = parseBackupTimeout(spec.timeout);
      if (parsed === null || parsed < MIN_TIMEOUT_SEC || parsed > MAX_TIMEOUT_SEC)
        errors.push(`${label}.timeout must be a duration from 1m to 24h such as 30m or 2h`);
      else timeoutSec = parsed;
    }
    if (spec.writers !== undefined) {
      if (!Array.isArray(spec.writers) || spec.writers.some((w) => typeof w !== 'string'))
        errors.push(`${label}.writers must be a list of service names`);
      else
        for (const writer of spec.writers)
          if (!compose.services[writer])
            errors.push(`${label}.writers: ${writer} is not a service`);
    }
    if (errors.length > before || !schedule || !retention) return null;
    return { schedule, retention, jitterSeconds, timeoutSec };
  };

  for (const [name, svc] of Object.entries(compose.services)) {
    const config = svc['x-tug']?.backup;
    if (config === undefined) continue;
    const label = `${name}: x-tug.backup`;
    const spec = normalizeConfig(config);
    if (spec === null) continue;
    if (typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(`${label} must be true, false, a cron string or an object`);
      continue;
    }
    const before = errors.length;
    const base = common(label, 'service', name, spec);

    const argv = spec.command === undefined ? null : commandArgv(spec.command);
    if (spec.command === undefined)
      errors.push(
        `${label}.command is required: the command to run in the ${name} container, whose output is stored (see the recipes in docs/backups.md)`,
      );
    else if (!argv) errors.push(`${label}.command must be a non-empty string or list of strings`);
    const restoreArgv = spec.restore === undefined ? undefined : commandArgv(spec.restore);
    if (spec.restore !== undefined && !restoreArgv)
      errors.push(`${label}.restore must be a non-empty string or list of strings`);
    if (
      spec.filename !== undefined &&
      (typeof spec.filename !== 'string' || !FILENAME_RE.test(spec.filename))
    )
      errors.push(`${label}.filename must be a plain file name such as ${name}.sql`);
    if (spec.verify !== undefined && (typeof spec.verify !== 'string' || !spec.verify))
      errors.push(`${label}.verify must be text that appears at the end of the output`);

    const { nodes, dynamic, global } = serviceNodes(svc);
    const replicas = svc['x-tug']?.replicas ?? 1;
    if (global || replicas > 1 || nodes.length > 1)
      errors.push(
        `${label} needs a single instance; ${name} is global, replicated or placed on several nodes`,
      );

    if (errors.length > before || !base || !argv) continue;
    targets.push({
      target: `service:${name}`,
      kind: 'service',
      name,
      type: 'command',
      ...base,
      command: argv,
      restore: restoreArgv ?? undefined,
      filename: spec.filename ?? `${name}.out`,
      verify: spec.verify,
      writers: spec.writers,
      node: !dynamic && nodes.length === 1 ? nodes[0] : undefined,
    });
  }

  for (const [name, def] of Object.entries(compose.volumes || {})) {
    const config = isObject(def) ? def['x-tug']?.backup : undefined;
    if (config === undefined) continue;
    const label = `volumes.${name}: x-tug.backup`;
    const spec = normalizeConfig(config);
    if (spec === null) continue;
    if (typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(`${label} must be true, false, a cron string or an object`);
      continue;
    }
    const before = errors.length;
    const base = common(label, 'volume', name, spec);
    if (
      spec.exclude !== undefined &&
      (!Array.isArray(spec.exclude) ||
        spec.exclude.some((pattern) => typeof pattern !== 'string' || !pattern))
    )
      errors.push(`${label}.exclude must be a list of restic exclude patterns`);

    const volumeExt = isObject(def) ? def['x-tug'] : undefined;
    const placed = volumeExt?.placement?.nodes || [];
    const mounting = Object.entries(compose.services).filter(([, svc]) =>
      mountedVolumes(svc).includes(name),
    );
    const mountingNodes = [...new Set(mounting.flatMap(([, svc]) => serviceNodes(svc).nodes))];
    const dynamicPlacement = mounting.some(
      ([, svc]) => serviceNodes(svc).dynamic || serviceNodes(svc).global,
    );
    const candidates = placed.length ? placed : mountingNodes;
    if (candidates.length > 1)
      errors.push(
        `${label} needs one node: volume ${name} is ${placed.length ? 'placed' : 'used'} on ${candidates.join(', ')}; pin it with x-tug.placement.nodes or back up per node`,
      );
    else if (!placed.length && dynamicPlacement)
      errors.push(
        `${label} needs x-tug.placement.nodes on volume ${name}, since its services are placed by label or global`,
      );

    if (errors.length > before || !base) continue;
    targets.push({
      target: `volume:${name}`,
      kind: 'volume',
      name,
      type: 'volume',
      ...base,
      exclude: spec.exclude,
      writers: spec.writers,
      node: candidates.length === 1 ? candidates[0] : undefined,
    });
  }
  return { targets, errors };
}
