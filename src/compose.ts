import crypto from 'node:crypto';
import { resolveBackups, validateBackupDefaults } from './backup-config.ts';
import { isDuration } from './util.ts';
import { sentinelNames } from './normalize.ts';
import type {
  ComposeFile,
  ComposeService,
  DesiredState,
  Placement,
  ServiceEndpoint,
  ServiceExtension,
  ServiceSpec,
} from './protocol.ts';

export function composeHash(compose: ComposeFile): string {
  return crypto.createHash('sha1').update(JSON.stringify(compose)).digest('hex').slice(0, 12);
}

type PortEntry = NonNullable<ComposeService['ports']>[number];

/** The host port one `ports` entry publishes for `port` (either side of the mapping), or null. */
function entryPublishedPort(entry: PortEntry, port: number): number | null {
  if (typeof entry === 'number') return null;
  if (typeof entry === 'object') {
    const published = Number(entry.published);
    return (Number(entry.target) === port || published === port) && published > 0
      ? published
      : null;
  }
  const spec = String(entry).split('/')[0].split(':');
  if (spec.length < 2) return null;
  const container = Number(spec[spec.length - 1]);
  const host = Number(spec[spec.length - 2]);
  return (container === port || host === port) && host > 0 ? host : null;
}

/**
 * The host port a service publishes for `port`, matching either side of a `ports` entry (a
 * container port resolves to its published host port). Null when the port is not published.
 */
export function publishedPort(svc: ComposeService, port: number): number | null {
  for (const entry of svc.ports || []) {
    const published = entryPublishedPort(entry, port);
    if (published != null) return published;
  }
  return null;
}

/** True when the service publishes host `port` on any address, through a number, a range or the long syntax. */
export function publishesHostPort(svc: ComposeService, port: number): boolean {
  return (svc.ports || []).some((entry) => {
    if (typeof entry === 'number') return false;
    if (typeof entry === 'object') return Number(entry.published) === port;
    const parts = String(entry)
      .split('/')[0]
      .replace(/^\[[^\]]*\]:/, '')
      .split(':');
    if (parts.length < 2) return false;
    const [low, high = low] = parts[parts.length - 2].split('-').map(Number);
    return low <= port && port <= high;
  });
}

/** True when a `ports` entry names its host IP: `127.0.0.1:8080:80`, `[::1]:8080:80`, `0.0.0.0::80` or long-syntax `host_ip`. */
export function hasHostIp(entry: PortEntry): boolean {
  if (typeof entry === 'number') return false;
  if (typeof entry === 'object')
    return entry.host_ip !== undefined && entry.host_ip !== null && entry.host_ip !== '';
  const spec = String(entry).split('/')[0];
  return spec.startsWith('[') || spec.split(':').length > 2;
}

/**
 * Binds a `ports` entry that names no host IP to `ip`, keeping ranges and the protocol suffix
 * (`8080:80/udp` becomes `10.0.0.2:8080:80/udp`, a container-only `80` becomes `10.0.0.2::80`).
 * Entries that already name a host IP, including `0.0.0.0`, are returned as written.
 */
export function bindPort(entry: PortEntry, ip: string): PortEntry {
  if (hasHostIp(entry)) return entry;
  if (typeof entry === 'object') return { ...entry, host_ip: ip };
  const host = ip.includes(':') ? `[${ip}]` : ip;
  const [spec, ...protocol] = String(entry).split('/');
  const bound = spec.includes(':') ? `${host}:${spec}` : `${host}::${spec}`;
  return [bound, ...protocol].join('/');
}

/** `bindPort` for every entry; entries publishing `loopbackPort` bind to `127.0.0.1` instead of `ip`. */
export function bindPorts(ports: PortEntry[], ip: string, loopbackPort?: number): PortEntry[] {
  return ports.map((entry) =>
    bindPort(
      entry,
      loopbackPort !== undefined && entryPublishedPort(entry, loopbackPort) != null
        ? '127.0.0.1'
        : ip,
    ),
  );
}

