// Service endpoints (health-aware DNS source), ingress route resolution and Caddyfile rendering
// on the control side; the managed Caddy container reconcile on the agent side. Docker access goes
// through the injectable DockerRunner.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loopbackIngressServices, publishedPort } from './compose.ts';
import { ensureDir, errMessage } from './util.ts';
import type {
  DesiredState,
  IngressRoute,
  IngressSpec,
  IngressStatus,
  IngressTls,
  IngressWork,
  ProjectStatus,
  ServiceEndpoint,
  ServiceEndpoints,
} from './protocol.ts';
import * as tar from 'tar';
import { isNotFound } from './docker-api.ts';
import type { DockerApi } from './docker-api.ts';

export const CADDY_CONTAINER = 'tug-caddy';
export const DEFAULT_CADDY_IMAGE = 'caddy:2-alpine';
const CADDY_ETC = '/etc/caddy';

// ---- Control: endpoints and routes -------------------------------------------------------------

export interface NodeView {
  name: string;
  /** Reachable mesh address; null when the mesh is off or the node has not reported a key yet. */
  overlayIp: string | null;
  address: string | null;
  lastSeenAt: string | null;
}
export interface ReportedStatus {
  node: string;
  project: string;
  status: ProjectStatus;
}

/**
 * Where each service can be reached right now: one endpoint per placement node whose agent is
 * fresh and reports that service `serving`. Withdrawn automatically when a node goes stale or its
 * rollout state drops, which is what makes DNS and ingress health-aware.
 */
export function resolveServiceEndpoints(
  states: DesiredState[],
  nodes: NodeView[],
  statuses: ReportedStatus[],
  staleBefore: string,
): ServiceEndpoints {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const reported = new Map(statuses.map((s) => [`${s.node}\0${s.project}`, s.status]));
  const out: ServiceEndpoints = {};
  for (const state of states) {
    for (const [service, spec] of Object.entries(state.services)) {
      const endpoints: ServiceEndpoint[] = [];
      for (const nodeName of spec.placement?.nodes || []) {
        const node = byName.get(nodeName);
        const address = node && (node.overlayIp || node.address);
        if (!node || !address || !node.lastSeenAt || node.lastSeenAt < staleBefore) continue;
        const serviceState = reported.get(`${nodeName}\0${state.project}`)?.serviceStates?.[
          service
        ];
        if (serviceState?.rolloutState !== 'serving') continue;
        // Rolling services publish each revision on its own host port; the report names the serving one.
        endpoints.push({
          node: nodeName,
          address,
          ...(serviceState.port ? { port: serviceState.port } : {}),
        });
      }
      if (endpoints.length)
        (out[state.project] ||= {})[service] = endpoints.sort((a, b) =>
          a.node.localeCompare(b.node),
        );
    }
  }
  return out;
}

export interface IngressInput {
  states: DesiredState[];
  endpoints: ServiceEndpoints;
  /** The ingress node being configured. */
  node: string;
  /** Every node name, and the ingress nodes; they decide which services on `node` listen on loopback only. */
  nodes?: string[];
  ingressNodes?: string[];
  /** Decrypted project secrets for custom TLS, keyed `<project>/<secret name>`. */
  secrets: Map<string, string>;
  acmeEmail?: string;
}

const certFile = (host: string, ext: 'crt' | 'key') =>
  `certs/${host.replace(/\*/g, '_wildcard_')}.${ext}`;

/**
 * Upstreams on the ingress node itself are dialed on `127.0.0.1` when the service's ingress port
 * listens on loopback only (see `loopbackIngressServices`), otherwise on the address its published
 * ports are bound to, which is the endpoint address, like every other node.
 */
