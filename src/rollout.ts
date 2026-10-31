// Rolling rollouts on the agent. A service with `x-tug.rollout.strategy: rolling` does not live in the
// node's main Compose project. Every distinct rendering of it runs as its own Compose project
// (`<project>-<service>-<hash>`) with a published host port taken from a free range, so the previous
// revision keeps serving while the new one starts and is health-checked. Control learns the new port
// from the status report and re-renders the ingress; after a drain delay the previous revision is
// removed. State lives in `<project dir>/rollout.json` so an agent restart resumes mid-rollout.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dumpYaml, isRolling, publishedPort } from './compose.ts';
import type { AgentContext } from './agent.ts';
import { ensureDir, errMessage, now, parseDuration } from './util.ts';
import type { ComposeFile, ComposeService, DesiredState, ServiceState } from './protocol.ts';

export const DEFAULT_DRAIN = '30s';
export const DEFAULT_PORT_RANGE = '20000-20999';
const LABEL_PROJECT = 'com.docker.compose.project';
const LABEL_SERVICE = 'com.docker.compose.service';

export function parsePortRange(value: string | undefined): [number, number] {
  const m = (value || DEFAULT_PORT_RANGE).trim().match(/^(\d+)-(\d+)$/);
  const lo = Number(m?.[1]);
  const hi = Number(m?.[2]);
  if (!m || lo < 1024 || hi > 65535 || lo > hi)
    throw new Error(
      `invalid rollout port range ${JSON.stringify(value)} (expected LOW-HIGH within 1024-65535, e.g. ${DEFAULT_PORT_RANGE})`,
    );
  return [lo, hi];
}

/** Compose project names allow lowercase letters, digits, dashes and underscores. */
export function revisionProject(project: string, service: string, hash: string): string {
  return `${project}-${service}-${hash.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** Returns `ports` with the host side of its (single) published entry replaced by `port`. */
export function remapPublishedPort(
  ports: NonNullable<ComposeService['ports']>,
  port: number,
): NonNullable<ComposeService['ports']> {
  return ports.map((entry) => {
    if (typeof entry === 'number') return entry;
    if (typeof entry === 'object')
      return entry.published !== undefined ? { ...entry, published: port } : entry;
    const [spec, ...protocol] = String(entry).split('/');
    const parts = spec.split(':');
    if (parts.length < 2) return entry;
    parts[parts.length - 2] = String(port);
    return [parts.join(':'), ...protocol].join('/');
  });
}

/** Identity of one revision of a service: its rendered definition and the versions of the secrets it uses. */
export function serviceRevisionHash(
  desired: DesiredState,
  rendered: ComposeService,
  service: string,
  secretVersions: Record<string, number> = {},
): string {
  const artifact = desired.services[service]?.artifact;
  const definition = { ...rendered, image: artifact?.imageId ?? rendered.image };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ definition, secretVersions }))
    .digest('hex')
    .slice(0, 16);
}

/** The Compose file of one rolling revision: the service alone, on the main project's network and volumes. */
export function rollingCompose(
  full: ComposeFile,
  project: string,
  service: string,
  port: number | null,
): ComposeFile {
  const svc: ComposeService = { ...full.services[service] };
  delete svc.depends_on;
  if (port !== null && svc.ports) svc.ports = remapPublishedPort(svc.ports, port);
  const out: ComposeFile = {
    services: { [service]: svc },
    networks: { default: { name: `${project}_default`, external: true } },
  } as ComposeFile;
  const volumes: NonNullable<ComposeFile['volumes']> = {};
  for (const mount of svc.volumes || []) {
    const source = typeof mount === 'string' ? mount.split(':')[0] : mount.source;
    const def = source ? full.volumes?.[source] : undefined;
    if (!source || !def) continue;
    // Named volumes keep the data the main project would use; explicit `name` / `external` volumes already do.
    volumes[source] =
      def.external || def.name ? def : { ...def, external: true, name: `${project}_${source}` };
  }
  if (Object.keys(volumes).length) out.volumes = volumes;
  return out;
}

// ---- Persistent state --------------------------------------------------------------------------

interface Revision {
  hash: string;
  project: string;
  port: number;
  image?: string;
  legacy?: boolean;
}
interface Draining {
  service: string;
  project: string;
  legacy?: boolean;
  drainUntil: number;
}
interface ServiceRollout {
  active?: Revision;
  candidate?: Revision;
  draining: Draining[];
  failed?: { key: string; error: string };
}
export interface RolloutState {
  services: Record<string, ServiceRollout>;
}

const stateFile = (dir: string) => path.join(dir, 'rollout.json');
export async function loadRolloutState(dir: string): Promise<RolloutState> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(dir), 'utf8')) as RolloutState;
    for (const s of Object.values(parsed.services)) s.draining ||= [];
    return parsed;
  } catch {
    return { services: {} };
  }
}
async function saveRolloutState(dir: string, state: RolloutState): Promise<void> {
  const tmp = `${stateFile(dir)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, stateFile(dir));
}

