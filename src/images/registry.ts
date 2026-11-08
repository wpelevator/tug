import { createHash } from 'node:crypto';

export const REGISTRY_AUTH_SECRET = 'TUG_REGISTRY_AUTH';
export interface RegistryCredential {
  username: string;
  password: string;
}
export type RegistryCredentials = Record<string, RegistryCredential>;

/** A project secret containing registry-host -> username/password entries; never a desired-state field. */
export function parseRegistryCredentials(value?: string): RegistryCredentials {
  if (!value) return {};
  try {
    const entries: unknown = JSON.parse(value);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error();
    const credentials: RegistryCredentials = {};
    for (const [host, auth] of Object.entries(entries)) {
      if (
        !/^[a-zA-Z0-9.:[\]-]+$/.test(host) ||
        !auth ||
        typeof auth !== 'object' ||
        typeof auth.username !== 'string' ||
        typeof auth.password !== 'string'
      )
        throw new Error();
      credentials[host] = { username: auth.username, password: auth.password };
    }
    return credentials;
  } catch {
    throw new Error(
      `${REGISTRY_AUTH_SECRET} must be a JSON object mapping registry hosts to username/password objects`,
    );
  }
}

export function imageLocation(image: string) {
  const match = /^(?<name>[^@\s]+?)(?:@(?<digest>sha256:[a-f0-9]{64}))?$/.exec(image);
  if (!match?.groups) throw new Error('invalid image reference');
  const { name, digest } = match.groups;
  const slash = name.indexOf('/');
  const qualified = slash >= 0 && /[.:]|^localhost$/.test(name.slice(0, slash));
  let host = qualified ? name.slice(0, slash) : 'docker.io';
  if (host === 'index.docker.io') host = 'docker.io';
  let repository = qualified ? name.slice(slash + 1) : name;
  const colon = repository.lastIndexOf(':');
  const tag = colon >= 0 ? repository.slice(colon + 1) : 'latest';
  if (colon >= 0) repository = repository.slice(0, colon);
  if (host === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`;
  if (
    !/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/.test(repository) ||
    !/^[\w][\w.-]{0,127}$/.test(tag) ||
    !/^[a-zA-Z0-9.:[\]-]+$/.test(host)
  )
    throw new Error('invalid image reference');
  return { host, repository, tag, digest, name };
}

const accept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Pin the complete index, so amd64 and arm64 agents select from the same immutable manifest. */
export async function resolveImage(
  image: string,
  credentials: RegistryCredentials = {},
  request: typeof fetch = fetch,
): Promise<string> {
  const location = imageLocation(image);
  if (location.digest) return image;
  const { host, repository, tag, name } = location;
  const endpoint = host === 'docker.io' ? 'registry-1.docker.io' : host;
  const url = `https://${endpoint}/v2/${repository}/manifests/${tag}`;
  const auth = credentials[host];
  const basic = auth
    ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
    : undefined;
  const get = (authorization?: string) =>
    request(url, {
      headers: { Accept: accept, ...(authorization ? { Authorization: authorization } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  try {
    let response = await get();
    if (response.status === 401) {
      const challenge = response.headers.get('www-authenticate') || '';
      await response.body?.cancel();
      if (/^Basic\s/i.test(challenge) && basic) response = await get(basic);
      else if (/^Bearer\s/i.test(challenge)) {
        const params = Object.fromEntries(
          [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
        );
        const tokenUrl = new URL(params.realm);
        if (tokenUrl.protocol !== 'https:' || tokenUrl.username || tokenUrl.password)
          throw new Error();
        if (params.service) tokenUrl.searchParams.set('service', params.service);
        tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
        const tokenResponse = await request(tokenUrl, {
          headers: basic ? { Authorization: basic } : {},
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        if (!tokenResponse.ok) {
          await tokenResponse.body?.cancel();
          throw new Error();
        }
        const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
        const token = body.token || body.access_token;
        if (!token || typeof token !== 'string') throw new Error();
        response = await get(`Bearer ${token}`);
      } else throw new Error();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    // Hash the exact bytes instead of trusting a registry's digest header. Bound manifest memory use.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const manifest = JSON.parse(bytes.toString()) as {
      schemaVersion?: number;
      manifests?: unknown[];
      config?: unknown;
      layers?: unknown[];
    };
    if (
      manifest.schemaVersion !== 2 ||
      !(Array.isArray(manifest.manifests) || (manifest.config && Array.isArray(manifest.layers)))
    )
      throw new Error();
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const reported = response.headers.get('docker-content-digest');
    if (reported && reported !== digest) throw new Error();
    return `${name}@${digest}`;
  } catch {
    throw new Error(
      `cannot resolve image ${image}; check registry availability and project ${REGISTRY_AUTH_SECRET} credentials`,
    );
  }
}