export function buildIngressWork({
  states,
  endpoints,
  node,
  nodes = [node],
  ingressNodes = [node],
  secrets,
  acmeEmail,
}: IngressInput): IngressWork {
  const routes: IngressRoute[] = [];
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const seenHosts = new Map<string, string>();
  const tagged: {
    project: string;
    service: string;
    ingress: IngressSpec;
    port: number | null;
    loopback: boolean;
  }[] = [];
  for (const state of states) {
    const loopback = new Set(loopbackIngressServices(state, node, ingressNodes, nodes));
    for (const [service, svc] of Object.entries(state.compose.services || {})) {
      const ingress = svc['x-tug']?.ingress;
      if (ingress)
        tagged.push({
          project: state.project,
          service,
          ingress,
          port: publishedPort(svc, ingress.port),
          loopback: loopback.has(service),
        });
    }
  }
  tagged.sort((a, b) => `${a.project}/${a.service}`.localeCompare(`${b.project}/${b.service}`));
  for (const { project, service, ingress, port, loopback } of tagged) {
    const label = `${project}/${service}`;
    const host = ingress.host.toLowerCase();
    const tls: IngressTls = ingress.tls || 'auto';
    if (seenHosts.has(host)) {
      warnings.push(`${label}: host ${host} is already routed by ${seenHosts.get(host)}; skipped`);
      continue;
    }
    if (port == null) {
      warnings.push(`${label}: ingress.port ${ingress.port} is not published; skipped`);
      continue;
    }
    const upstreams = (endpoints[project]?.[service] || []).map(
      (e) =>
        `${e.node === node && loopback ? '127.0.0.1' : upstreamHost(e.address)}:${e.port ?? port}`,
    );
    if (!upstreams.length) {
      warnings.push(`${label}: no serving upstream for ${host}; route withheld`);
      continue;
    }
    if (tls === 'custom') {
      const cert = secrets.get(`${project}/${ingress.cert}`);
      const key = secrets.get(`${project}/${ingress.key}`);
      if (!cert || !key) {
        warnings.push(
          `${label}: custom TLS secrets ${ingress.cert}/${ingress.key} not found in project ${project}; skipped`,
        );
        continue;
      }
      files[certFile(host, 'crt')] = cert.endsWith('\n') ? cert : `${cert}\n`;
      files[certFile(host, 'key')] = key.endsWith('\n') ? key : `${key}\n`;
    }
    seenHosts.set(host, label);
    routes.push({ project, service, host, tls, upstreams });
  }
  return { caddyfile: renderCaddyfile(routes, { acmeEmail }), files, routes, warnings };
}

/** IPv6 upstream addresses need brackets before the port. */
const upstreamHost = (address: string) =>
  address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;

export function renderCaddyfile(routes: IngressRoute[], opts: { acmeEmail?: string } = {}): string {
  const out: string[] = [];
  if (opts.acmeEmail) out.push('{', `\temail ${opts.acmeEmail}`, '}', '');
  for (const route of routes) {
    // An explicit http:// address turns off automatic HTTPS for that site.
    out.push(`${route.tls === 'off' ? 'http://' : ''}${route.host} {`);
    if (route.tls === 'custom')
      out.push(
        `\ttls ${CADDY_ETC}/${certFile(route.host, 'crt')} ${CADDY_ETC}/${certFile(route.host, 'key')}`,
      );
    out.push(
      `\treverse_proxy ${route.upstreams.join(' ')} {`,
      '\t\tlb_policy round_robin',
      '\t}',
      '}',
      '',
    );
  }
  return out.length ? out.join('\n') : '# no ingress routes\n';
}

// ---- Agent: managed Caddy container ------------------------------------------------------------

export function ingressConfigHash(work: Pick<IngressWork, 'caddyfile' | 'files'>): string {
  const h = crypto.createHash('sha256').update(work.caddyfile);
  for (const name of Object.keys(work.files).sort())
    h.update('\0').update(name).update('\0').update(work.files[name]);
  return h.digest('hex');
}

export interface IngressContext {
  docker: DockerApi;
  stateDir: string;
  caddyImage?: string;
}

async function writeStage(dir: string, work: IngressWork): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, 'Caddyfile'), work.caddyfile);
  for (const [name, body] of Object.entries(work.files)) {
    const file = path.join(dir, name);
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, body, { mode: name.endsWith('.key') ? 0o600 : 0o644 });
  }
}