// ---- Docker helpers ----------------------------------------------------------------------------

/** `docker compose` arguments for a revision project, with relative paths and `.env` resolved against the main project dir. */
export function composeBase(project: string, dir: string, file: string): string[] {
  return ['compose', '-p', project, '--project-directory', dir, '-f', file];
}

async function containerIds(
  ctx: AgentContext,
  project: string,
  service?: string,
): Promise<string[]> {
  const filters = [
    '--filter',
    `label=${LABEL_PROJECT}=${project}`,
    ...(service ? ['--filter', `label=${LABEL_SERVICE}=${service}`] : []),
  ];
  return (await ctx.docker(['ps', '-aq', ...filters])).out.split(/\s+/).filter(Boolean);
}

/** Stops and removes every container of a revision project (or of one service of the main project). */
async function removeRevision(
  ctx: AgentContext,
  dir: string,
  project: string,
  service?: string,
): Promise<void> {
  const ids = await containerIds(ctx, project, service);
  if (ids.length) {
    await ctx.docker(['stop', ...ids]).catch(() => {});
    await ctx.docker(['rm', '-f', ...ids]);
  }
  if (!service) await fs.rm(path.join(dir, 'rollout', `${project}.yml`), { force: true });
}

async function ensureSharedResources(
  ctx: AgentContext,
  project: string,
  services: string[],
  full: ComposeFile,
): Promise<void> {
  const network = `${project}_default`;
  await ctx
    .docker(['network', 'inspect', network])
    .catch(() =>
      ctx.docker([
        'network',
        'create',
        '--label',
        `${LABEL_PROJECT}=${project}`,
        '--label',
        'com.docker.compose.network=default',
        network,
      ]),
    );
  const created = new Set<string>();
  for (const service of services) {
    for (const mount of full.services[service].volumes || []) {
      const source = typeof mount === 'string' ? mount.split(':')[0] : mount.source;
      const def = source ? full.volumes?.[source] : undefined;
      if (!source || !def || def.external || def.name || created.has(source)) continue;
      created.add(source);
      const opts = Object.entries(
        (def.driver_opts as Record<string, string> | undefined) || {},
      ).flatMap(([k, v]) => ['--opt', `${k}=${v}`]);
      await ctx.docker([
        'volume',
        'create',
        ...(def.driver ? ['--driver', String(def.driver)] : []),
        ...opts,
        '--label',
        `${LABEL_PROJECT}=${project}`,
        '--label',
        `com.docker.compose.volume=${source}`,
        `${project}_${source}`,
      ]);
    }
  }
}

/** Host ports already published by running containers (`0.0.0.0:20001->80/tcp, [::]:20001->80/tcp`). */
async function publishedHostPorts(ctx: AgentContext): Promise<Set<number>> {
  const out = (await ctx.docker(['ps', '--format', '{{.Ports}}'])).out;
  return new Set(
    [...out.matchAll(/:(\d+)(?:-(\d+))?->/g)].flatMap((m) => {
      const lo = Number(m[1]);
      const hi = Number(m[2] || m[1]);
      return Array.from({ length: Math.min(hi - lo + 1, 1000) }, (_, i) => lo + i);
    }),
  );
}

async function allocatePort(
  ctx: AgentContext,
  known: number[],
  exclude: Set<number>,
): Promise<number> {
  const [lo, hi] = parsePortRange(ctx.rolloutPorts);
  const busy = await publishedHostPorts(ctx);
  for (const port of [...known, ...exclude]) busy.add(port);
  // Start after the newest port in use so a just-released port is not reused straight away.
  const last = Math.max(lo - 1, ...known.filter((p) => p >= lo && p <= hi));
  const size = hi - lo + 1;
  for (let i = 0; i < size; i++) {
    const port = lo + ((last + 1 - lo + i) % size);
    if (!busy.has(port)) return port;
  }
  throw new Error(`no free host port left in the rollout range ${lo}-${hi} (TUG_ROLLOUT_PORTS)`);
}

const PORT_CONFLICT = /port is already allocated|address already in use|bind for .* failed/i;

// ---- Reconcile ---------------------------------------------------------------------------------

export interface RolloutDeps {
  waitForHealth: (project: string, service: string, composeFile: string) => Promise<void>;
  ensureArtifact: (service: string) => Promise<void>;
  emit: (service: string, event: string, message?: string) => Promise<unknown>;
}