/**
 * Services of `state` whose ingress port only the managed Caddy on `node` dials, so it can listen on
 * `127.0.0.1`: `node` is the only ingress node, the service runs there, and every service of the
 * project runs only on nodes where this one runs too, so no node reaches it through a service name.
 * A service with no placement nodes runs on every node in `nodes`.
 */
export function loopbackIngressServices(
  state: DesiredState,
  node: string,
  ingressNodes: readonly string[],
  nodes: readonly string[],
): string[] {
  if (ingressNodes.length !== 1 || ingressNodes[0] !== node) return [];
  const placed = (service: string): readonly string[] => {
    const list = state.services[service]?.placement?.nodes || [];
    return list.length ? list : nodes;
  };
  return Object.keys(state.services)
    .filter((service) => {
      if (!state.compose.services?.[service]?.['x-tug']?.ingress) return false;
      const here = new Set(placed(service));
      return (
        here.has(node) &&
        Object.keys(state.services).every((other) => placed(other).every((n) => here.has(n)))
      );
    })
    .sort();
}

/** Where the agent's container definitions bind published ports that name no host IP. */
export interface PortBind {
  address: string;
  loopback?: ReadonlySet<string>;
}

/** Services among `names` with at least one `ports` entry that `bind` puts on its address (not on loopback, not written by the operator). */
export function addressBoundServices(
  compose: ComposeFile,
  names: Iterable<string>,
  loopback: ReadonlySet<string> = new Set(),
): string[] {
  return [...names]
    .filter((name) => {
      const svc = compose.services[name];
      const ingressPort = loopback.has(name) ? svc?.['x-tug']?.ingress?.port : undefined;
      return (svc?.ports || []).some(
        (entry) =>
          !hasHostIp(entry) &&
          (ingressPort === undefined || entryPublishedPort(entry, ingressPort) == null),
      );
    })
    .sort();
}

const HOSTNAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** True for a lowercase-insensitive fully qualified hostname or a one-label `*.zone` wildcard, as `x-tug.ingress.host` takes. */
export const isIngressHostname = (host: string): boolean => HOSTNAME_RE.test(host);

/**
 * Why a name cannot be mapped as a domain, or null. Stricter than `x-tug.ingress.host`, which also takes IP literals
 * for plain-HTTP development: a mapped domain is meant for public issuance, so an address or an over-long name is a
 * mistake. A wildcard zone that is a public suffix (`*.co.uk`) cannot be recognised without a suffix list and is the
 * operator's responsibility.
 */
export function domainProblem(host: string): string | null {
  if (!isIngressHostname(host))
    return 'host must be a fully qualified hostname, or *.zone for a wildcard';
  const name = host.replace(/^\*\./, '');
  if (name.length > 253 || name.split('.').some((label) => label.length > 63))
    return 'host is too long: a name is at most 253 characters and a label 63';
  const last = name.split('.').pop() ?? '';
  if (/^\d+$/.test(last)) return 'host must be a name, not an IP address';
  return null;
}

function validateIngress(
  name: string,
  svc: ComposeService,
  seen: Map<string, string>,
  errors: string[],
): void {
  const ingress = svc['x-tug']?.ingress;
  if (ingress === undefined) return;
  if (!ingress || typeof ingress !== 'object') {
    errors.push(`${name}: x-tug.ingress must be an object`);
    return;
  }
  const rawHosts: unknown[] = Array.isArray(ingress.host) ? ingress.host : [ingress.host];
  if (Array.isArray(ingress.host) && !ingress.host.length)
    errors.push(`${name}: ingress.host must name at least one hostname`);
  const listed = new Set<string>();
  for (const raw of rawHosts) {
    const host = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!HOSTNAME_RE.test(host))
      errors.push(`${name}: ingress.host must be a fully qualified hostname`);
    else if (listed.has(host)) errors.push(`${name}: ingress.host lists ${host} twice`);
    else if (seen.has(host))
      errors.push(`${name}: ingress.host ${host} is already used by ${seen.get(host)}`);
    else {
      seen.set(host, name);
      listed.add(host);
    }
  }
  const port = Number(ingress.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    errors.push(`${name}: ingress.port must be a port number`);
  else if (publishedPort(svc, port) == null)
    errors.push(
      `${name}: ingress.port ${port} must be published in ports (e.g. "8080:${port}"); the edge reaches the service on its published host port`,
    );
  const tls = ingress.tls ?? 'auto';
  if (!['auto', 'custom', 'off'].includes(tls))
    errors.push(`${name}: ingress.tls must be auto, custom or off`);
  if (ingress.maintenance !== undefined && typeof ingress.maintenance !== 'boolean')
    errors.push(`${name}: ingress.maintenance must be true or false`);
  if (tls === 'custom' && (!ingress.cert || !ingress.key))
    errors.push(
      `${name}: ingress.tls custom requires cert and key (names of project secrets holding the PEM certificate and private key)`,
    );
}

