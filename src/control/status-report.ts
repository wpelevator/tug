import { isPort } from '../node-address.ts';
import type {
  CommandResult,
  EdgeProbeResult,
  IngressHostTls,
  IngressStatus,
  JobStatus,
  ProjectStatus,
  RolloutState,
  ServiceState,
  StatusReport,
} from '../protocol.ts';

const HEALTH = ['serving', 'skipped', 'failed'];
const ROLLOUT_STATES: RolloutState[] = [
  'pending',
  'pulling',
  'starting',
  'health_checking',
  'serving',
  'held',
];
const JOB_PHASES = [
  'queued',
  'pulling',
  'checking',
  'dumping',
  'uploading',
  'forgetting',
  'restoring',
];
const JOB_LANES = ['restore', 'manual', 'scheduled'];
const MAX_ENTRIES = 1000;

export class StatusReportError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, path: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new StatusReportError(`${path} must be a string`);
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES)
    throw new StatusReportError(`${path} must be an array of at most ${MAX_ENTRIES} entries`);
  return value;
}

function serviceState(value: unknown, path: string): ServiceState {
  if (!isObject(value)) throw new StatusReportError(`${path} must be an object`);
  if (!ROLLOUT_STATES.includes(value.rolloutState as RolloutState))
    throw new StatusReportError(`${path}.rolloutState must be one of ${ROLLOUT_STATES.join(', ')}`);
  if (value.port !== undefined && !isPort(value.port))
    throw new StatusReportError(`${path}.port must be an integer from 1 to 65535`);
  return {
    rolloutState: value.rolloutState as RolloutState,
    ...(value.image !== undefined && { image: text(value.image, `${path}.image`) }),
    ...(value.healthyAt !== undefined && { healthyAt: text(value.healthyAt, `${path}.healthyAt`) }),
    ...(value.port !== undefined && { port: value.port as number }),
    ...(value.rolloutRevision !== undefined && {
      rolloutRevision: text(value.rolloutRevision, `${path}.rolloutRevision`),
    }),
    ...(value.rolloutError !== undefined && {
      rolloutError: text(value.rolloutError, `${path}.rolloutError`),
    }),
    ...(value.degraded !== undefined && {
      degraded: text(value.degraded, `${path}.degraded`)!.slice(0, 500),
    }),
    ...(value.unstable !== undefined && { unstable: text(value.unstable, `${path}.unstable`) }),
  };
}

function projectStatus(value: unknown, path: string): ProjectStatus {
  if (!isObject(value)) throw new StatusReportError(`${path} must be an object`);
  if (!HEALTH.includes(value.health as string))
    throw new StatusReportError(`${path}.health must be one of ${HEALTH.join(', ')}`);
  const states = value.serviceStates;
  if (states !== undefined && !isObject(states))
    throw new StatusReportError(`${path}.serviceStates must be an object`);
  return {
    project: text(value.project, `${path}.project`)!,
    observedVersion: text(value.observedVersion, `${path}.observedVersion`)!,
    ...(value.observedRevision !== undefined && {
      observedRevision: text(value.observedRevision, `${path}.observedRevision`),
    }),
    health: value.health as ProjectStatus['health'],
    ...(value.services !== undefined && {
      services: list(value.services, `${path}.services`).map((name, i) =>
        text(name, `${path}.services[${i}]`)!,
      ),
    }),
    ...(states && {
      serviceStates: Object.fromEntries(
        Object.entries(states).map(([name, state]) => [
          name,
          serviceState(state, `${path}.serviceStates.${name}`),
        ]),
      ),
    }),
    ...(value.error !== undefined && { error: text(value.error, `${path}.error`) }),
  };
}

function commandResult(value: unknown, path: string): CommandResult {
  if (!isObject(value)) throw new StatusReportError(`${path} must be an object`);
  if (value.state !== 'succeeded' && value.state !== 'failed')
    throw new StatusReportError(`${path}.state must be succeeded or failed`);
  if (value.result !== undefined && !isObject(value.result))
    throw new StatusReportError(`${path}.result must be an object`);
  return {
    commandId: text(value.commandId, `${path}.commandId`)!,
    state: value.state,
    result: (value.result ?? {}) as CommandResult['result'],
  };
}

function job(value: unknown, path: string): JobStatus {
  if (!isObject(value)) throw new StatusReportError(`${path} must be an object`);
  if (!JOB_PHASES.includes(value.phase as string))
    throw new StatusReportError(`${path}.phase must be one of ${JOB_PHASES.join(', ')}`);
  return {
    commandId: text(value.commandId, `${path}.commandId`)!,
    runId: text(value.runId, `${path}.runId`)!,
    phase: value.phase as JobStatus['phase'],
    startedAt: text(value.startedAt, `${path}.startedAt`)!,
    ...(typeof value.bytes === 'number' && { bytes: value.bytes }),
    ...(JOB_LANES.includes(value.lane as string) && { lane: value.lane as JobStatus['lane'] }),
    ...(value.waitingFor !== undefined && {
      waitingFor: text(value.waitingFor, `${path}.waitingFor`),
    }),
  };
}