export interface RollingInput {
  desired: DesiredState;
  /** The project's directory; revision Compose files go in `<dir>/rollout/`. */
  dir: string;
  /** Rolling services placed on this node. */
  services: string[];
  /** `composeForNode` output with no exclusions (so `extra_hosts`, `.env` and volumes are all present). */
  full: ComposeFile;
  secretVersions: Record<string, Record<string, number>>;
  deps: RolloutDeps;
}

export interface RollingResult {
  /** Reported state of every rolling service; the serving revision keeps `serving` while a newer one is rejected. */
  serviceStates: Record<string, ServiceState>;
  /** Services whose newest revision failed (or whose current revision is unhealthy), with the reason. */
  errors: Record<string, string>;
}

function servingState(rev: Revision, extra: Partial<ServiceState> = {}): ServiceState {
  return {
    rolloutState: 'serving',
    image: rev.image,
    healthyAt: now(),
    ...(rev.legacy ? {} : { port: rev.port }),
    rolloutRevision: rev.hash,
    ...extra,
  };
}

/** True when containers of `services` still run in the main project from before they became rolling. */
export async function hasLegacyContainers(
  ctx: AgentContext,
  project: string,
  services: string[],
): Promise<boolean> {
  for (const service of services)
    if ((await containerIds(ctx, project, service)).length) return true;
  return false;
}

export function isRollingService(desired: DesiredState, service: string): boolean {
  return isRolling(desired.compose.services[service]);
}

export async function reconcileRolling(
  ctx: AgentContext,
  input: RollingInput,
): Promise<RollingResult> {
  const { desired, dir, services, full, deps } = input;
  const project = desired.project;
  const state = await loadRolloutState(dir);
  const result: RollingResult = { serviceStates: {}, errors: {} };
  await ensureDir(path.join(dir, 'rollout'));
  // Drained revisions go first so their host ports are free for this rollout.
  await retireRevisions(ctx, dir, state, desired, new Set(services), deps);
  await ensureSharedResources(ctx, project, services, full);
  for (const service of services) {
    const rollout = (state.services[service] ||= { draining: [] });
    const spec = desired.compose.services[service];
    const declaredPort = publishedPort(spec, spec['x-tug']!.ingress!.port);
    const drainMs = parseDuration(spec['x-tug']?.rollout?.drain ?? DEFAULT_DRAIN, 30000);
    const hash = serviceRevisionHash(
      desired,
      full.services[service],
      service,
      input.secretVersions[service],
    );
    const revProject = revisionProject(project, service, hash);
    const file = path.join(dir, 'rollout', `${revProject}.yml`);
    const image = desired.services[service].image;
    // A service that used to be recreated still runs in the main project: it is the revision to replace.
    if (!rollout.active && declaredPort && (await containerIds(ctx, project, service)).length) {
      rollout.active = { hash: 'legacy', project, port: declaredPort, image, legacy: true };
    }
    if (rollout.candidate && rollout.candidate.hash !== hash) {
      await removeRevision(ctx, dir, rollout.candidate.project);
      delete rollout.candidate;
    }
    const writeCompose = (port: number) =>
      fs.writeFile(file, dumpYaml(rollingCompose(full, project, service, port)));
    const up = () => ctx.docker([...composeBase(revProject, dir, file), 'up', '-d'], { cwd: dir });

    if (rollout.active && rollout.active.hash === hash) {
      // Steady state: make sure the revision is still up and healthy; nothing restarts when it is.
      const active = { ...rollout.active, image };
      try {
        await writeCompose(active.port);
        await up();
        await deps.waitForHealth(revProject, service, file);
        delete rollout.failed;
        result.serviceStates[service] = servingState(active);
      } catch (e) {
        result.errors[service] = errMessage(e);
        result.serviceStates[service] = {
          rolloutState: 'health_checking',
          image,
          rolloutRevision: hash,
        };
      }
      continue;
    }

    const key = `${desired.revision || desired.version}:${hash}`;
    const reject = (error: string) => {
      result.errors[service] = error;
      result.serviceStates[service] = rollout.active
        ? servingState(rollout.active, { rolloutError: error })
        : { rolloutState: 'health_checking', image, rolloutRevision: hash };
    };
    if (rollout.failed?.key === key) {
      reject(rollout.failed.error);
      continue;
    }

    try {
      const candidate = rollout.candidate ?? {
        hash,
        project: revProject,
        port: await allocatePort(ctx, knownPorts(rollout), new Set()),
        image,
      };
      rollout.candidate = candidate;
      await saveRolloutState(dir, state);
      await deps.emit(service, 'pulling');
      await deps.ensureArtifact(service);
      const exclude = new Set<number>();
      for (let attempt = 0; ; attempt++) {
        await writeCompose(candidate.port);
        if (!desired.services[service].artifact)
          await ctx.docker([...composeBase(revProject, dir, file), 'pull', service], { cwd: dir });
        await deps.emit(
          service,
          'starting',
          `starting new revision on host port ${candidate.port}`,
        );
        try {
          await up();
          break;
        } catch (e) {
          if (attempt >= 4 || !PORT_CONFLICT.test(errMessage(e))) throw e;
          exclude.add(candidate.port);
          candidate.port = await allocatePort(ctx, knownPorts(rollout), exclude);
          await saveRolloutState(dir, state);
        }
      }
      await deps.emit(service, 'health_checking');
      await deps.waitForHealth(revProject, service, file);
      // Takeover: the next status report carries the new port and control re-renders the ingress.
      if (rollout.active)
        rollout.draining.push({
          service,
          project: rollout.active.project,
          legacy: rollout.active.legacy,
          drainUntil: Date.now() + drainMs,
        });
      rollout.active = { ...candidate };
      delete rollout.candidate;
      delete rollout.failed;
      await saveRolloutState(dir, state);
      result.serviceStates[service] = servingState(rollout.active);
      await deps.emit(
        service,
        'serving',
        `new revision serving on host port ${rollout.active.port}`,
      );
    } catch (e) {
      const error = errMessage(e);
      if (rollout.candidate)
        await removeRevision(ctx, dir, rollout.candidate.project).catch(() => {});
      delete rollout.candidate;
      rollout.failed = { key, error };
      await saveRolloutState(dir, state);
      reject(error);
      await deps.emit(
        service,
        'rollout_failed',
        `new revision rejected, previous revision keeps serving: ${error}`,
      );
    }
  }
  await saveRolloutState(dir, state);
  return result;
}

