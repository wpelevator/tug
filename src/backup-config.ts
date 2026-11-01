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

/** One backup target after defaults, type inference and placement are resolved. */
export interface ResolvedBackup {
  /** `service:db` or `volume:uploads`, unique within a project. */
  target: string;
  kind: 'service' | 'volume';
  name: string;
  type: BackupType;
  schedule: string;
  retention: BackupRetention;
  jitterSeconds: number;
  timeoutSec: number;
  /** Database targets only. */
  databases?: string[];
  user?: string;
  passwordSecret?: string;
  /** Volume targets only. */
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
const SPEC_KEYS = [
  'type',
  'schedule',
  'retention',
  'jitter',
  'timeout',
  'databases',
  'user',
  'password',
  'exclude',
  'writers',
];
const SERVICE_ONLY_KEYS = ['databases', 'user', 'password'];
const DATABASE_IMAGES: Record<string, BackupType> = {
  mariadb: 'mariadb',
  mysql: 'mysql',
  percona: 'mysql',
};
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

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

/** The repository name of an image reference: `docker.io/library/mariadb:11.4@sha256:…` gives `mariadb`. */
function imageName(image: string | undefined): string {
  const withoutDigest = String(image ?? '').split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  return withoutDigest.slice(lastSlash + 1).split(':')[0];
}

function serviceEnv(svc: ComposeService, key: string): string | undefined {
  const env = svc.environment;
  if (Array.isArray(env)) {
    const entry = env.find((item) => String(item).startsWith(`${key}=`));
    return entry === undefined ? undefined : String(entry).slice(key.length + 1);
  }
  const value = isObject(env) ? env[key] : undefined;
  return value === undefined || value === null ? undefined : String(value);
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

/** Literal single-node placement of a service, or the reason it has none. */
function serviceNodes(svc: ComposeService): { nodes: string[]; dynamic: boolean; global: boolean } {
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
 * Resolves and validates every `x-tug.backup` in a Compose file. `project` seeds the default
 * jitter. Errors name the key, so they can be shown to the operator as they are.
 */
export function resolveBackups(compose: ComposeFile, project = ''): Resolved {
  const errors: string[] = [];
  const targets: ResolvedBackup[] = [];
  const defaults = compose['x-tug']?.backup;
  const defaultSchedule = isObject(defaults) ? defaults.schedule : undefined;
  const defaultRetention = (
    isObject(defaults) && isObject(defaults.retention) ? defaults.retention : DEFAULT_RETENTION
  ) as BackupRetention;
  const backedUpDatabases: string[] = [];

  const common = (
    label: string,
    kind: 'service' | 'volume',
    name: string,
    spec: BackupSpec,
  ): Pick<ResolvedBackup, 'schedule' | 'retention' | 'jitterSeconds' | 'timeoutSec'> | null => {
    for (const key of Object.keys(spec))
      if (!SPEC_KEYS.includes(key))
        errors.push(`${label}.${key} is not supported (supported: ${SPEC_KEYS.join(', ')})`);
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
    const target = `${kind}:${name}`;
    let jitterSeconds = defaultJitterSeconds(project, target);
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

    const inferred = DATABASE_IMAGES[imageName(svc.image)];
    const type = spec.type ?? inferred;
    if (spec.type === 'volume')
      errors.push(`${label}.type volume is declared on the top-level volume, not on a service`);
    else if (!type)
      errors.push(
        `${label}.type is required (mariadb or mysql); it could not be inferred from image ${JSON.stringify(svc.image ?? '')}`,
      );
    else if (!['mariadb', 'mysql'].includes(type))
      errors.push(`${label}.type must be mariadb or mysql for a service`);
    if (spec.exclude !== undefined) errors.push(`${label}.exclude only applies to volume backups`);

    const { nodes, dynamic, global } = serviceNodes(svc);
    const replicas = svc['x-tug']?.replicas ?? 1;
    if (global || replicas > 1 || nodes.length > 1)
      errors.push(
        `${label} needs a single instance; ${name} is global, replicated or placed on several nodes`,
      );

    const databases =
      spec.databases ??
      [serviceEnv(svc, 'MARIADB_DATABASE') ?? serviceEnv(svc, 'MYSQL_DATABASE')].filter(
        (database): database is string => Boolean(database),
      );
    if (
      !Array.isArray(databases) ||
      !databases.length ||
      databases.some((d) => typeof d !== 'string' || !NAME_RE.test(d))
    )
      errors.push(
        `${label}.databases must list database names (none found in MARIADB_DATABASE or MYSQL_DATABASE)`,
      );
    const user = spec.user ?? 'root';
    if (typeof user !== 'string' || !NAME_RE.test(user))
      errors.push(`${label}.user must be a database user name`);
    const passwordSecret =
      spec.password ??
      (user === 'root'
        ? type === 'mysql'
          ? 'MYSQL_ROOT_PASSWORD'
          : 'MARIADB_ROOT_PASSWORD'
        : undefined);
    if (!passwordSecret)
      errors.push(
        `${label}.password is required when user is not root (the name of the secret holding its password)`,
      );

    if (errors.length > before || !base || !type) continue;
    backedUpDatabases.push(name);
    targets.push({
      target: `service:${name}`,
      kind: 'service',
      name,
      type: type as BackupType,
      ...base,
      databases: databases as string[],
      user,
      passwordSecret,
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
    if (spec.type !== undefined && spec.type !== 'volume')
      errors.push(`${label}.type must be volume for a volume`);
    for (const key of SERVICE_ONLY_KEYS)
      if ((spec as Record<string, unknown>)[key] !== undefined)
        errors.push(`${label}.${key} only applies to database service backups`);
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
    for (const dbService of backedUpDatabases)
      if (mountedVolumes(compose.services[dbService]).includes(name))
        errors.push(
          `${label}: volume ${name} holds the data of ${dbService}, which has its own database backup; a raw copy of a running database is not a backup`,
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