/** True when the service opted in to `x-tug.rollout.strategy: rolling`. */
export function isRolling(svc: ComposeService | undefined): boolean {
  return svc?.['x-tug']?.rollout?.strategy === 'rolling';
}

function validateRollout(name: string, svc: ComposeService, errors: string[]): void {
  const rollout = svc['x-tug']?.rollout;
  if (rollout === undefined) return;
  if (!rollout || typeof rollout !== 'object' || Array.isArray(rollout)) {
    errors.push(`${name}: x-tug.rollout must be an object`);
    return;
  }
  for (const key of Object.keys(rollout))
    if (key !== 'strategy' && key !== 'drain')
      errors.push(`${name}: x-tug.rollout.${key} is not supported (supported: strategy, drain)`);
  const strategy = rollout.strategy ?? 'recreate';
  if (!['recreate', 'rolling'].includes(strategy)) {
    errors.push(`${name}: rollout.strategy must be recreate or rolling`);
    return;
  }
  if (rollout.drain !== undefined && !isDuration(rollout.drain))
    errors.push(`${name}: rollout.drain must be a duration such as 30s, 500ms or 1m`);
  if (strategy !== 'rolling') return;
  const lp = svc['x-tug']!;
  if (!lp.ingress)
    errors.push(
      `${name}: rollout.strategy rolling requires x-tug.ingress (the edge is what switches traffic between revisions)`,
    );
  if (!lp.health)
    errors.push(
      `${name}: rollout.strategy rolling requires x-tug.health (a new revision only takes over once it is healthy)`,
    );
  const ports = svc.ports || [];
  if (ports.length !== 1)
    errors.push(
      `${name}: rollout.strategy rolling requires exactly one entry in ports (the ingress port); each revision gets its own host port`,
    );
}

function validateProjectExtension(compose: ComposeFile, errors: string[]): void {
  const ext = compose['x-tug'];
  if (ext === undefined) return;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
    errors.push('x-tug must be an object');
    return;
  }
  for (const key of Object.keys(ext))
    if (key !== 'rollback' && key !== 'backup')
      errors.push(`x-tug.${key} is not supported (supported: rollback, backup)`);
  if (ext.rollback !== undefined && !['auto', 'manual'].includes(ext.rollback))
    errors.push('x-tug.rollback must be auto or manual');
  validateBackupDefaults(ext.backup, errors);
}

