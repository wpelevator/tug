// Turns the desired state for one node into Engine API container definitions. Pure: no Docker, no
// filesystem. The config hash decides whether a running container already matches its definition.
import crypto from 'node:crypto';
import { bindPorts, crossNodeHosts } from './compose.ts';
import { sentinelNames, substituteSentinels } from './normalize.ts';
import type { CreateContainerBody } from './docker-api.ts';
import type { ComposeService, DesiredState, ServiceEndpoint } from './protocol.ts';
import type { PortBind } from './compose.ts';

export const LABEL_PROJECT = 'tug.project';
export const LABEL_SERVICE = 'tug.service';
export const LABEL_REVISION = 'tug.revision';
export const LABEL_HASH = 'tug.config-hash';

/** The project network every container of the project joins; service names are its aliases. */
export const networkName = (project: string): string => `tug_${project}`;
/** Docker volume name for a Compose volume; `external` volumes keep their own name. */
export const volumeName = (project: string, volume: string): string => `tug_${project}_${volume}`;
export const containerName = (project: string, service: string, hash: string): string =>
  `tug-${project}-${service}-${hash.slice(0, 8)}`;

export interface VolumeSpec {
  /** Docker volume name. */
  name: string;
  driver: string;
  opts: Record<string, string>;
  labels: Record<string, string>;
  /** Not created by Tug (`external: true`); it must already exist. */
  external: boolean;
}

export interface ContainerSpec {
  service: string;
  name: string;
  /** Identity of the definition: the body, the image identity and the versions of the secrets it uses. */
  hash: string;
  /** Create body with secrets substituted. Never log it. */
  body: CreateContainerBody;
  /** Services on this node that must be started (and healthy, for `service_healthy`) first. */
  dependsOn: Record<string, 'service_started' | 'service_healthy'>;
}

export interface NodePlan {
  network: string;
  volumes: VolumeSpec[];
  /** Keyed by service, only the services placed on this node. */
  specs: Record<string, ContainerSpec>;
}

export interface ContainerSpecOptions {
  /** Released secret values by name, substituted for sentinels. */
  secrets?: Record<string, string>;
  /** Secret versions by name; they are part of the hash instead of the values. */
  secretVersions?: Record<string, number>;
  endpoints?: Record<string, ServiceEndpoint[]>;
  nodeAddresses?: Record<string, string>;
  /** Host IP for published ports that name none; without it `ports` stay as written. */
  bind?: PortBind;
}

const SECOND_NS = 1_000_000_000;
const UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
};

/** Compose durations (`30s`, `1m30s`, `500ms`) or a number of seconds, in milliseconds. */
export function composeDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value * 1000;
  if (typeof value !== 'string' || !value) return undefined;
  let total = 0;
  let rest = value;
  while (rest) {
    const m = rest.match(/^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/);
    if (!m) return undefined;
    total += Number(m[1]) * UNITS[m[2]];
    rest = rest.slice(m[0].length);
  }
  return total;
}
const toNs = (value: unknown): number | undefined => {
  const ms = composeDurationMs(value);
  return ms === undefined ? undefined : Math.round(ms * 1e6);
};

/** Compose sizes: bytes as a number, or `64m` / `1g` style strings. */
export function sizeBytes(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const m = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
  if (!m) return undefined;
  const power = { '': 0, k: 1, m: 2, g: 3, t: 4 }[m[2] as '' | 'k' | 'm' | 'g' | 't'];
  return Math.round(Number(m[1]) * 1024 ** power);
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];

function extraHosts(value: ComposeService['extra_hosts']): string[] {
  if (!value) return [];
  return Array.isArray(value)
    ? value.map((entry) => String(entry).replace('=', ':'))
    : Object.entries(value).map(([name, ip]) => `${name}:${ip}`);
}

function restartPolicy(value: unknown): { Name: string; MaximumRetryCount?: number } | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const [name, max] = value.split(':');
  return name === 'on-failure' && max
    ? { Name: name, MaximumRetryCount: Number(max) }
    : { Name: name === 'no' ? '' : name };
}

