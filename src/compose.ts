import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import crypto from 'node:crypto';
import { isDuration } from './util.ts';
import type { ComposeFile, ComposeService, ComposeVolume, DesiredState, ServiceEndpoint, ServiceSpec } from './protocol.ts';

export async function readCompose(file = 'docker-compose.yml'): Promise<ComposeFile> {
  return yaml.load(await fs.readFile(file, 'utf8')) as ComposeFile;
}

export function composeHash(compose: ComposeFile): string {
  return crypto.createHash('sha1').update(JSON.stringify(compose)).digest('hex').slice(0, 12);
}

/**
 * The host port a service publishes for `port`, matching either side of a `ports` entry (a
 * container port resolves to its published host port). Null when the port is not published.
 */
export function publishedPort(svc: ComposeService, port: number): number | null {
  for (const entry of svc.ports || []) {
    if (typeof entry === 'object') {
      const published = Number(entry.published);
      if ((Number(entry.target) === port || published === port) && published > 0) return published;
      continue;
    }
    const spec = String(entry).split('/')[0].split(':');
    if (spec.length < 2) continue;
    const container = Number(spec[spec.length - 1]);
    const host = Number(spec[spec.length - 2]);
    if ((container === port || host === port) && host > 0) return host;
  }
  return null;
}

const HOSTNAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function validateIngress(name: string, svc: ComposeService, seen: Map<string, string>, errors: string[]): void {
  const ingress = svc['x-tug']?.ingress;
  if (ingress === undefined) return;
  if (!ingress || typeof ingress !== 'object') { errors.push(`${name}: x-tug.ingress must be an object`); return; }
  const host = typeof ingress.host === 'string' ? ingress.host.toLowerCase() : '';
  if (!HOSTNAME_RE.test(host)) errors.push(`${name}: ingress.host must be a fully qualified hostname`);
  else if (seen.has(host)) errors.push(`${name}: ingress.host ${host} is already used by ${seen.get(host)}`);
  else seen.set(host, name);
  const port = Number(ingress.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${name}: ingress.port must be a port number`);
  else if (publishedPort(svc, port) == null) errors.push(`${name}: ingress.port ${port} must be published in ports (e.g. "8080:${port}"); the edge reaches the service on its published host port`);
  const tls = ingress.tls ?? 'auto';
  if (!['auto', 'custom', 'off'].includes(tls)) errors.push(`${name}: ingress.tls must be auto, custom or off`);
  if (tls === 'custom' && (!ingress.cert || !ingress.key)) errors.push(`${name}: ingress.tls custom requires cert and key (names of project secrets holding the PEM certificate and private key)`);
}

/** True when the service opted in to `x-tug.rollout.strategy: rolling`. */
export function isRolling(svc: ComposeService | undefined): boolean { return svc?.['x-tug']?.rollout?.strategy === 'rolling'; }

function validateRollout(name: string, svc: ComposeService, errors: string[]): void {
  const rollout = svc['x-tug']?.rollout;
  if (rollout === undefined) return;
  if (!rollout || typeof rollout !== 'object' || Array.isArray(rollout)) { errors.push(`${name}: x-tug.rollout must be an object`); return; }
  for (const key of Object.keys(rollout)) if (key !== 'strategy' && key !== 'drain') errors.push(`${name}: x-tug.rollout.${key} is not supported (supported: strategy, drain)`);
  const strategy = rollout.strategy ?? 'recreate';
  if (!['recreate', 'rolling'].includes(strategy)) { errors.push(`${name}: rollout.strategy must be recreate or rolling`); return; }
  if (rollout.drain !== undefined && !isDuration(rollout.drain)) errors.push(`${name}: rollout.drain must be a duration such as 30s, 500ms or 1m`);
  if (strategy !== 'rolling') return;
  const lp = svc['x-tug']!;
  if (!lp.ingress) errors.push(`${name}: rollout.strategy rolling requires x-tug.ingress (the edge is what switches traffic between revisions)`);
  if (!lp.health) errors.push(`${name}: rollout.strategy rolling requires x-tug.health (a new revision only takes over once it is healthy)`);
  const ports = svc.ports || [];
  if (ports.length !== 1) errors.push(`${name}: rollout.strategy rolling requires exactly one entry in ports (the ingress port); each revision gets its own host port`);
}

function validateProjectExtension(compose: ComposeFile, errors: string[]): void {
  const ext = compose['x-tug'];
  if (ext === undefined) return;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) { errors.push('x-tug must be an object'); return; }
  for (const key of Object.keys(ext)) if (key !== 'rollback') errors.push(`x-tug.${key} is not supported (supported: rollback)`);
  if (ext.rollback !== undefined && !['auto', 'manual'].includes(ext.rollback)) errors.push('x-tug.rollback must be auto or manual');
}

export function validateCompose(compose: ComposeFile | undefined, nodes: string[] = []): asserts compose is ComposeFile {
  if (!compose?.services || typeof compose.services !== 'object') throw new Error('compose file must define services');
  const errors: string[] = [];
  const ingressHosts = new Map<string, string>();
  for (const [name, svc] of Object.entries(compose.services)) {
    if (svc.container_name) errors.push(`${name}: container_name is not supported`);
    if (svc.deploy) errors.push(`${name}: swarm deploy semantics are not supported`);
    const lp = svc['x-tug'] || {};
    const selected = lp.placement?.nodes || [];
    if (nodes.length > 1 && selected.length === 0) errors.push(`${name}: multi-node deployments require x-tug.placement.nodes`);
    if (lp.replicas && selected.length && lp.replicas !== selected.length) errors.push(`${name}: replicas must match placement node count in v1`);
    validateIngress(name, svc, ingressHosts, errors);
    validateRollout(name, svc, errors);
  }
  validateProjectExtension(compose, errors);
  if (errors.length) throw new Error(errors.join('; '));
}

export interface BuildDesiredStateOptions { project: string; version: string; compose: ComposeFile; registry: string; revision?: string; defaultNode?: string | null }

export function buildDesiredState({ project, version, compose, registry, revision, defaultNode = null }: BuildDesiredStateOptions): DesiredState {
  const services: Record<string, ServiceSpec> = {};
  for (const [name, src] of Object.entries(compose.services || {})) {
    const lp = src['x-tug'] || {};
    const placement = lp.placement || (defaultNode ? { nodes: [defaultNode] } : {});
    const image = src.build ? `${registry ? `${registry}/` : "tug-build/"}${project}/${name}:${revision || version}` : src.image;
    services[name] = { image, build: src.build || null, placement, replicas: lp.replicas || placement.nodes?.length || 1, health: lp.health || null };
  }
  return { project, version, ...(revision ? { revision } : {}), services, compose };
}

/** `extra_hosts` entries (`name:ip`) for services that run on other nodes, from health-aware endpoints. */
export function crossNodeHosts(project: string, endpoints: Record<string, ServiceEndpoint[]>, local: Set<string>): string[] {
  const hosts: string[] = [];
  for (const [service, list] of Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b))) {
    if (local.has(service)) continue;
    for (const ep of list) hosts.push(`${service}:${ep.address}`, `${service}.${project}.tug:${ep.address}`);
  }
  return hosts;
}

/** Removes `depends_on` references to `names` (services that live in another Compose project). */
export function dropDependsOn(svc: ComposeService, names: ReadonlySet<string>): void {
  const deps = svc.depends_on;
  if (Array.isArray(deps)) { const kept = deps.filter(d => !names.has(String(d))); if (kept.length) svc.depends_on = kept; else delete svc.depends_on; }
  else if (deps && typeof deps === 'object') {
    const kept = Object.fromEntries(Object.entries(deps).filter(([dep]) => !names.has(dep)));
    if (Object.keys(kept).length) svc.depends_on = kept; else delete svc.depends_on;
  }
}

function extraHostsList(value: ComposeService['extra_hosts']): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : Object.entries(value).map(([k, v]) => `${k}:${v}`);
}

/**
 * The Compose file for one node. `exclude` names services placed here that are managed outside the
 * node's main project (rolling services run in their own revision projects); they still count as
 * local, so they get no cross-node `extra_hosts` entry, and `depends_on` references to them are dropped.
 */
export function composeForNode(desiredState: DesiredState, nodeName: string, secrets: Record<string, string> = {}, endpoints: Record<string, ServiceEndpoint[]> = {}, exclude: ReadonlySet<string> = new Set()): ComposeFile {
  const out: ComposeFile & { volumes?: Record<string, ComposeVolume> } = { services: {}, volumes: {} };
  const outVolumes = out.volumes!;
  const usedVolumes = new Set<string>();
  const placed = new Set<string>();
  for (const [name, src] of Object.entries(desiredState.compose.services || {})) {
    const nodes = desiredState.services[name].placement?.nodes || [];
    if (nodes.length && !nodes.includes(nodeName)) continue;
    placed.add(name);
    if (exclude.has(name)) continue;
    const svc: ComposeService = { ...src, image: desiredState.services[name].image };
    delete svc.build; delete svc['x-tug']; delete svc.deploy; delete svc.container_name;
    if (desiredState.services[name].artifact) svc.pull_policy = 'never';
    if (Object.keys(secrets).length) svc.env_file = Array.from(new Set([...(Array.isArray(svc.env_file) ? svc.env_file : svc.env_file ? [svc.env_file] : []), '.env']));
    for (const vol of svc.volumes || []) {
      const source = typeof vol === 'string' ? vol.split(':')[0] : vol.source;
      if (source && desiredState.compose?.volumes?.[source]) usedVolumes.add(source);
    }
    if (exclude.size) dropDependsOn(svc, exclude);
    out.services[name] = svc;
  }
  const hosts = crossNodeHosts(desiredState.project, endpoints, placed);
  if (hosts.length) {
    for (const svc of Object.values(out.services)) {
      const existing = extraHostsList(svc.extra_hosts);
      const taken = new Set(existing.map(h => h.split(':')[0]));
      svc.extra_hosts = [...existing, ...hosts.filter(h => !taken.has(h.split(':')[0]))];
    }
  }
  for (const name of usedVolumes) {
    const vol = desiredState.compose.volumes?.[name] || {};
    const nodes = vol['x-tug']?.placement?.nodes || [];
    if (!nodes.length || nodes.includes(nodeName)) outVolumes[name] = vol;
  }
  if (!Object.keys(outVolumes).length) delete out.volumes;
  return out;
}

export function serviceSecretNames(compose: ComposeFile | undefined, serviceNames: Iterable<string>): Set<string> {
  const allowed = new Set<string>();
  for (const serviceName of serviceNames) {
    const env = compose?.services?.[serviceName]?.environment || {};
    if (Array.isArray(env)) {
      for (const entry of env) {
        const [key, value = ''] = String(entry).split('=');
        if (key) allowed.add(key);
        for (const match of String(value).matchAll(/\$\{?([A-Z_][A-Z0-9_]*)[^}]*\}?/g)) allowed.add(match[1]);
      }
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && value.match(/^\$\{?[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}?$/)) {
          const m = value.match(/^\$\{?([A-Z_][A-Z0-9_]*)/); if (m) allowed.add(m[1]);
        } else allowed.add(key);
      }
    }
  }
  return allowed;
}

export function serviceSecretVersions(compose: ComposeFile | undefined, serviceNames: Iterable<string>, versions: Record<string, number> = {}): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const service of serviceNames) {
    const names = serviceSecretNames(compose, [service]);
    out[service] = Object.fromEntries([...names].filter(name => versions[name] != null).map(name => [name, versions[name]]));
  }
  return out;
}

export function dumpYaml(obj: unknown): string { return yaml.dump(obj, { noRefs: true, lineWidth: 120 }); }
