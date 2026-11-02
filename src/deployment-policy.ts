import type { ComposeFile, ComposeService, DesiredState } from './protocol.ts';
import { sentinelNames } from './normalize.ts';
import { ingressHostsOf } from './compose.ts';

export interface ProjectPolicy {
  nodes: string[];
  ingressHosts: string[];
}
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Accept only explicit bounded grants supplied by an administrator. */
export function parseProjectPolicy(value: unknown): ProjectPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('policy must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'nodes' && key !== 'ingressHosts'))
    throw new Error('unknown project policy field');
  if (
    !Array.isArray(input.nodes) ||
    input.nodes.length > 1000 ||
    !input.nodes.every((node) => typeof node === 'string' && NAME.test(node))
  )
    throw new Error('policy nodes must be an array of valid node names (at most 1000)');
  if (
    !Array.isArray(input.ingressHosts) ||
    input.ingressHosts.length > 1000 ||
    !input.ingressHosts.every(
      (host) => typeof host === 'string' && host.length <= 253 && HOST.test(host.toLowerCase()),
    )
  )
    throw new Error('policy ingressHosts must be an array of valid host patterns (at most 1000)');
  return {
    nodes: [...new Set(input.nodes as string[])].sort(),
    ingressHosts: [
      ...new Set((input.ingressHosts as string[]).map((host) => host.toLowerCase())),
    ].sort(),
  };
}

export function projectPolicyViolations(policy: ProjectPolicy, desired: DesiredState): string[] {
  const failures: string[] = [];
  for (const [service, spec] of Object.entries(desired.services)) {
    const nodes = spec.placement.nodes || [];
    if (!nodes.length) failures.push(`${service}: no fixed node placement`);
    for (const node of nodes)
      if (!policy.nodes.includes(node)) failures.push(`${service}: node ${node} is not granted`);
  }
  for (const [name, volume] of Object.entries(desired.compose.volumes || {})) {
    for (const node of volume['x-tug']?.placement?.nodes || [])
      if (!policy.nodes.includes(node))
        failures.push(`volume ${name}: node ${node} is not granted`);
  }
  for (const [host, service] of ingressHostsOf(desired.compose)) {
    if (
      !policy.ingressHosts.some(
        (grant) => grant === host || (grant.startsWith('*.') && host.endsWith(grant.slice(1))),
      )
    )
      failures.push(`${service}: ingress host ${host} is not granted`);
  }
  return failures;
}

/** Returns host-sensitive features requiring an administrator, without relying on client-supplied flags. */
export function privilegedServiceFeatures(compose: ComposeFile, service: ComposeService): string[] {
  const features: string[] = [];
  const nonEnvironment = { ...service };
  delete nonEnvironment.environment;
  if (sentinelNames(nonEnvironment).length) features.push('secrets outside environment');
  const caps = service.cap_add;
  if (caps != null && (!Array.isArray(caps) || caps.length)) features.push('added capabilities');
  const logging = service.logging;
  if (logging != null) {
    if (typeof logging !== 'object' || Array.isArray(logging))
      features.push('logging configuration');
    else {
      const config = logging as Record<string, unknown>;
      if (config.driver != null && config.driver !== 'json-file') features.push('logging driver');
      if (
        config.options != null &&
        (typeof config.options !== 'object' ||
          Array.isArray(config.options) ||
          Object.keys(config.options as object).length)
      )
        features.push('logging options');
    }
  }
  for (const mount of service.volumes || []) {
    if (typeof mount === 'string') {
      features.push('unnormalized mount');
      continue;
    }
    if (mount.type === 'bind') {
      features.push('host bind mount');
      continue;
    }
    if (mount.type !== 'volume') continue;
    const def = compose.volumes?.[String(mount.source ?? '')];
    if (!def) {
      features.push('unknown volume');
      continue;
    }
    if (sentinelNames({ name: mount.source, definition: def }).length)
      features.push('secrets in volume definitions');
    if (def.external) features.push('external volume');
    if (def.driver != null && def.driver !== 'local') features.push('volume driver');
    if (
      def.driver_opts != null &&
      (typeof def.driver_opts !== 'object' ||
        Array.isArray(def.driver_opts) ||
        Object.keys(def.driver_opts as object).length)
    )
      features.push('volume driver options');
  }
  return [...new Set(features)];
}

export function privilegedComposeFeatures(compose: ComposeFile): string[] {
  return Object.entries(compose.services).flatMap(([name, service]) =>
    privilegedServiceFeatures(compose, service).map((feature) => `${name}: ${feature}`),
  );
}