function ingressStatus(value: unknown): IngressStatus {
  if (!isObject(value)) throw new StatusReportError('ingress must be an object');
  if (value.state !== 'serving' && value.state !== 'failed')
    throw new StatusReportError('ingress.state must be serving or failed');
  if (typeof value.routes !== 'number' || !Number.isInteger(value.routes) || value.routes < 0)
    throw new StatusReportError('ingress.routes must be a non-negative integer');
  return {
    state: value.state,
    configHash: text(value.configHash, 'ingress.configHash')!,
    routes: value.routes,
    ...(value.error !== undefined && { error: text(value.error, 'ingress.error') }),
    ...(value.tls !== undefined && {
      tls: list(value.tls, 'ingress.tls')
        .slice(0, MAX_INGRESS_CERTS)
        .map((c, i) => ingressHostTls(c, `ingress.tls[${i}]`)),
    }),
    ...(value.edgeProbe === true && { edgeProbe: true }),
    ...(value.probeResults !== undefined && {
      probeResults: list(value.probeResults, 'ingress.probeResults').map((r, i) =>
        probeResult(r, `ingress.probeResults[${i}]`),
      ),
    }),
  };
}

function probeResult(value: unknown, path: string): EdgeProbeResult {
  if (!isObject(value)) throw new StatusReportError(`${path} must be an object`);
  if (typeof value.ok !== 'boolean') throw new StatusReportError(`${path}.ok must be a boolean`);
  const error = text(value.error, `${path}.error`, true);
  return {
    id: text(value.id, `${path}.id`)!.slice(0, 300),
    ok: value.ok,
    ...(error !== undefined && {
      error: [...error]
        .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
        .join('')
        .slice(0, 300),
    }),
  };
}

const MAX_INGRESS_CERTS = 256;
function ingressHostTls(value: unknown, path: string): IngressHostTls {
  if (!isObject(value)) throw new StatusReportError(`${path} must be an object`);
  if (value.state !== 'issued' && value.state !== 'pending' && value.state !== 'failed')
    throw new StatusReportError(`${path}.state must be issued, pending or failed`);
  const host = text(value.host, `${path}.host`)!;
  if (host.length > 253) throw new StatusReportError(`${path}.host is too long`);
  const since = text(value.since, `${path}.since`)!;
  if (!Number.isFinite(Date.parse(since)))
    throw new StatusReportError(`${path}.since must be a date`);
  const notAfter = text(value.notAfter, `${path}.notAfter`, true);
  if (notAfter !== undefined && !Number.isFinite(Date.parse(notAfter)))
    throw new StatusReportError(`${path}.notAfter must be a date`);
  const issuer = text(value.issuer, `${path}.issuer`, true);
  const error = text(value.error, `${path}.error`, true);
  // Error text from Caddy ends up in terminals and doctor output.
  const plain = (v: string) =>
    [...v].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');
  return {
    host: plain(host),
    state: value.state,
    since,
    ...(notAfter !== undefined && { notAfter }),
    ...(issuer !== undefined && { issuer: plain(issuer).slice(0, 100) }),
    ...(error !== undefined && { error: plain(error).slice(0, 300) }),
  };
}

/**
 * Validates and normalizes a node's `POST /agent/v1/status` body before anything is stored. Reported values
 * flow into other nodes' work responses and the shared ingress configuration, so unknown fields are dropped
 * and every kept field is checked against its protocol type. Throws `StatusReportError` for a malformed report.
 */
export function parseStatusReport(body: unknown): StatusReport {
  if (!isObject(body)) throw new StatusReportError('status report must be an object');
  return {
    node: typeof body.node === 'string' ? body.node : '',
    ...(typeof body.sentAt === 'string' &&
      Number.isFinite(Date.parse(body.sentAt)) && { sentAt: body.sentAt }),
    projects: list(body.projects, 'projects').map((p, i) => projectStatus(p, `projects[${i}]`)),
    commandResults: list(body.commandResults, 'commandResults').map((r, i) =>
      commandResult(r, `commandResults[${i}]`),
    ),
    ...(body.ingress !== undefined && { ingress: ingressStatus(body.ingress) }),
    ...(body.jobs !== undefined && {
      jobs: list(body.jobs, 'jobs').map((j, i) => job(j, `jobs[${i}]`)),
    }),
  };
}
