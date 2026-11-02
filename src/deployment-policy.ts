import type { ComposeFile, ComposeService } from './protocol.ts';
import { sentinelNames } from './normalize.ts';

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
