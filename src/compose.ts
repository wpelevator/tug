import crypto from 'node:crypto';
import { isDuration } from './util.ts';
import { sentinelNames } from './normalize.ts';
import type {
  ComposeFile,
  ComposeService,
  DesiredState,
  ServiceEndpoint,
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

/** Where `composeForNode` binds published ports that name no host IP. */
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
  const host = typeof ingress.host === 'string' ? ingress.host.toLowerCase() : '';
  if (!HOSTNAME_RE.test(host))
    errors.push(`${name}: ingress.host must be a fully qualified hostname`);
  else if (seen.has(host))
    errors.push(`${name}: ingress.host ${host} is already used by ${seen.get(host)}`);
  else seen.set(host, name);
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
    if (key !== 'rollback') errors.push(`x-tug.${key} is not supported (supported: rollback)`);
  if (ext.rollback !== undefined && !['auto', 'manual'].includes(ext.rollback))
    errors.push('x-tug.rollback must be auto or manual');
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
const SUPPORTED_VOLUME_KEYS = ['name', 'driver', 'driver_opts', 'labels', 'external', 'x-tug'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isExtension = (key: string) => key.startsWith('x-');

function validateSubset(
  name: string,
  svc: ComposeService,
  compose: ComposeFile,
  errors: string[],
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

export function validateCompose(
  compose: ComposeFile | undefined,
  nodes: string[] = [],
): asserts compose is ComposeFile {
  if (!compose?.services || typeof compose.services !== 'object')
    throw new Error('compose file must define services');
  const errors: string[] = [];
  const ingressHosts = new Map<string, string>();
  for (const [name, svc] of Object.entries(compose.services)) {
    validateSubset(name, svc, compose, errors);
    const lp = svc['x-tug'] || {};
    const placement = lp.placement || {};
    const selected = placement.nodes || [];
    const hasLabels = Array.isArray(placement.labels) && placement.labels.length > 0;
    const isGlobal = lp.global === true || placement.global === true;
    if (nodes.length > 1 && selected.length === 0 && !hasLabels && !isGlobal)
      errors.push(
        `${name}: multi-node deployments require x-tug.placement.nodes or placement.labels`,
      );
    if (
      lp.replicas &&
      selected.length &&
      !hasLabels &&
      !isGlobal &&
      lp.replicas !== selected.length
    )
      errors.push(`${name}: replicas must match placement node count in v1`);
    validateIngress(name, svc, ingressHosts, errors);
    validateRollout(name, svc, errors);
  }
  validateTopLevel(compose, errors);
  validateProjectExtension(compose, errors);
  if (errors.length) throw new Error(errors.join('; '));
}

export interface BuildDesiredStateOptions {
  project: string;
  version: string;
  compose: ComposeFile;
  registry: string;
  revision?: string;
  defaultNode?: string | null;
  nodes?: Array<{ name: string; labels?: string[] }>;
}

export function buildDesiredState({
  project,
  version,
  compose,
  registry,
  revision,
  defaultNode = null,
  nodes,
}: BuildDesiredStateOptions): DesiredState {
  const services: Record<string, ServiceSpec> = {};
  for (const [name, src] of Object.entries(compose.services || {})) {
    const lp = src['x-tug'] || {};
    let placement = lp.placement || (defaultNode ? { nodes: [defaultNode] } : {});
    const global = lp.global === true || placement.global === true;
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
    const image = src.build
      ? `${registry ? `${registry}/` : 'tug-build/'}${project}/${name}:${revision || version}`
      : src.image;
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
