// The agent's container reconciler. Every service is one Docker container labelled with the hash of
// its resolved definition (`tug.config-hash`); a container whose hash no longer matches is replaced.
// `recreate` (the default) stops the old container and starts the new one. `rolling` starts the new
// container beside the old one on a free host port, health-checks it, lets the ingress switch, and
// removes the old one after a drain delay. State of rolling services lives in
// `<project dir>/rollout.json` so an agent restart resumes mid-rollout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRolling } from './compose.ts';
import {
  LABEL_HASH,
  LABEL_PROJECT,
  LABEL_SERVICE,
  startOrder,
  withHostPort,
} from './container-spec.ts';
import type { ContainerSpec, NodePlan } from './container-spec.ts';
import { isNotFound } from './docker-api.ts';
import type { ContainerSummary, DockerApi } from './docker-api.ts';
import { ensureDir, errMessage, now, parseDuration } from './util.ts';
import type { DesiredState, ServiceState } from './protocol.ts';

export const DEFAULT_DRAIN = '30s';
export const DEFAULT_PORT_RANGE = '20000-20999';

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

// ---- Containers --------------------------------------------------------------------------------

const containerNameOf = (c: ContainerSummary): string => (c.Names?.[0] || c.Id).replace(/^\//, '');

/** Containers of a project (or one service of it), running or not. */
export async function projectContainers(
  docker: DockerApi,
  project: string,
  service?: string,
): Promise<ContainerSummary[]> {
  return docker.listContainers({
    label: [`${LABEL_PROJECT}=${project}`, ...(service ? [`${LABEL_SERVICE}=${service}`] : [])],
  });
}

async function removeContainers(docker: DockerApi, containers: ContainerSummary[]): Promise<void> {
  for (const c of containers) {
    if (c.State === 'running') await docker.stopContainer(c.Id).catch(() => {});
    await docker.removeContainer(c.Id);
  }
}

async function removeByName(docker: DockerApi, name: string): Promise<void> {
  await docker.stopContainer(name).catch(() => {});
  await docker.removeContainer(name);
}

/** Creates the project network and its volumes; volumes are never removed by reconciliation. */
export async function ensureProjectResources(
  docker: DockerApi,
  project: string,
  plan: NodePlan,
): Promise<void> {
  if (!(await docker.inspectNetwork(plan.network)))
    await docker.createNetwork(plan.network, { [LABEL_PROJECT]: project });
  for (const volume of plan.volumes) {
    if (await docker.inspectVolume(volume.name)) continue;
    if (volume.external)
      throw new Error(`external volume ${volume.name} does not exist on this node`);
    await docker.createVolume(volume.name, {
      driver: volume.driver,
      opts: volume.opts,
      labels: volume.labels,
    });
  }
}

/** Makes sure a service's container exists for `spec`, running, replacing any container with another hash. */
export async function ensureContainer(
  docker: DockerApi,
  spec: ContainerSpec,
  existing: ContainerSummary[],
): Promise<string> {
  const match = existing.find((c) => c.Labels?.[LABEL_HASH] === spec.hash);
  await removeContainers(
    docker,
    existing.filter((c) => c !== match),
  );
  if (match) {
    if (match.State !== 'running') await docker.startContainer(match.Id);
    return match.Id;
  }
  const id = await docker.createContainer(spec.name, spec.body);
  await docker.startContainer(id);
  return id;
}

/** Removes containers of services that are not placed here any more (never volumes). */
export async function sweepOrphans(
  docker: DockerApi,
  project: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  const stray = (await projectContainers(docker, project)).filter(
    (c) => !keep.has(c.Labels?.[LABEL_SERVICE] ?? ''),
  );
  await removeContainers(docker, stray);
}

// ---- Rolling state -----------------------------------------------------------------------------

interface Revision {
  hash: string;
  /** Container name. */
  container: string;
  port: number;
  image?: string;
}
interface Draining {
  service: string;
  container: string;
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

/** Host ports already published by containers on this node. */
async function publishedHostPorts(docker: DockerApi): Promise<Set<number>> {
  return new Set(
    (await docker.listContainers({}, false)).flatMap((c) =>
      (c.Ports || []).flatMap((p) => (p.PublicPort ? [p.PublicPort] : [])),
    ),
  );
}

async function allocatePort(
  docker: DockerApi,
  range: string | undefined,
  known: number[],
  exclude: Set<number>,
): Promise<number> {
  const [lo, hi] = parsePortRange(range);
  const busy = await publishedHostPorts(docker);
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

function knownPorts(rollout: ServiceRollout): number[] {
  return [rollout.active, rollout.candidate]
    .filter((r): r is Revision => Boolean(r))
    .map((r) => r.port);
}

// ---- Reconcile ---------------------------------------------------------------------------------

export interface ReconcileDeps {
  /**
   * Throws until the container is healthy under the service's `x-tug.health`. With `dependency` a
   * service without one is held to its Docker `HEALTHCHECK`, which is what `service_healthy` means.
   */
  waitForHealth: (container: string, service: string, dependency?: boolean) => Promise<void>;
  ensureArtifact: (service: string) => Promise<void>;
  /** Pulls the service's published image. */
  pullImage: (service: string) => Promise<void>;
  emit: (service: string, event: string, message?: string) => Promise<unknown>;
}

export interface ReconcileInput {
  desired: DesiredState;
  /** The project's state directory (`rollout.json`). */
  dir: string;
  plan: NodePlan;
  nodeName: string;
  rolloutPorts?: string;
  deps: ReconcileDeps;
}

/** Waits for the dependencies a service started with `service_healthy` on. */
async function waitForDependencies(
  docker: DockerApi,
  spec: ContainerSpec,
  containers: Map<string, string>,
  deps: ReconcileDeps,
): Promise<void> {
  for (const [dep, condition] of Object.entries(spec.dependsOn)) {
    const id = containers.get(dep);
    if (condition === 'service_healthy' && id) await deps.waitForHealth(id, dep, true);
  }
}

/**
 * Recreate-strategy services: pull, then create/start each in dependency order. `onStarting` and
 * `onHealth` let the agent report per-service state; a failure throws with the service named in
 * `failing`.
 */
export async function reconcileRecreate(
  docker: DockerApi,
  input: ReconcileInput & { services: string[]; pull: boolean },
  report: {
    pulling: (service: string) => Promise<void>;
    starting: (service: string) => Promise<void>;
    checking: (service: string) => Promise<void>;
    serving: (service: string) => Promise<void>;
    failing: (service: string | undefined) => void;
  },
): Promise<void> {
  const { plan, deps, services, desired } = input;
  const only = Object.fromEntries(services.map((s) => [s, plan.specs[s]]));
  for (const service of services) await report.pulling(service);
  for (const service of services) {
    if (desired.services[service].artifact) await deps.ensureArtifact(service);
    else if (input.pull || !(await docker.inspectImage(plan.specs[service].body.Image)))
      await deps.pullImage(service);
  }
  const ids = new Map<string, string>();
  const order = startOrder(
    Object.fromEntries(
      Object.entries(only).map(([name, spec]) => [
        name,
        {
          ...spec,
          dependsOn: Object.fromEntries(Object.entries(spec.dependsOn).filter(([d]) => d in only)),
        },
      ]),
    ),
  );
  for (const service of order) {
    const spec = plan.specs[service];
    await report.starting(service);
    report.failing(service);
    await waitForDependencies(docker, spec, ids, deps);
    ids.set(
      service,
      await ensureContainer(
        docker,
        spec,
        await projectContainers(docker, desired.project, service),
      ),
    );
    report.failing(undefined);
  }
  for (const service of order) {
    await report.checking(service);
    report.failing(service);
    await deps.waitForHealth(ids.get(service)!, service);
    report.failing(undefined);
    await report.serving(service);
  }
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
    port: rev.port,
    rolloutRevision: rev.hash,
    ...extra,
  };
}

export const isRollingService = (desired: DesiredState, service: string): boolean =>
  isRolling(desired.compose.services[service]);

/** The host port a container publishes for the container port `target`. */
function publishedOf(c: ContainerSummary, target: number | null): number | undefined {
  const ports = (c.Ports || []).filter((p) => p.PublicPort);
  return (ports.find((p) => p.PrivatePort === target) ?? ports[0])?.PublicPort;
}

export async function reconcileRolling(
  docker: DockerApi,
  input: ReconcileInput & { services: string[] },
): Promise<RollingResult> {
  const { desired, dir, services, plan, deps } = input;
  const project = desired.project;
  const state = await loadRolloutState(dir);
  const result: RollingResult = { serviceStates: {}, errors: {} };
  await ensureDir(dir);
  // Drained revisions go first so their host ports are free for this rollout.
  await retireRevisions(docker, dir, state, new Set(services), deps);
  for (const service of services) {
    const rollout = (state.services[service] ||= { draining: [] });
    const spec = plan.specs[service];
    const ext = desired.compose.services[service];
    const ingressPort = ext['x-tug']!.ingress!.port;
    const drainMs = parseDuration(ext['x-tug']?.rollout?.drain ?? DEFAULT_DRAIN, 30000);
    const image = desired.services[service].image;
    // Adopt a container that predates the rollout state (a service that used to be recreated, or a lost state file).
    const present = await projectContainers(docker, project, service);
    if (!rollout.active) {
      const adopt = present.find((c) => c.State === 'running');
      const port = adopt && publishedOf(adopt, ingressPort);
      if (adopt && port)
        rollout.active = {
          hash: adopt.Labels?.[LABEL_HASH] ?? 'unknown',
          container: containerNameOf(adopt),
          port,
          image,
        };
    }
    if (rollout.candidate && rollout.candidate.hash !== spec.hash) {
      await removeByName(docker, rollout.candidate.container).catch(() => {});
      delete rollout.candidate;
    }

    if (rollout.active && rollout.active.hash === spec.hash) {
      // Steady state: make sure the revision is still up and healthy; nothing restarts when it is.
      const active = { ...rollout.active, image };
      try {
        const running = present.find((c) => containerNameOf(c) === active.container);
        if (!running)
          await docker.startContainer(
            await docker.createContainer(active.container, withHostPort(spec.body, active.port)),
          );
        else if (running.State !== 'running') await docker.startContainer(running.Id);
        await deps.waitForHealth(active.container, service);
        delete rollout.failed;
        result.serviceStates[service] = servingState(active);
      } catch (e) {
        result.errors[service] = errMessage(e);
        result.serviceStates[service] = {
          rolloutState: 'health_checking',
          image,
          rolloutRevision: spec.hash,
        };
      }
      continue;
    }

    const key = `${desired.revision || desired.version}:${spec.hash}`;
    const reject = (error: string) => {
      result.errors[service] = error;
      result.serviceStates[service] = rollout.active
        ? servingState(rollout.active, { rolloutError: error })
        : { rolloutState: 'health_checking', image, rolloutRevision: spec.hash };
    };
    if (rollout.failed?.key === key) {
      reject(rollout.failed.error);
      continue;
    }

    try {
      const candidate = rollout.candidate ?? {
        hash: spec.hash,
        container: spec.name,
        port: await allocatePort(docker, input.rolloutPorts, knownPorts(rollout), new Set()),
        image,
      };
      rollout.candidate = candidate;
      await saveRolloutState(dir, state);
      await deps.emit(service, 'pulling');
      if (desired.services[service].artifact) await deps.ensureArtifact(service);
      else await deps.pullImage(service);
      const exclude = new Set<number>();
      for (let attempt = 0; ; attempt++) {
        await deps.emit(
          service,
          'starting',
          `starting new revision on host port ${candidate.port}`,
        );
        try {
          await removeByName(docker, candidate.container);
          const id = await docker.createContainer(
            candidate.container,
            withHostPort(spec.body, candidate.port),
          );
          await docker.startContainer(id);
          break;
        } catch (e) {
          if (attempt >= 4 || !PORT_CONFLICT.test(errMessage(e))) throw e;
          exclude.add(candidate.port);
          candidate.port = await allocatePort(
            docker,
            input.rolloutPorts,
            knownPorts(rollout),
            exclude,
          );
          await saveRolloutState(dir, state);
        }
      }
      await deps.emit(service, 'health_checking');
      await deps.waitForHealth(candidate.container, service);
      // Takeover: the next status report carries the new port and control re-renders the ingress.
      if (rollout.active)
        rollout.draining.push({
          service,
          container: rollout.active.container,
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
        await removeByName(docker, rollout.candidate.container).catch(() => {});
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
  // Containers of a rolling service that are no revision of it (a failed adoption, a lost state file).
  for (const service of services) {
    const rollout = state.services[service];
    const known = new Set(
      [
        rollout?.active?.container,
        rollout?.candidate?.container,
        ...(rollout?.draining || []).map((d) => d.container),
      ].filter(Boolean),
    );
    const stray = (await projectContainers(docker, project, service)).filter(
      (c) => !known.has(containerNameOf(c)),
    );
    await removeContainers(docker, stray).catch(() => {});
  }
  await saveRolloutState(dir, state);
  return result;
}

/** Removes drained revisions, and revisions of services that are no longer rolling on this node. */
async function retireRevisions(
  docker: DockerApi,
  dir: string,
  state: RolloutState,
  rolling: Set<string>,
  deps?: Pick<ReconcileDeps, 'emit'>,
): Promise<void> {
  for (const [service, rollout] of Object.entries(state.services)) {
    if (!rolling.has(service)) {
      // No longer rolling here: the recreate path (or the orphan sweep) removes the containers.
      delete state.services[service];
      continue;
    }
    const keep: Draining[] = [];
    for (const old of rollout.draining) {
      if (old.drainUntil > Date.now()) {
        keep.push(old);
        continue;
      }
      try {
        await removeByName(docker, old.container);
        await deps?.emit(
          service,
          'drained',
          `previous revision ${old.container} removed after drain`,
        );
      } catch (e) {
        if (!isNotFound(e)) keep.push(old);
      }
    }
    rollout.draining = keep;
    if (!rollout.active && !rollout.candidate && !rollout.draining.length && !rollout.failed)
      delete state.services[service];
  }
}

/** Drops rolling state of a project that has no rolling service on this node any more. */
export async function clearRolloutState(dir: string): Promise<void> {
  await fs.rm(stateFile(dir), { force: true });
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