function knownPorts(rollout: ServiceRollout): number[] {
  return [rollout.active, rollout.candidate]
    .filter((r): r is Revision => Boolean(r && !r.legacy))
    .map((r) => r.port);
}

/** Removes drained revisions, and revisions of services that are no longer rolling on this node. */
async function retireRevisions(
  ctx: AgentContext,
  dir: string,
  state: RolloutState,
  desired: DesiredState,
  rolling: Set<string>,
  deps?: RolloutDeps,
): Promise<void> {
  for (const [service, rollout] of Object.entries(state.services)) {
    if (!rolling.has(service)) {
      // No longer rolling here. A service that is now recreated keeps the old revision for one drain so the switch is not abrupt.
      const stillRuns =
        desired.compose.services[service] &&
        (desired.services[service]?.placement?.nodes?.includes(ctx.nodeName) ||
          !desired.services[service]?.placement?.nodes?.length);
      if (rollout.candidate) {
        await removeRevision(ctx, dir, rollout.candidate.project).catch(() => {});
        delete rollout.candidate;
      }
      if (rollout.active && stillRuns) {
        rollout.draining.push({
          service,
          project: rollout.active.project,
          legacy: rollout.active.legacy,
          drainUntil: Date.now() + parseDuration(DEFAULT_DRAIN),
        });
        delete rollout.active;
      } else if (rollout.active) {
        await removeRevision(
          ctx,
          dir,
          rollout.active.project,
          rollout.active.legacy ? service : undefined,
        ).catch(() => {});
        delete rollout.active;
      }
    }
    const keep: Draining[] = [];
    for (const old of rollout.draining) {
      if (old.drainUntil > Date.now()) {
        keep.push(old);
        continue;
      }
      try {
        await removeRevision(ctx, dir, old.project, old.legacy ? old.service : undefined);
        await deps?.emit(
          service,
          'drained',
          `previous revision ${old.project} removed after drain`,
        );
      } catch {
        keep.push(old);
      }
    }
    rollout.draining = keep;
    if (!rollout.active && !rollout.candidate && !rollout.draining.length && !rollout.failed)
      delete state.services[service];
  }
}

/** Drain/cleanup pass for a project with no rolling service left on this node (or none at all). */
export async function retireAll(
  ctx: AgentContext,
  dir: string,
  desired: DesiredState,
): Promise<void> {
  if (
    !(await fs.stat(stateFile(dir)).then(
      () => true,
      () => false,
    ))
  )
    return;
  const state = await loadRolloutState(dir);
  await retireRevisions(ctx, dir, state, desired, new Set());
  await saveRolloutState(dir, state);
}

/** Reported states for rolling services whose current revision is still serving, used when another part of the reconcile failed. */
export async function activeRollingStates(
  dir: string,
  services: string[],
): Promise<Record<string, ServiceState>> {
  const state = await loadRolloutState(dir);
  const out: Record<string, ServiceState> = {};
  for (const service of services) {
    const active = state.services[service]?.active;
    if (active) out[service] = servingState(active);
  }
  return out;
}
