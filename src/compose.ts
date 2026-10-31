import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import crypto from 'node:crypto';
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
  const ingress = svc['x-launchpad']?.ingress;
  if (ingress === undefined) return;
  if (!ingress || typeof ingress !== 'object') { errors.push(`${name}: x-launchpad.ingress must be an object`); return; }
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

export function validateCompose(compose: ComposeFile | undefined, nodes: string[] = []): asserts compose is ComposeFile {
  if (!compose?.services || typeof compose.services !== 'object') throw new Error('compose file must define services');
  const errors: string[] = [];
  const ingressHosts = new Map<string, string>();
  for (const [name, svc] of Object.entries(compose.services)) {
    if (svc.container_name) errors.push(`${name}: container_name is not supported`);
    if (svc.deploy) errors.push(`${name}: swarm deploy semantics are not supported`);
    const lp = svc['x-launchpad'] || {};
    const selected = lp.placement?.nodes || [];
    if (nodes.length > 1 && selected.length === 0) errors.push(`${name}: multi-node deployments require x-launchpad.placement.nodes`);
    if (lp.replicas && selected.length && lp.replicas !== selected.length) errors.push(`${name}: replicas must match placement node count in v1`);
    validateIngress(name, svc, ingressHosts, errors);
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export interface BuildDesiredStateOptions { project: string; version: string; compose: ComposeFile; registry: string; defaultNode?: string | null }

export function buildDesiredState({ project, version, compose, registry, defaultNode = null }: BuildDesiredStateOptions): DesiredState {
  const services: Record<string, ServiceSpec> = {};
  for (const [name, src] of Object.entries(compose.services || {})) {
    const lp = src['x-launchpad'] || {};
    const placement = lp.placement || (defaultNode ? { nodes: [defaultNode] } : {});
    const image = src.build ? `${registry}/${project}/${name}:${version}` : src.image;
    services[name] = { image, build: src.build || null, placement, replicas: lp.replicas || placement.nodes?.length || 1, health: lp.health || null };
  }
  return { project, version, services, compose };
}

/** `extra_hosts` entries (`name:ip`) for services that run on other nodes, from health-aware endpoints. */
export function crossNodeHosts(project: string, endpoints: Record<string, ServiceEndpoint[]>, local: Set<string>): string[] {
  const hosts: string[] = [];
  for (const [service, list] of Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b))) {
    if (local.has(service)) continue;
    for (const ep of list) hosts.push(`${service}:${ep.address}`, `${service}.${project}.launchpad:${ep.address}`);
  }
  return hosts;
}

function extraHostsList(value: ComposeService['extra_hosts']): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : Object.entries(value).map(([k, v]) => `${k}:${v}`);
}

export function composeForNode(desiredState: DesiredState, nodeName: string, secrets: Record<string, string> = {}, endpoints: Record<string, ServiceEndpoint[]> = {}): ComposeFile {
  const out: ComposeFile & { volumes?: Record<string, ComposeVolume> } = { services: {}, volumes: {} };
  const outVolumes = out.volumes!;
  const usedVolumes = new Set<string>();
  for (const [name, src] of Object.entries(desiredState.compose.services || {})) {
    const lp = src['x-launchpad'] || {};
    const nodes = lp.placement?.nodes || [];
    if (nodes.length && !nodes.includes(nodeName)) continue;
    const svc: ComposeService = { ...src, image: desiredState.services[name].image };
    delete svc.build; delete svc['x-launchpad']; delete svc.deploy; delete svc.container_name;
    if (Object.keys(secrets).length) svc.env_file = Array.from(new Set([...(Array.isArray(svc.env_file) ? svc.env_file : svc.env_file ? [svc.env_file] : []), '.env']));
    for (const vol of svc.volumes || []) {
      const source = typeof vol === 'string' ? vol.split(':')[0] : vol.source;
      if (source && desiredState.compose?.volumes?.[source]) usedVolumes.add(source);
    }
    out.services[name] = svc;
  }
  const hosts = crossNodeHosts(desiredState.project, endpoints, new Set(Object.keys(out.services)));
  if (hosts.length) {
    for (const svc of Object.values(out.services)) {
      const existing = extraHostsList(svc.extra_hosts);
      const taken = new Set(existing.map(h => h.split(':')[0]));
      svc.extra_hosts = [...existing, ...hosts.filter(h => !taken.has(h.split(':')[0]))];
    }
  }
  for (const name of usedVolumes) {
    const vol = desiredState.compose.volumes?.[name] || {};
    const nodes = vol['x-launchpad']?.placement?.nodes || [];
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