/** Service keys the agent can create a container from; anything else is rejected with its name. */
export const SUPPORTED_SERVICE_KEYS: readonly string[] = [
  'image',
  'build',
  'command',
  'entrypoint',
  'environment',
  'ports',
  'expose',
  'volumes',
  'tmpfs',
  'healthcheck',
  'restart',
  'labels',
  'depends_on',
  'extra_hosts',
  'user',
  'working_dir',
  'hostname',
  'init',
  'read_only',
  'shm_size',
  'mem_limit',
  'mem_reservation',
  'cpus',
  'pids_limit',
  'cap_add',
  'cap_drop',
  'ulimits',
  'logging',
  'stop_grace_period',
  'stop_signal',
  'x-tug',
];
/** Keys Compose adds or that Tug ignores on purpose: the default network, and `pull_policy` because Tug decides when images change. */
const IGNORED_SERVICE_KEYS = ['networks', 'pull_policy'];
const SUPPORTED_TOP_LEVEL = ['services', 'volumes', 'networks', 'name', 'x-tug'];
export const SUPPORTED_VOLUME_KEYS = [
  'name',
  'driver',
  'driver_opts',
  'labels',
  'external',
  'x-tug',
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isExtension = (key: string) => key.startsWith('x-');

/** Keys of the service `x-tug` block; anything else is a typo deploy would silently ignore. */
export const SERVICE_EXTENSION_KEYS = [
  'placement',
  'replicas',
  'global',
  'health',
  'ingress',
  'rollout',
  'backup',
];
/** Keys of the top-level-volume `x-tug` block (control records `type` and `driver`). */
export const VOLUME_EXTENSION_KEYS = ['type', 'driver', 'persistent', 'placement', 'backup'];

/** Validates an `x-tug.placement` block wherever it appears (services and top-level volumes). */
function validatePlacement(name: string, placement: unknown, errors: string[]): void {
  if (placement === undefined) return;
  if (!isObject(placement)) {
    errors.push(`${name}: x-tug.placement must be an object`);
    return;
  }
  for (const key of Object.keys(placement)) {
    if (key === 'global')
      errors.push(`${name}: x-tug.placement.global is not supported; use x-tug.global`);
    else if (key !== 'nodes' && key !== 'labels')
      errors.push(`${name}: x-tug.placement.${key} is not supported (supported: nodes, labels)`);
  }
  for (const key of ['nodes', 'labels']) {
    const value = placement[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
      errors.push(`${name}: x-tug.placement.${key} must be a list of names`);
  }
}

/**
 * An unknown type here would make the agent silently pass the service as healthy (anything outside
 * `docker`/`tcp`/`http` falls through every branch), so the `x-tug.health` block is fully validated.
 */
function validateHealth(name: string, health: unknown, errors: string[]): void {
  if (!isObject(health)) {
    errors.push(`${name}: x-tug.health must be an object with type docker, tcp or http`);
    return;
  }
  for (const key of Object.keys(health))
    if (!['type', 'port', 'path', 'interval', 'timeout', 'retries'].includes(key))
      errors.push(
        `${name}: x-tug.health.${key} is not supported (supported: type, port, path, interval, timeout, retries)`,
      );
  const type = typeof health.type === 'string' ? health.type : undefined;
  if (!type) errors.push(`${name}: x-tug.health needs type: docker, tcp or http`);
  else if (!['docker', 'tcp', 'http'].includes(type))
    errors.push(`${name}: x-tug.health.type must be docker, tcp or http`);
  if (health.port === undefined) {
    if (type === 'tcp')
      errors.push(
        `${name}: x-tug.health.port is required when type is tcp (the agent dials it on the container IP)`,
      );
  } else {
    const port = Number(health.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      errors.push(`${name}: x-tug.health.port must be a port number`);
  }
  if (
    health.path !== undefined &&
    (typeof health.path !== 'string' || !health.path.startsWith('/'))
  )
    errors.push(`${name}: x-tug.health.path must be an absolute path such as / or /healthz`);
  for (const key of ['interval', 'timeout'] as const)
    if (health[key] !== undefined && !isDuration(health[key]))
      errors.push(
        `${name}: x-tug.health.${key} must be a duration such as 2s, 500ms or 1m, or a number of milliseconds`,
      );
  if (health.retries !== undefined) {
    const retries = Number(health.retries);
    if (!Number.isInteger(retries) || retries < 1)
      errors.push(`${name}: x-tug.health.retries must be a whole number of 1 or more`);
  }
}

/** The `x-tug` block of a service against its schema: keys first, then the scalar fields. */
function validateServiceExtension(name: string, svc: ComposeService, errors: string[]): void {
  const ext = svc['x-tug'];
  if (ext === undefined) return;
  if (!isObject(ext)) {
    errors.push(`${name}: x-tug must be an object`);
    return;
  }
  for (const key of Object.keys(ext))
    if (!SERVICE_EXTENSION_KEYS.includes(key))
      errors.push(
        `${name}: x-tug.${key} is not supported (supported: ${SERVICE_EXTENSION_KEYS.join(', ')})`,
      );
  if (ext.replicas !== undefined) {
    const replicas = Number(ext.replicas);
    if (!Number.isInteger(replicas) || replicas < 1)
      errors.push(`${name}: x-tug.replicas must be a whole number of 1 or more`);
  }
  const global = ext.global as unknown;
  if (global !== undefined && global !== true && global !== false)
    errors.push(`${name}: x-tug.global must be true or false`);
  if ('placement' in ext) validatePlacement(name, ext.placement, errors);
  if (ext.health !== undefined) validateHealth(name, ext.health, errors);
}

/** The `x-tug` block of a top-level volume against its schema. */
function validateVolumeExtension(name: string, def: unknown, errors: string[]): void {
  const ext = (isObject(def) ? (def as Record<string, unknown>) : {})['x-tug'];
  if (ext === undefined) return;
  const label = `volumes.${name}`;
  if (!isObject(ext)) {
    errors.push(`${label}: x-tug must be an object`);
    return;
  }
  for (const key of Object.keys(ext))
    if (!VOLUME_EXTENSION_KEYS.includes(key))
      errors.push(
        `${label}: x-tug.${key} is not supported (supported: ${VOLUME_EXTENSION_KEYS.join(', ')})`,
      );
  if (ext.type !== undefined && (typeof ext.type !== 'string' || !ext.type.trim()))
    errors.push(`${label}: x-tug.type must be a driver type name such as local`);
  if (ext.driver !== undefined && (typeof ext.driver !== 'string' || !ext.driver.trim()))
    errors.push(`${label}: x-tug.driver must be a volume driver name`);
  if (ext.persistent !== undefined && ext.persistent !== true && ext.persistent !== false)
    errors.push(`${label}: x-tug.persistent must be true or false`);
  if ('placement' in ext) validatePlacement(label, ext.placement, errors);
}

function validateSubset(
  name: string,
  svc: ComposeService,
  compose: ComposeFile,
  errors: string[],
  normalized = true,
): void {
  for (const key of Object.keys(svc)) {
    if (SUPPORTED_SERVICE_KEYS.includes(key) || IGNORED_SERVICE_KEYS.includes(key)) continue;
    if (isExtension(key)) continue;
    errors.push(
      key === 'deploy'
        ? `${name}: deploy (swarm) is not supported; use x-tug placement`
        : `${name}: ${key} is not supported`,
    );
  }
  if (svc.networks !== undefined && svc.networks !== null) {
    const nets = svc.networks as unknown;
    const names = Array.isArray(nets) ? nets.map(String) : isObject(nets) ? Object.keys(nets) : [];
    if (names.some((n) => n !== 'default'))
      errors.push(`${name}: networks other than the default network are not supported`);
  }
  if (!svc.image && !svc.build) errors.push(`${name}: image or build is required`);
  for (const mount of svc.volumes || []) {
    // Short syntax is valid operator input: deploy normalizes it away with `docker compose config`,
    // so only definitions checked in their canonical form have no business still writing it.
    if (!normalized && typeof mount === 'string') continue;
    if (typeof mount === 'string') {
      errors.push(`${name}: volumes must be normalized by docker compose config (got "${mount}")`);
      continue;
    }
    const type = String(mount.type ?? '');
    if (type === 'bind') {
      if (!String(mount.source ?? '').startsWith('/'))
        errors.push(
          `${name}: bind mount source ${JSON.stringify(mount.source)} must be an absolute path on the node`,
        );
    } else if (type === 'volume') {
      const source = String(mount.source ?? '');
      if (!source) errors.push(`${name}: anonymous volumes are not supported; name the volume`);
      else if (!compose.volumes?.[source])
        errors.push(`${name}: volume ${source} is not defined in top-level volumes`);
    } else if (type !== 'tmpfs')
      errors.push(`${name}: volume type ${JSON.stringify(type)} is not supported`);
  }
  const deps = svc.depends_on;
  if (isObject(deps))
    for (const [dep, spec] of Object.entries(deps)) {
      const condition = isObject(spec) ? String(spec.condition ?? 'service_started') : '';
      if (!compose.services[dep]) errors.push(`${name}: depends_on ${dep} is not a service`);
      else if (!['service_started', 'service_healthy'].includes(condition))
        errors.push(`${name}: depends_on condition ${JSON.stringify(condition)} is not supported`);
    }
}

function validateTopLevel(compose: ComposeFile, errors: string[]): void {
  for (const key of Object.keys(compose))
    if (!SUPPORTED_TOP_LEVEL.includes(key) && !isExtension(key))
      errors.push(`${key} is not supported at the top level of the Compose file`);
  const networks = compose.networks;
  if (isObject(networks)) {
    for (const [key, def] of Object.entries(networks))
      if (key !== 'default' || (isObject(def) && def.external))
        errors.push(`networks.${key}: custom networks are not supported`);
  }
  for (const [key, def] of Object.entries(compose.volumes || {})) {
    if (!isObject(def)) continue;
    for (const field of Object.keys(def))
      if (!SUPPORTED_VOLUME_KEYS.includes(field) && !isExtension(field))
        errors.push(`volumes.${key}: ${field} is not supported`);
  }
}

/** The lower-cased names of `x-tug.ingress.host`, a hostname or a list of them; the first is the primary. */
export function ingressHostList(ingress: { host?: unknown }): string[] {
  const list = Array.isArray(ingress.host) ? ingress.host : [ingress.host];
  return list.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase());
}

/** Lower-cased ingress hostnames a Compose definition claims, by `service` name. */
export function ingressHostsOf(compose: ComposeFile): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const [name, svc] of Object.entries(compose.services || {})) {
    const ingress = svc['x-tug']?.ingress;
    if (ingress) for (const host of ingressHostList(ingress)) hosts.set(host, name);
  }
  return hosts;
}