async function tarOf(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: dir, portable: true }, ['.']))
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function ensureImage(ctx: IngressContext): Promise<string> {
  const image = ctx.caddyImage || DEFAULT_CADDY_IMAGE;
  if (!(await ctx.docker.inspectImage(image))) await ctx.docker.pullImage(image);
  return image;
}

async function reload(ctx: IngressContext): Promise<void> {
  const r = await ctx.docker.execRun(CADDY_CONTAINER, [
    'caddy',
    'reload',
    '--config',
    `${CADDY_ETC}/Caddyfile`,
    '--adapter',
    'caddyfile',
  ]);
  if (r.code !== 0) throw new Error(`caddy reload failed (${r.code}): ${(r.err || r.out).trim()}`);
}

/**
 * Makes the Caddy container match the control-rendered config. Config is uploaded into the
 * container with the archive endpoint (so it works whether the agent runs on the host or in a
 * container) and applied with `caddy reload`, which swaps config gracefully without dropping
 * connections. If Caddy rejects the new config the previous one is restored and the error reported.
 */
export async function reconcileIngress(
  ctx: IngressContext,
  work: IngressWork,
): Promise<IngressStatus> {
  const root = path.join(ctx.stateDir, 'ingress');
  const stage = path.join(root, 'stage');
  const applied = path.join(root, 'applied');
  const configHash = ingressConfigHash(work);
  const routes = work.routes.length;
  const existing = await ctx.docker.inspectContainer(CADDY_CONTAINER).catch((e) => {
    if (isNotFound(e)) return null;
    throw e;
  });
  const running: boolean | null = existing ? Boolean(existing.State?.Running) : null;
  const appliedHash = await fs.readFile(path.join(root, 'applied.hash'), 'utf8').then(
    (s) => s.trim(),
    () => '',
  );
  if (running && appliedHash === configHash) return { state: 'serving', configHash, routes };

  await writeStage(stage, work);
  try {
    if (running === null) {
      const image = await ensureImage(ctx);
      await ctx.docker.createContainer(CADDY_CONTAINER, {
        Image: image,
        Labels: { 'tug.managed': 'ingress' },
        HostConfig: {
          NetworkMode: 'host',
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: ['tug-caddy-data:/data', 'tug-caddy-config:/config', `tug-caddy-etc:${CADDY_ETC}`],
        },
      });
      await ctx.docker.putArchive(CADDY_CONTAINER, CADDY_ETC, await tarOf(stage));
      await ctx.docker.startContainer(CADDY_CONTAINER);
    } else if (running === false) {
      await ctx.docker.putArchive(CADDY_CONTAINER, CADDY_ETC, await tarOf(stage));
      await ctx.docker.startContainer(CADDY_CONTAINER);
    } else {
      try {
        await ctx.docker.execRun(CADDY_CONTAINER, ['rm', '-rf', `${CADDY_ETC}/certs`]);
        await ctx.docker.putArchive(CADDY_CONTAINER, CADDY_ETC, await tarOf(stage));
        await reload(ctx);
      } catch (e) {
        if (
          await fs.stat(applied).then(
            () => true,
            () => false,
          )
        )
          await ctx.docker
            .putArchive(CADDY_CONTAINER, CADDY_ETC, await tarOf(applied))
            .catch(() => {});
        throw e;
      }
    }
  } catch (e) {
    await fs.rm(stage, { recursive: true, force: true });
    return { state: 'failed', configHash, routes, error: errMessage(e).slice(-1000) };
  }
  await fs.rm(applied, { recursive: true, force: true });
  await fs.rename(stage, applied);
  await fs.writeFile(path.join(root, 'applied.hash'), `${configHash}\n`);
  return { state: 'serving', configHash, routes };
}

/** Removes the Caddy container when a node stops being an ingress node; ACME data volumes are kept. */
export async function removeIngress(ctx: IngressContext): Promise<boolean> {
  const root = path.join(ctx.stateDir, 'ingress');
  if (
    !(await fs.stat(root).then(
      () => true,
      () => false,
    ))
  )
    return false;
  await ctx.docker.removeContainer(CADDY_CONTAINER).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  return true;
}