function healthcheck(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const hc = value as Record<string, unknown>;
  if (hc.disable === true) return { Test: ['NONE'] };
  const test = typeof hc.test === 'string' ? ['CMD-SHELL', hc.test] : hc.test;
  return {
    ...(test ? { Test: test } : {}),
    ...(toNs(hc.interval) !== undefined ? { Interval: toNs(hc.interval) } : {}),
    ...(toNs(hc.timeout) !== undefined ? { Timeout: toNs(hc.timeout) } : {}),
    ...(toNs(hc.start_period) !== undefined ? { StartPeriod: toNs(hc.start_period) } : {}),
    ...(toNs(hc.start_interval) !== undefined ? { StartInterval: toNs(hc.start_interval) } : {}),
    ...(hc.retries !== undefined ? { Retries: Number(hc.retries) } : {}),
  };
}

interface PortObject {
  target?: number | string;
  published?: number | string;
  protocol?: string;
  host_ip?: string;
}

function portMaps(svc: ComposeService, ports: PortObject[]) {
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const entry of ports) {
    const key = `${Number(entry.target)}/${entry.protocol || 'tcp'}`;
    exposed[key] = {};
    (bindings[key] ||= []).push({
      HostIp: entry.host_ip || '',
      HostPort: entry.published === undefined ? '' : String(entry.published),
    });
  }
  for (const port of asList(svc.expose))
    exposed[`${port.split('/')[0]}/${port.split('/')[1] || 'tcp'}`] = {};
  return { exposed, bindings };
}

/** Volume definitions this node needs, with NFS volumes mounted from the exporter's directory or address. */
function volumeSpecs(
  desired: DesiredState,
  node: string,
  used: ReadonlySet<string>,
  nodeAddresses: Record<string, string>,
): VolumeSpec[] {
  const out: VolumeSpec[] = [];
  for (const key of [...used].sort()) {
    const def = desired.compose.volumes?.[key] || {};
    const xe = def['x-tug'] || {};
    const labels = {
      [LABEL_PROJECT]: desired.project,
      'tug.volume': key,
      ...((def.labels as Record<string, string> | undefined) || {}),
    };
    if (def.external) {
      out.push({
        name: String(def.name || key),
        driver: 'local',
        opts: {},
        labels,
        external: true,
      });
      continue;
    }
    const name = volumeName(desired.project, key);
    const nodes = xe.placement?.nodes || [];
    const isNfs =
      xe.type === 'nfs' || xe.driver === 'nfs' || (xe.type === 'shared' && xe.driver === 'nfs');
    const plain = (): VolumeSpec => ({
      name,
      driver: String(def.driver || 'local'),
      opts: (def.driver_opts as Record<string, string> | undefined) || {},
      labels,
      external: false,
    });
    if (isNfs) {
      const exporter = nodes[0];
      const exportPath = xe.export || `/srv/tug/${key}`;
      if (!exporter) out.push(plain());
      else if (nodes.includes(node))
        // The exporter mounts the exported directory directly; an NFS server on this node must export it.
        out.push({
          name,
          driver: 'local',
          opts: { type: 'none', o: 'bind', device: exportPath },
          labels,
          external: false,
        });
      else {
        const addr = xe.address || nodeAddresses[exporter] || exporter;
        out.push({
          name,
          driver: 'local',
          opts: { type: 'nfs', o: `addr=${addr},rw,nolock,soft`, device: `:${exportPath}` },
          labels,
          external: false,
        });
      }
      continue;
    }
    if (!nodes.length || nodes.includes(node)) out.push(plain());
  }
  return out;
}

function walkStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkStrings(v, fn)])) as T;
  return value;
}