/** True when two lowercase ingress hosts could route the same request: equal, or one is a `*.` wildcard covering the other. */
export function ingressHostsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const suffix = (host: string) => (host.startsWith('*.') ? host.slice(1) : undefined);
  const wa = suffix(a);
  const wb = suffix(b);
  return (wa !== undefined && b.endsWith(wa)) || (wb !== undefined && a.endsWith(wb));
}

export function validateCompose(
  compose: ComposeFile | undefined,
  nodes: string[] = [],
  options: ComposeValidationOptions = {},
): asserts compose is ComposeFile {
  if (!compose?.services || typeof compose.services !== 'object')
    throw new Error('compose file must define services');
  const errors = composeErrors(compose, nodes, options);
  if (errors.length) throw new Error(errors.join('; '));
}

export interface ComposeValidationOptions {
  /** True when `docker compose config` produced the definitions, which expands short-syntax volumes. */
  normalized?: boolean;
}

/**
 * Every schema check of a Compose definition, one message per finding: the schema of every `x-tug`
 * block, cross-references such as the ingress port and the conditions deploy finally enforces.
 * `validateCompose` throws the joined list at deploy time; `tug lint` reports the list for a file as
 * written, without deploy's context (a node list, or the canonical form Compose renders).
 */
export function composeErrors(
  compose: ComposeFile | undefined,
  nodes: string[] = [],
  options: ComposeValidationOptions = {},
): string[] {
  if (!compose?.services || typeof compose.services !== 'object')
    return ['compose file must define services'];
  const errors: string[] = [];
  const ingressHosts = new Map<string, string>();
  for (const [name, svc] of Object.entries(compose?.services || {})) {
    validateSubset(name, svc, compose as ComposeFile, errors, options.normalized !== false);
    validateServiceExtension(name, svc, errors);
    const ext = (isObject(svc['x-tug']) ? svc['x-tug'] : {}) as ServiceExtension;
    const placement = isObject(ext.placement) ? ext.placement : {};
    const selected = (placement as Placement).nodes ?? [];
    const hasLabels = Array.isArray(placement.labels) && placement.labels.length > 0;
    const isGlobal = ext.global === true;
    if (nodes.length > 1 && selected.length === 0 && !hasLabels && !isGlobal)
      errors.push(
        `${name}: multi-node deployments require x-tug.placement.nodes or placement.labels`,
      );
    if (
      ext.replicas &&
      selected.length &&
      !hasLabels &&
      !isGlobal &&
      Number(ext.replicas) !== selected.length
    )
      errors.push(`${name}: replicas must match placement node count in v1`);
    validateIngress(name, svc, ingressHosts, errors);
    validateRollout(name, svc, errors);
  }
  for (const [name, def] of Object.entries(compose?.volumes || {}))
    validateVolumeExtension(name, def, errors);
  validateTopLevel(compose as ComposeFile, errors);
  validateProjectExtension(compose as ComposeFile, errors);
  errors.push(...resolveBackups(compose as ComposeFile).errors);
  return errors;
}

