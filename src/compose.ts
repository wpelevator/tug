import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import crypto from 'node:crypto';
import type { ComposeFile, ComposeService, ComposeVolume, DesiredState, ServiceSpec } from './protocol.ts';

export async function readCompose(file = 'docker-compose.yml'): Promise<ComposeFile> {
  return yaml.load(await fs.readFile(file, 'utf8')) as ComposeFile;
}

export function composeHash(compose: ComposeFile): string {
  return crypto.createHash('sha1').update(JSON.stringify(compose)).digest('hex').slice(0, 12);
}

export function validateCompose(compose: ComposeFile | undefined, nodes: string[] = []): asserts compose is ComposeFile {
  if (!compose?.services || typeof compose.services !== 'object') throw new Error('compose file must define services');
  const errors: string[] = [];
  for (const [name, svc] of Object.entries(compose.services)) {
    if (svc.container_name) errors.push(`${name}: container_name is not supported`);
    if (svc.deploy) errors.push(`${name}: swarm deploy semantics are not supported`);
    const lp = svc['x-launchpad'] || {};
    const selected = lp.placement?.nodes || [];
    if (nodes.length > 1 && selected.length === 0) errors.push(`${name}: multi-node deployments require x-launchpad.placement.nodes`);
    if (lp.replicas && selected.length && lp.replicas !== selected.length) errors.push(`${name}: replicas must match placement node count in v1`);
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

export function composeForNode(desiredState: DesiredState, nodeName: string, secrets: Record<string, string> = {}): ComposeFile {
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