export function containerSpecs(
  desired: DesiredState,
  node: string,
  {
    secrets = {},
    secretVersions = {},
    endpoints = {},
    nodeAddresses = {},
    bind,
  }: ContainerSpecOptions = {},
): NodePlan {
  const { project } = desired;
  const network = networkName(project);
  const placed = new Set<string>();
  for (const service of Object.keys(desired.compose.services || {})) {
    const nodes = desired.services[service].placement?.nodes || [];
    if (!nodes.length || nodes.includes(node)) placed.add(service);
  }
  const hosts = crossNodeHosts(project, endpoints, placed);
  const usedVolumes = new Set<string>();
  const specs: Record<string, ContainerSpec> = {};
  for (const service of [...placed].sort()) {
    const src = desired.compose.services[service];
    const state = desired.services[service];
    const identity = state.artifact?.imageId ?? state.image;
    const image = state.artifact?.imageRef ?? state.image ?? '';
    const ports = (
      bind && src.ports
        ? bindPorts(
            src.ports,
            bind.address,
            bind.loopback?.has(service) ? src['x-tug']?.ingress?.port : undefined,
          )
        : src.ports || []
    ) as PortObject[];
    const { exposed, bindings } = portMaps(src, ports);
    const binds: string[] = [];
    const tmpfs: Record<string, string> = {};
    for (const mount of src.volumes || []) {
      if (typeof mount === 'string') continue;
      const m = mount as Record<string, unknown>;
      const ro = m.read_only ? ':ro' : '';
      if (m.type === 'volume') {
        const key = String(m.source);
        usedVolumes.add(key);
        const def = desired.compose.volumes?.[key];
        binds.push(
          `${def?.external ? (def.name ?? key) : volumeName(project, key)}:${m.target}${ro}`,
        );
      } else if (m.type === 'bind') binds.push(`${m.source}:${m.target}${ro}`);
      else if (m.type === 'tmpfs') {
        const size = (m.tmpfs as { size?: number } | undefined)?.size;
        tmpfs[String(m.target)] = size ? `size=${size}` : '';
      }
    }
    for (const target of asList(src.tmpfs)) tmpfs[target] = tmpfs[target] ?? '';
    const env = Object.entries((src.environment as Record<string, unknown> | undefined) || {})
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    const memory = sizeBytes(src.mem_limit);
    const reservation = sizeBytes(src.mem_reservation);
    const shm = sizeBytes(src.shm_size);
    const ulimits = Object.entries((src.ulimits as Record<string, unknown> | undefined) || {}).map(
      ([Name, v]) =>
        typeof v === 'number'
          ? { Name, Soft: v, Hard: v }
          : {
              Name,
              Soft: Number((v as { soft: number }).soft),
              Hard: Number((v as { hard: number }).hard),
            },
    );
    const logging = src.logging as
      { driver?: string; options?: Record<string, string> } | undefined;
    const extra = [...extraHosts(src.extra_hosts)];
    const taken = new Set(extra.map((h) => h.split(':')[0]));
    for (const host of hosts) if (!taken.has(host.split(':')[0])) extra.push(host);
    const stopTimeout = composeDurationMs(src.stop_grace_period);
    const hostConfig: Record<string, unknown> = {
      NetworkMode: network,
      ...(binds.length ? { Binds: binds } : {}),
      ...(Object.keys(tmpfs).length ? { Tmpfs: tmpfs } : {}),
      ...(Object.keys(bindings).length ? { PortBindings: bindings } : {}),
      ...(restartPolicy(src.restart) ? { RestartPolicy: restartPolicy(src.restart) } : {}),
      ...(memory !== undefined ? { Memory: memory } : {}),
      ...(reservation !== undefined ? { MemoryReservation: reservation } : {}),
      ...(src.cpus !== undefined ? { NanoCpus: Math.round(Number(src.cpus) * SECOND_NS) } : {}),
      ...(src.pids_limit !== undefined ? { PidsLimit: Number(src.pids_limit) } : {}),
      ...(shm !== undefined ? { ShmSize: shm } : {}),
      ...(src.init !== undefined ? { Init: Boolean(src.init) } : {}),
      ...(src.read_only ? { ReadonlyRootfs: true } : {}),
      ...(extra.length ? { ExtraHosts: extra } : {}),
      ...(asList(src.cap_add).length ? { CapAdd: asList(src.cap_add) } : {}),
      ...(asList(src.cap_drop).length ? { CapDrop: asList(src.cap_drop) } : {}),
      ...(ulimits.length ? { Ulimits: ulimits } : {}),
      ...(logging?.driver
        ? { LogConfig: { Type: logging.driver, Config: logging.options || {} } }
        : {}),
    };
    const hc = healthcheck(src.healthcheck);
    const definition: CreateContainerBody = {
      Image: image,
      ...(env.length ? { Env: env } : {}),
      ...(src.command != null ? { Cmd: asList(src.command) } : {}),
      ...(src.entrypoint != null ? { Entrypoint: asList(src.entrypoint) } : {}),
      ...(src.user ? { User: String(src.user) } : {}),
      ...(src.working_dir ? { WorkingDir: String(src.working_dir) } : {}),
      ...(src.hostname ? { Hostname: String(src.hostname) } : {}),
      Labels: Object.fromEntries(
        Object.entries((src.labels as Record<string, unknown> | undefined) || {}).map(([k, v]) => [
          k,
          String(v),
        ]),
      ),
      ...(Object.keys(exposed).length ? { ExposedPorts: exposed } : {}),
      ...(src.stop_signal ? { StopSignal: String(src.stop_signal) } : {}),
      ...(stopTimeout !== undefined ? { StopTimeout: Math.ceil(stopTimeout / 1000) } : {}),
      ...(hc ? { Healthcheck: hc } : {}),
      HostConfig: hostConfig,
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [service] } } },
    };
    const used = [...new Set(sentinelNames(definition))].sort();
    const versions = Object.fromEntries(
      used
        .filter((name) => secretVersions[name] != null)
        .map((name) => [name, secretVersions[name]]),
    );
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ definition: { ...definition, Image: identity }, versions }))
      .digest('hex')
      .slice(0, 16);
    const body = walkStrings(definition, (s) => substituteSentinels(s, secrets));
    body.Labels = {
      ...body.Labels,
      [LABEL_PROJECT]: project,
      [LABEL_SERVICE]: service,
      [LABEL_HASH]: hash,
      ...(desired.revision || desired.version
        ? { [LABEL_REVISION]: desired.revision || desired.version }
        : {}),
    };
    const dependsOn: ContainerSpec['dependsOn'] = {};
    const deps = src.depends_on;
    if (Array.isArray(deps)) {
      for (const dep of deps)
        if (placed.has(String(dep))) dependsOn[String(dep)] = 'service_started';
    } else if (deps && typeof deps === 'object') {
      for (const [dep, spec] of Object.entries(deps))
        if (placed.has(dep))
          dependsOn[dep] =
            (spec as { condition?: string })?.condition === 'service_healthy'
              ? 'service_healthy'
              : 'service_started';
    }
    specs[service] = {
      service,
      name: containerName(project, service, hash),
      hash,
      body,
      dependsOn,
    };
  }
  return { network, volumes: volumeSpecs(desired, node, usedVolumes, nodeAddresses), specs };
}

/** Start order: dependencies first, ties by service name; a cycle is an error. */
export function startOrder(specs: Record<string, ContainerSpec>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (service: string, path: string[]): void => {
    if (state.get(service) === 'done') return;
    if (state.get(service) === 'visiting')
      throw new Error(`depends_on cycle: ${[...path, service].join(' -> ')}`);
    state.set(service, 'visiting');
    for (const dep of Object.keys(specs[service].dependsOn).sort()) visit(dep, [...path, service]);
    state.set(service, 'done');
    order.push(service);
  };
  for (const service of Object.keys(specs).sort()) visit(service, []);
  return order;
}

/** `body` with the host side of its (single) published port replaced; used for rolling revisions. */
export function withHostPort(body: CreateContainerBody, port: number): CreateContainerBody {
  const bindings = (body.HostConfig?.PortBindings || {}) as Record<
    string,
    { HostIp: string; HostPort: string }[]
  >;
  return {
    ...body,
    HostConfig: {
      ...body.HostConfig,
      PortBindings: Object.fromEntries(
        Object.entries(bindings).map(([key, list]) => [
          key,
          list.map((b) => ({ ...b, HostPort: String(port) })),
        ]),
      ),
    },
  };
}