export interface BuildDesiredStateOptions {
  project: string;
  version: string;
  compose: ComposeFile;
  revision?: string;
  defaultNode?: string | null;
  nodes?: Array<{ name: string; labels?: string[] }>;
}

export function buildDesiredState({
  project,
  version,
  compose,
  revision,
  defaultNode = null,
  nodes,
}: BuildDesiredStateOptions): DesiredState {
  const services: Record<string, ServiceSpec> = {};
  for (const [name, src] of Object.entries(compose.services || {})) {
    const lp = src['x-tug'] || {};
    let placement = lp.placement || (defaultNode ? { nodes: [defaultNode] } : {});
    const global = lp.global === true;
    const labels = placement.labels || [];
    if (nodes && (!placement.nodes || !placement.nodes.length) && (labels.length || global)) {
      const matched = nodes
        .filter((node) => labels.every((label) => (node.labels || []).includes(label)))
        .sort((a, b) => a.name.localeCompare(b.name));
      let selected = matched;
      if (!global) {
        const replicas = lp.replicas || matched.length;
        selected = matched.slice(0, Math.min(replicas, matched.length));
      }
      placement = { ...placement, nodes: selected.map((node) => node.name) };
    }
    const image = src.build ? `tug-build/${project}/${name}:${revision || version}` : src.image;
    services[name] = {
      image,
      build: src.build || null,
      placement,
      replicas: lp.replicas || placement.nodes?.length || 1,
      health: lp.health || null,
    };
  }
  return { project, version, ...(revision ? { revision } : {}), services, compose };
}

/** `extra_hosts` entries (`name:ip`) for services that run on other nodes, from health-aware endpoints. */
export function crossNodeHosts(
  project: string,
  endpoints: Record<string, ServiceEndpoint[]>,
  local: Set<string>,
): string[] {
  const hosts: string[] = [];
  for (const [service, list] of Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b))) {
    if (local.has(service)) continue;
    for (const ep of list)
      hosts.push(`${service}:${ep.address}`, `${service}.${project}.tug:${ep.address}`);
  }
  return hosts;
}

/**
 * Control secrets a service uses: the sentinels in its definition. Their versions decide whether the
 * service is recreated, so a secret change touches exactly the services that reference it.
 */
export function serviceSecretNames(
  compose: ComposeFile | undefined,
  serviceNames: Iterable<string>,
): Set<string> {
  const names = new Set<string>();
  for (const service of serviceNames)
    for (const name of sentinelNames(compose?.services?.[service])) names.add(name);
  return names;
}

export function serviceSecretVersions(
  compose: ComposeFile | undefined,
  serviceNames: Iterable<string>,
  versions: Record<string, number> = {},
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const service of serviceNames) {
    const names = serviceSecretNames(compose, [service]);
    out[service] = Object.fromEntries(
      [...names].filter((name) => versions[name] != null).map((name) => [name, versions[name]]),
    );
  }
  return out;
}
