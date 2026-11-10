#!/usr/bin/env node
import express from 'express';
import {
  resolveImage,
  parseRegistryCredentials,
  imageLocation,
  REGISTRY_AUTH_SECRET,
} from '../images/registry.ts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { DockerEngine } from '../docker-api.ts';
import type { DockerApi } from '../docker-api.ts';
import { pipeline } from 'node:stream/promises';
import { packageVersion } from '../images/image.ts';
import {
  saveImageArchive,
  inspectEngineImage,
  validateImageArchive,
  hashArchive,
} from '../images/artifacts.ts';
import type { ArchiveInfo } from '../images/artifacts.ts';
import { scanArchive } from '../images/archive.ts';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { WatchHub } from './watch.ts';
import type tls from 'node:tls';
import * as tar from 'tar';
import { openDb, openSnapshotDb } from '../db/db.ts';
import type { Db } from '../db/db.ts';
import { isUniqueViolation } from '../db/driver.ts';
import { lockQueries } from '../db/locks.ts';
import { backupDestinationQueries } from '../backup/destination-store.ts';
import { immediateTransaction } from '../db/transaction.ts';
import type {
  CommandRow,
  DeploymentRow,
  DesiredStateRow,
  EnrollmentCredentialRow,
  LockRow,
  NodeRow,
  ProjectRow,
  SecretRow,
  VolumeRow,
} from '../db/db.ts';
import { encrypt, decrypt, loadOrCreateMasterKey } from './secrets.ts';
import {
  buildDesiredState,
  ingressHostsOf,
  ingressHostsOverlap,
  domainProblem,
  publishesHostPort,
  loopbackIngressServices,
  serviceSecretNames,
  validateCompose,
} from '../compose/compose.ts';
import { buildImage, unpackContext, run as runCommand } from '../images/build.ts';
import { sentinelNames } from '../compose/normalize.ts';
import {
  MAX_VAR_BYTES,
  RESERVED_VALUE_NAMES,
  VALUE_NAME,
  VALUE_NAME_MESSAGE,
  VALUE_SOURCES,
  misplacedSecrets,
} from '../values.ts';
import type { DeploymentValue, ValueSource } from '../values.ts';
import { errMessage } from '../errors.ts';
import { id, now } from '../db/row.ts';
import { ensureDir } from '../files.ts';
import {
  ENROLL_DEFAULT_TTL_MS,
  NODE_LIFETIME_MS,
  Pki,
  SERVER_LIFETIME_MS,
  encodeCredential,
  identityUri,
  namesKey,
  parseIdentityUri,
  peerIdentity,
  serverNames,
  writeFileDurable,
} from '../pki.ts';
import { EXPIRY_WARN_DAYS, certificateExpiry, diagnoseNode, nodeStatus } from './diagnostics.ts';
import { serverTlsOptions } from './tls-server.ts';
import { isNodeHost } from '../node-address.ts';
import {
  ASK_PORT,
  CADDY_ADMIN_PORT,
  buildIngressWork,
  ingressConfigHash,
  resolveServiceEndpoints,
} from '../ingress.ts';
import { parseStatusReport } from './status-report.ts';
import { advance, advanceWhere, statesSql } from '../db/lifecycle.ts';
import { buildLifecycle, commandLifecycle, deploymentLifecycle } from '../db/lifecycles.ts';
import type { DeploymentState } from '../db/lifecycles.ts';
import type { NodeView } from '../ingress.ts';
import {
  ACTIVE_DEPLOYMENT_STATES,
  LIVE_MAX_FRAME_BYTES,
  LIVE_MAX_BUFFERED_BYTES,
  LIVE_AGENT_MAX_BUFFERED_BYTES,
  LIVE_MAX_SESSIONS,
  LIVE_START_TIMEOUT_MS,
  BACKUP_COMMAND_TYPES,
  CLIENT_VERSION_HEADER,
  SKEW_CLIENT_NEWER,
  STREAM_FEATURES,
  VERSION_STAMP_HEADER,
  compareCompat,
  majorMinor,
} from '../protocol.ts';
import {
  isReservedProject,
  parseBackupDestination,
  projectRepository,
  repositoryPassword,
  redactSecrets,
} from '../backup/destination.ts';
import {
  CONTROL_SNAPSHOT_ID,
  controlRepository,
  controlRepositoryPassword,
  fetchControlArchive,
  listControlSnapshots,
  pushControlArchive,
} from '../backup/control-backup.ts';
import { DEFAULT_RESTIC_IMAGE, createBackupService } from '../backup/scheduler.ts';
import {
  activateRestore,
  finishActivation,
  recoverActivation,
  retireAfterRestore,
} from './restore-activation.ts';
import type { ActivationStep } from './restore-activation.ts';
import { createRestoreService, discoverWriters } from '../backup/restore.ts';
import {
  AUTO_ROLLBACK_ACTOR,
  ROUTE_ROLES,
  authenticate,
  hasRole,
  assertProject,
  bodyProject,
  createGuard,
  createCredential,
  listCredentials,
  parseCredentialRequest,
  queryProject,
  recordEvent,
  revokeCredential,
} from './credentials.ts';
import { PROJECT_NAME_PATTERN } from '../roles.ts';
import type { Actor, Identity, ProjectResolver, RouteRole } from './credentials.ts';
import { eventForRole } from './event-redaction.ts';
import type { RedactableEvent } from './event-redaction.ts';
import type {
  BackupCredentialsResponse,
  LiveRequest,
  LiveInput,
  OperatorLiveMessage,
  ImageArtifact,
  LocalImageUpload,
  AgentEvent,
  ProjectStatus,
  CommandType,
  ComposeFile,
  DesiredState,
  EnrollRequest,
  EnrollResponse,
  NodeInfo,
  PortBinding,
  EnrollmentCredentialResponse,
  IdentityRequest,
  IdentityResponse,
  RenewResponse,
  SecretsResponse,
  ServiceEndpoints,
  StatusReport,
  StreamMessage,
  WakeResponse,
  WorkResponse,
} from '../protocol.ts';

class WakeHub {
  private readonly onPresence: () => void;
  constructor(onPresence: () => void = () => {}) {
    this.onPresence = onPresence;
  }
  private readonly cursors = new Map<string, number>();
  private readonly projects = new Map<string, string | undefined>();
  private readonly streams = new Map<string, WebSocket>();
  private readonly waiters = new Map<string, Set<() => void>>();

  cursor(nodeId: string): number {
    return this.cursors.get(nodeId) ?? 0;
  }

  /** Whether the node's agent holds an open stream socket right now. */
  connected(nodeId: string): boolean {
    return this.streams.get(nodeId)?.readyState === WebSocket.OPEN;
  }

  connect(nodeId: string, ws: WebSocket): void {
    const previous = this.streams.get(nodeId);
    if (previous && previous !== ws) previous.close(1000, 'replaced by a newer agent connection');
    this.streams.set(nodeId, ws);
    const ready: StreamMessage = {
      type: 'ready',
      nodeId,
      cursor: this.cursor(nodeId),
      features: STREAM_FEATURES,
    };
    ws.send(JSON.stringify(ready));
    this.onPresence();
    ws.once('close', () => {
      if (this.streams.get(nodeId) !== ws) return;
      this.streams.delete(nodeId);
      this.onPresence();
    });
  }

  wake(nodeId: string, project?: string): void {
    const cursor = this.cursor(nodeId) + 1;
    this.cursors.set(nodeId, cursor);
    this.projects.set(nodeId, project);
    const ws = this.streams.get(nodeId);
    if (ws?.readyState === WebSocket.OPEN) {
      const message: StreamMessage = {
        type: 'work-available',
        cursor,
        ...(project ? { project } : {}),
      };
      ws.send(JSON.stringify(message));
    }
    for (const resolve of this.waiters.get(nodeId) ?? []) resolve();
  }

  async wait(nodeId: string, after: number, timeoutMs: number): Promise<WakeResponse> {
    const response = (): WakeResponse => {
      const cursor = this.cursor(nodeId);
      const project = this.projects.get(nodeId);
      return {
        type: cursor > after ? 'work-available' : 'timeout',
        cursor,
        ...(project ? { project } : {}),
      };
    };
    if (this.cursor(nodeId) > after) return response();
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(nodeId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size) this.waiters.delete(nodeId);
        resolve();
      };
      waiters.add(done);
      this.waiters.set(nodeId, waiters);
      const timer = setTimeout(done, timeoutMs);
    });
    return response();
  }
}

interface LiveSession {
  id: string;
  operator: WebSocket;
  agent: WebSocket;
  request: LiveRequest;
  node: string;
  started: boolean;
  timer: NodeJS.Timeout;
}
const objectFrame = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const frameKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const liveDimension = (value: unknown) =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const liveBase64 = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
function parseLiveRequest(value: unknown): LiveRequest {
  if (
    !objectFrame(value) ||
    typeof value.project !== 'string' ||
    !PROJECT_NAME_PATTERN.test(value.project) ||
    value.project.length > 128 ||
    (value.node !== undefined &&
      (typeof value.node !== 'string' ||
        !PROJECT_NAME_PATTERN.test(value.node) ||
        value.node.length > 128))
  )
    throw new Error('invalid live request project or node');
  const common = ['operation', 'project', 'node'];
  if (value.operation === 'ps' && frameKeys(value, common)) return value as unknown as LiveRequest;
  if (
    typeof value.service !== 'string' ||
    !PROJECT_NAME_PATTERN.test(value.service) ||
    value.service.length > 128
  )
    throw new Error('invalid live request service');
  if (value.operation === 'inspect' && frameKeys(value, [...common, 'service']))
    return value as unknown as LiveRequest;
  if (
    value.operation === 'logs' &&
    frameKeys(value, [...common, 'service', 'follow', 'tail']) &&
    value.follow === true &&
    Number.isSafeInteger(value.tail) &&
    Number(value.tail) >= 0 &&
    Number(value.tail) <= 10_000
  )
    return value as unknown as LiveRequest;
  if (
    value.operation === 'exec' &&
    frameKeys(value, [
      ...common,
      'service',
      'command',
      'interactive',
      'tty',
      'columns',
      'rows',
      'oneOff',
    ]) &&
    (value.oneOff === undefined || value.oneOff === true) &&
    (value.oneOff !== true || (value.interactive === false && value.tty === false)) &&
    Array.isArray(value.command) &&
    value.command.length > 0 &&
    value.command.length <= 256 &&
    typeof value.command[0] === 'string' &&
    value.command[0].length > 0 &&
    value.command.every(
      (part) => typeof part === 'string' && !part.includes('\0') && part.length <= 32768,
    ) &&
    typeof value.interactive === 'boolean' &&
    typeof value.tty === 'boolean' &&
    (value.columns === undefined || liveDimension(value.columns)) &&
    (value.rows === undefined || liveDimension(value.rows))
  )
    return value as unknown as LiveRequest;
  throw new Error('invalid or unsupported live request');
}

/** Ephemeral sessions are bound to socket identities; reconnecting never replays work. */
export class LiveHub {
  private readonly agents = new Map<string, WebSocket>();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly retired = new WeakMap<WebSocket, Set<string>>();
  private readonly agentSockets = new WeakSet<WebSocket>();
  private readonly startTimeoutMs: number;
  private readonly resolve: (actor: Actor, request: LiveRequest) => Promise<NodeRow>;
  private readonly onAgentEvents: (nodeId: string, events: unknown[]) => void;
  constructor(
    resolve: (actor: Actor, request: LiveRequest) => Promise<NodeRow>,
    startTimeoutMs = LIVE_START_TIMEOUT_MS,
    onAgentEvents: (nodeId: string, events: unknown[]) => void = () => {},
  ) {
    this.resolve = resolve;
    this.startTimeoutMs = startTimeoutMs;
    this.onAgentEvents = onAgentEvents;
  }
  /**
   * Sends unless the socket already holds `limit` unsent bytes. Flow control keeps a session's output under the
   * operator limit; an agent socket carries every session on its node, so it gets the larger agent limit.
   */
  private send(ws: WebSocket, frame: unknown): boolean {
    const limit = this.agentSockets.has(ws)
      ? LIVE_AGENT_MAX_BUFFERED_BYTES
      : LIVE_MAX_BUFFERED_BYTES;
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > limit) return false;
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) + ws.bufferedAmount > limit) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }
  private finish(session: LiveSession, frame?: OperatorLiveMessage, cancel = true): void {
    if (!this.sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    const retired = this.retired.get(session.agent) ?? new Set<string>();
    retired.add(session.id);
    if (retired.size > 1024) retired.delete(retired.values().next().value!);
    this.retired.set(session.agent, retired);
    // If cancellation cannot enter a congested agent socket, disconnect it so its local engine disposes every operation.
    if (cancel && !this.send(session.agent, { v: 1, type: 'live.cancel', sessionId: session.id }))
      session.agent.terminate();
    if (frame) this.send(session.operator, frame);
    session.operator.close(1000, 'live operation finished');
  }
  private fail(session: LiveSession, message: string): void {
    this.finish(session, { v: 1, type: 'live.error', sessionId: session.id, message });
  }
  agent(nodeId: string, ws: WebSocket): void {
    const previous = this.agents.get(nodeId);
    if (previous && previous !== ws)
      for (const session of this.sessions.values())
        if (session.agent === previous) this.fail(session, 'agent connection replaced');
    this.agents.set(nodeId, ws);
    this.agentSockets.add(ws);
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.agents.get(nodeId) === ws) this.agents.delete(nodeId);
      for (const session of this.sessions.values())
        if (session.agent === ws) this.fail(session, 'agent disconnected');
    });
    ws.on('message', (data, binary) => {
      try {
        if (binary || Buffer.byteLength(data.toString()) > LIVE_MAX_FRAME_BYTES)
          throw new Error('invalid frame');
        const frame: unknown = JSON.parse(data.toString());
        // Events an agent reports are not part of a live session: they go to the same log as `POST /agent/v1/events`.
        if (
          objectFrame(frame) &&
          frame.v === 1 &&
          frame.type === 'agent.event' &&
          frameKeys(frame, ['v', 'type', 'events']) &&
          Array.isArray(frame.events)
        ) {
          // Losing an event is better than dropping the socket, which also carries live exec and log sessions.
          try {
            this.onAgentEvents(nodeId, frame.events);
          } catch (error) {
            console.error(`agent events from node ${nodeId} were not stored: ${errMessage(error)}`);
          }
          return;
        }
        if (!objectFrame(frame) || frame.v !== 1 || typeof frame.sessionId !== 'string')
          throw new Error('invalid frame');
        const session = this.sessions.get(frame.sessionId);
        if (!session && this.retired.get(ws)?.has(frame.sessionId)) return;
        if (!session || session.agent !== ws) throw new Error('foreign or unknown session');
        const keys = ['v', 'type', 'sessionId'];
        if (
          frame.type === 'live.started' &&
          frameKeys(frame, [...keys, 'flow']) &&
          (frame.flow === undefined || frame.flow === true) &&
          !session.started
        ) {
          session.started = true;
          clearTimeout(session.timer);
          if (
            !this.send(session.operator, {
              v: 1,
              type: 'live.started',
              sessionId: session.id,
              node: session.node,
              // An agent that paces by acknowledgements says so; the CLI then paces its input by the agent's.
              ...(frame.flow === true ? { flow: true } : {}),
            })
          )
            this.fail(session, 'operator buffer limit exceeded');
        } else if (
          frame.type === 'live.stdin-ack' &&
          frameKeys(frame, [...keys, 'bytes']) &&
          session.started &&
          session.request.operation === 'exec' &&
          Number.isSafeInteger(frame.bytes) &&
          Number(frame.bytes) >= 1 &&
          Number(frame.bytes) <= 65536
        ) {
          if (
            !this.send(session.operator, {
              v: 1,
              type: 'live.stdin-ack',
              sessionId: session.id,
              bytes: frame.bytes,
            })
          )
            this.fail(session, 'operator buffer limit exceeded');
        } else if (
          frame.type === 'live.output' &&
          frameKeys(frame, [...keys, 'stream', 'data']) &&
          (frame.stream === 'stdout' || frame.stream === 'stderr') &&
          liveBase64(frame.data)
        ) {
          if (!this.send(session.operator, frame))
            this.fail(session, 'operator buffer limit exceeded');
        } else if (
          frame.type === 'live.result' &&
          frameKeys(frame, [...keys, 'result']) &&
          Object.hasOwn(frame, 'result') &&
          ['ps', 'inspect'].includes(session.request.operation)
        ) {
          if (
            !this.send(session.operator, {
              v: 1,
              type: 'live.result',
              sessionId: session.id,
              value: frame.result,
            })
          )
            this.fail(session, 'operator buffer limit exceeded');
        } else if (
          frame.type === 'live.exit' &&
          frameKeys(frame, [...keys, 'code', 'signal', 'cancelled', 'error']) &&
          (frame.code === null ||
            (Number.isInteger(frame.code) &&
              Number(frame.code) >= 0 &&
              Number(frame.code) <= 255)) &&
          (frame.signal === null || typeof frame.signal === 'string') &&
          typeof frame.cancelled === 'boolean' &&
          (frame.error === undefined || typeof frame.error === 'string')
        ) {
          if (frame.error) this.fail(session, frame.error as string);
          else
            this.finish(
              session,
              {
                v: 1,
                type: 'live.exit',
                sessionId: session.id,
                code: typeof frame.code === 'number' ? frame.code : frame.cancelled ? 130 : 1,
              },
              false,
            );
        } else throw new Error('unsupported agent frame');
      } catch {
        ws.close(1008, 'invalid live session frame');
      }
    });
  }
  operator(actor: Actor, ws: WebSocket): void {
    let opening = false;
    let session: LiveSession | undefined;
    const timer = setTimeout(() => {
      if (!session) reject('live.open timeout');
    }, this.startTimeoutMs);
    const reject = (message: string) => {
      clearTimeout(timer);
      if (session) this.fail(session, message);
      else {
        this.send(ws, { v: 1, type: 'live.error', message });
        ws.close(1008, message.slice(0, 100));
      }
    };
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(timer);
      if (session) this.finish(session);
    });
    ws.on('message', (data, binary) => {
      void (async () => {
        if (binary || Buffer.byteLength(data.toString()) > LIVE_MAX_FRAME_BYTES)
          throw new Error('invalid or oversized live frame');
        const frame: unknown = JSON.parse(data.toString());
        if (!objectFrame(frame) || frame.v !== 1) throw new Error('invalid live frame');
        if (!session) {
          if (opening || frame.type !== 'live.open' || !frameKeys(frame, ['v', 'type', 'request']))
            throw new Error('first frame must be live.open');
          opening = true;
          const request = parseLiveRequest(frame.request);
          const node = await this.resolve(actor, request);
          if (ws.readyState !== WebSocket.OPEN) return;
          const agent = this.agents.get(node.id);
          if (!agent || agent.readyState !== WebSocket.OPEN)
            throw new Error('agent is not connected');
          if (this.sessions.size >= LIVE_MAX_SESSIONS) throw new Error('too many live sessions');
          clearTimeout(timer);
          const sessionId = id('live');
          session = {
            id: sessionId,
            operator: ws,
            agent,
            node: node.name,
            request,
            started: false,
            timer: setTimeout(() => {
              if (session) this.fail(session, 'agent live startup timeout');
            }, this.startTimeoutMs),
          };
          this.sessions.set(sessionId, session);
          if (!this.send(agent, { v: 1, type: 'live.open', sessionId, request }))
            this.fail(session, 'agent buffer limit exceeded');
          return;
        }
        if (!this.sessions.has(session.id)) return;
        if (
          !frameKeys(frame, [
            'v',
            'type',
            ...(frame.type === 'live.stdin'
              ? ['data']
              : frame.type === 'live.ack'
                ? ['bytes']
                : frame.type === 'live.resize'
                  ? ['columns', 'rows']
                  : []),
          ])
        )
          throw new Error('invalid live input');
        if (frame.type === 'live.cancel') {
          this.finish(session, { v: 1, type: 'live.exit', sessionId: session.id, code: 130 });
          return;
        }
        if (frame.type === 'live.ack') {
          // Output credit the CLI consumed, relayed so the agent resumes reading the container.
          if (
            !['exec', 'logs'].includes(session.request.operation) ||
            !Number.isSafeInteger(frame.bytes) ||
            Number(frame.bytes) < 1 ||
            Number(frame.bytes) > LIVE_AGENT_MAX_BUFFERED_BYTES
          )
            throw new Error('invalid live acknowledgement');
          if (
            !this.send(session.agent, {
              v: 1,
              type: 'live.ack',
              sessionId: session.id,
              bytes: frame.bytes,
            })
          )
            this.fail(session, 'agent buffer limit exceeded');
          return;
        }
        if (session.request.operation !== 'exec')
          throw new Error('operation does not accept input');
        if (
          frame.type === 'live.stdin'
            ? !session.request.interactive || !liveBase64(frame.data)
            : frame.type === 'live.stdin-end'
              ? !session.request.interactive
              : frame.type === 'live.resize'
                ? !session.request.tty ||
                  !liveDimension(frame.columns) ||
                  !liveDimension(frame.rows)
                : true
        )
          throw new Error('invalid live input');
        if (
          !this.send(session.agent, { ...frame, sessionId: session.id } as LiveInput & {
            sessionId: string;
          })
        )
          this.fail(session, 'agent buffer limit exceeded');
      })().catch((error) => reject(errMessage(error)));
    });
  }
}

interface StreamRuntime {
  hub: WakeHub;
  identify(request: http.IncomingMessage): Identity | null;
  resolvePrincipal(uri: string, keyHash: string): Identity | null;
  live: LiveHub;
  watch: WatchHub;
  isRestoring(): boolean;
}

const streamRuntimes = new WeakMap<express.Express, StreamRuntime>();

declare module 'express-serve-static-core' {
  interface Request {
    node?: NodeRow;
  }
}

interface HttpError extends Error {
  status?: number;
  lock?: LockRow;
}
const httpError = (status: number, message: string): HttpError =>
  Object.assign(new Error(message), { status });
const missingProject = (project: string) => `project ${project} has no desired state`;
const missingService = (project: string, service: string) =>
  `service ${service} not found in project ${project}`;

/** Collapse a node report into the deployment error `tug deploy` prints. Compose failures are multi-line; keep the reason, not the progress log. */
function deploymentFailureMessage(rows: { node: string; status_json: string }[]): string {
  const limit = 500;
  const oneLine = (value: string) => {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
  };
  const details = rows.map((row) => {
    let status: { error?: unknown; serviceStates?: Record<string, { rolloutError?: unknown }> } =
      {};
    try {
      status = JSON.parse(row.status_json);
    } catch {
      /* a bad report still names the node */
    }
    const parts: string[] = [];
    if (typeof status.error === 'string' && status.error.trim()) parts.push(oneLine(status.error));
    for (const [service, state] of Object.entries(status.serviceStates || {})) {
      if (typeof state?.rolloutError === 'string' && state.rolloutError.trim())
        parts.push(`${service}: ${oneLine(state.rolloutError)}`);
    }
    const detail = parts.join('; ');
    return detail ? `${row.node}: ${detail}` : row.node;
  });
  return `one or more assigned nodes reported failed health: ${details.join('; ')}`;
}

/** Versions of rollback deployments start with this; `tug deploy` may not use it, which is how automatic rollback tells them apart. */
const ROLLBACK_VERSION_PREFIX = 'rollback-';
const ACTIVE_STATES_SQL = statesSql(ACTIVE_DEPLOYMENT_STATES);

const PORT = Number(process.env.PORT || 8443);

export interface ControlImageOperations {
  resolve: typeof resolveImage;
  build: typeof buildImage;
  save: typeof saveImageArchive;
  inspect: typeof inspectEngineImage;
  validate: typeof validateImageArchive;
  run: typeof runCommand;
}
export async function createApp(
  options: {
    images?: Partial<ControlImageOperations>;
    /** The Docker Engine control manages images and reports diagnostics through; defaults to the local socket. */
    docker?: DockerApi;
    openDatabase?: typeof openDb;
    /** Test hook: runs after each step of putting a restored backup in place and may throw to simulate a crash. */
    restoreAfterStep?: (step: ActivationStep) => void | Promise<void>;
    /** Minimum time between event prunes triggered by agent reports; default one hour. */ eventPruneIntervalMs?: number;
    /** Override the live open/agent startup timeout in milliseconds. */ liveStartTimeoutMs?: number;
    /** Credential-free HTTPS origin clients connect to by default; defaults to `TUG_CONTROL_URL`. */ controlUrl?: string;
    /**
     * Replaces certificate-based identity resolution. Only for in-process tests that skip TLS; production never sets it.
     * It returns the principal URI and key hash a connection would have presented.
     */
    identity?: (req: Request, db: Db) => { uri: string; keyHash: string } | null;
  } = {},
) {
  const images: ControlImageOperations = {
    resolve: resolveImage,
    build: buildImage,
    save: saveImageArchive,
    inspect: inspectEngineImage,
    validate: validateImageArchive,
    run: runCommand,
    ...options.images,
  };
  const docker: DockerApi = options.docker ?? new DockerEngine();
  const DATA_DIR = process.env.TUG_DATA_DIR || './data';
  const MAX_IMAGE_BYTES = Number(process.env.TUG_MAX_IMAGE_BYTES || 5 * 1024 ** 3);
  if (!Number.isSafeInteger(MAX_IMAGE_BYTES) || MAX_IMAGE_BYTES < 1)
    throw new Error('TUG_MAX_IMAGE_BYTES must be a positive safe integer');
  const upload = multer({
    dest: process.env.TUG_UPLOAD_DIR || path.join(DATA_DIR, 'uploads'),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 64, fields: 1, fieldSize: 1024 ** 2 },
  });
  const dbFile = path.join(DATA_DIR, 'tug.db');
  const masterKeyFile = path.join(DATA_DIR, 'master.key');
  const SERVICE_DNS = process.env.TUG_SERVICE_NAMES !== 'false';
  const ACME_EMAIL = process.env.TUG_ACME_EMAIL || undefined;
  const INGRESS_ACCESS_LOG = process.env.TUG_INGRESS_ACCESS_LOG === 'true';

  // The data directory is 0700 because it holds the master key and the CA key. As a host directory the installer set
  // that; the root of a Docker volume is created 0755, so control restricts it itself.
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(DATA_DIR, 0o700);

  // A restore that was interrupted between replacing the database, the master key and the CA is rolled back here,
  // before any of them is opened; a committed one is finished once the database is open.
  const activation = await recoverActivation(DATA_DIR);
  const db = await (options.openDatabase || openDb)(dbFile);
  if (activation) {
    const retired = retireAfterRestore(db);
    await finishActivation(DATA_DIR, activation);
    recordEvent(db, {
      actor: 'control',
      type: 'control.restore_activated',
      message: `control started from a restored backup: ${retired.commands} queued or running commands, ${retired.backupRuns} workload backup runs and ${retired.restores} workload restores from the backup were retired`,
      metadata: { ...retired },
    });
  }
  const wakeHub = new WakeHub(() => watch.mark('nodes'));

  // Events are an operator-facing log, not a record of truth, so keep them bounded. `0` turns a limit off; anything that is
  // not a whole number falls back to the default.
  const envCount = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0) return value;
    console.warn(`${name}=${JSON.stringify(raw)} is not a whole number; using ${fallback}`);
    return fallback;
  };
  const EVENT_RETENTION_DAYS = envCount('TUG_EVENT_RETENTION_DAYS', 30);
  const EVENT_MAX_ROWS = envCount('TUG_EVENT_MAX_ROWS', 100_000);
  const eventPruneIntervalMs = options.eventPruneIntervalMs ?? 60 * 60 * 1000;
  let lastEventPrune = Date.now();
  function pruneEvents(): number {
    lastEventPrune = Date.now();
    let removed = 0;
    if (EVENT_RETENTION_DAYS > 0)
      removed +=
        db.run(
          'DELETE FROM events WHERE created_at < ?',
          new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString(),
        ).changes ?? 0;
    if (EVENT_MAX_ROWS > 0)
      removed +=
        db.run(
          'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)',
          EVENT_MAX_ROWS,
        ).changes ?? 0;
    if (removed)
      console.log(
        `removed ${removed} old events (kept ${EVENT_RETENTION_DAYS || 'any'} days, at most ${EVENT_MAX_ROWS || 'unlimited'} rows)`,
      );
    return removed;
  }
  try {
    pruneEvents();
  } catch (e) {
    console.error(`event pruning failed: ${errMessage(e)}`);
  }
  const masterKey = await loadOrCreateMasterKey(masterKeyFile);
  // A CA is created only for a fresh installation; existing state with missing or mismatched CA material is a startup error.
  const pki = await Pki.load(
    path.join(DATA_DIR, 'pki'),
    !db.get('SELECT 1 FROM operator_credentials') && !db.get('SELECT 1 FROM nodes'),
  );
  const configuredControlUrl = options.controlUrl ?? process.env.TUG_CONTROL_URL;
  const controlUrl = () => {
    const url = configuredControlUrl;
    if (!url) throw httpError(500, 'TUG_CONTROL_URL is not set');
    return new URL(url).origin;
  };

  const app = express();
  app.locals.pki = pki;
  app.locals.controlUrl = configuredControlUrl;
  app.locals.dataDir = DATA_DIR;
  /** Resolves a presented certificate (principal URI and key hash) to a principal from current database state. */
  function resolvePrincipal(uri: string, keyHash: string): Identity | null {
    const parsed = parseIdentityUri(uri);
    if (!parsed) return null;
    if (parsed.klass === 'node') {
      const node = db.get<NodeRow>('SELECT * FROM nodes WHERE id=?', parsed.id);
      return node && node.key_hash === keyHash && !node.disabled_at
        ? { klass: 'node', node }
        : null;
    }
    if (parsed.klass === 'operator') {
      const actor = authenticate(db, parsed.id, keyHash);
      return actor ? { klass: 'operator', actor, credentialId: parsed.id } : null;
    }
    const row = db.get<EnrollmentCredentialRow>(
      'SELECT * FROM enrollment_credentials WHERE id=?',
      parsed.id,
    );
    return row && row.key_hash === keyHash && !row.revoked_at && row.expires_at > now()
      ? { klass: 'enroll', row }
      : null;
  }
  /** Live TLS connections by the identity they presented; closed when the principal's current state no longer authorizes them. */
  interface LiveSocket {
    socket: tls.TLSSocket;
    uri: string;
    keyHash: string;
    notAfter: number;
  }
  const liveSockets = new Set<LiveSocket>();
  app.locals.liveSockets = liveSockets;
  /** Closes connections whose principal is disabled, revoked, replaced, removed or expired. */
  const reconcileSockets = (): void => {
    for (const entry of [...liveSockets]) {
      if (entry.socket.destroyed) liveSockets.delete(entry);
      else if (entry.notAfter <= Date.now() || !resolvePrincipal(entry.uri, entry.keyHash)) {
        entry.socket.destroy();
        liveSockets.delete(entry);
      }
    }
  };
  const closeAllSockets = (): void => {
    for (const entry of liveSockets) entry.socket.destroy();
    liveSockets.clear();
  };
  app.locals.reconcileSockets = () => {
    if (!restartRequired) reconcileSockets();
  };
  /** The certificate a request or upgrade arrived with, as a (uri, keyHash) pair; null if none can be established. */
  const presented = (request: http.IncomingMessage) => {
    if (options.identity) return options.identity(request as Request, db);
    const socket = request.socket as tls.TLSSocket;
    if (typeof socket.getPeerCertificate !== 'function' || socket.isSessionReused()) return null;
    return peerIdentity(socket);
  };
  const identify = (request: http.IncomingMessage): Identity | null => {
    const cert = presented(request);
    return cert ? resolvePrincipal(cert.uri, cert.keyHash) : null;
  };
  let restartRequired = false;
  // Version skew, the VersionMiddleware bargain (Docker): every response names the control's version so a client can
  // check its own against it without a dedicated probe, and a client declaring itself newer than this control is
  // refused before a handler runs — the guard cannot exist in the client, whose version the control only learns here.
  // Requests without the header (agents or tools predating it) are legacy-permitted. Own version is read once: a
  // per-request stat of package.json would put a filesystem read on every request.
  const ownVersion = packageVersion();
  app.use((req, res, next) => {
    res.setHeader(VERSION_STAMP_HEADER, ownVersion);
    const clientVersion = String(req.headers[CLIENT_VERSION_HEADER] || '');
    const client = majorMinor(clientVersion);
    const ownPair = majorMinor(ownVersion);
    if (client && ownPair && compareCompat(client, ownPair) === 1)
      return void res.status(400).json({
        error: `this client (${clientVersion}) is newer than the control running ${ownVersion}: upgrade the control plane with: tug control upgrade <control host> --yes`,
        skew: SKEW_CLIENT_NEWER,
      });
    next();
  });
  app.use((_req, res, next) =>
    restartRequired
      ? res.status(503).json({ error: 'control restored; restart required', restartRequired: true })
      : next(),
  );
  // Route class gate: runs before body parsing and every handler. There is no unauthenticated route.
  app.use((req, res, next) => {
    const identity = identify(req);
    if (!identity) return void res.status(401).json({ error: 'unauthorized' });
    const enrollRoute = req.method === 'POST' && req.path === '/agent/v1/enroll';
    const allowed =
      identity.klass === 'enroll'
        ? enrollRoute
        : identity.klass === 'node'
          ? req.path.startsWith('/agent/v1/') && !enrollRoute
          : req.path.startsWith('/api/v1/');
    if (!allowed)
      return void res
        .status(403)
        .json({ error: `forbidden: ${identity.klass} credentials cannot use this route` });
    req.identity = identity;
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  // Anything that wrote something may have changed what a watcher cares about; tell them soon.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', () => watch.poke());
    next();
  });
  // Hold the writer for the operation lifetime, including after an HTTP disconnect.
  let writer = Promise.resolve();
  async function withWriter<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = writer;
    let release!: () => void;
    writer = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (restartRequired) throw httpError(503, 'control restored; restart required');
      return await operation();
    } finally {
      release();
    }
  }

  let publication = Promise.resolve();
  async function withPublication<T>(operation: () => T): Promise<T> {
    const previous = publication;
    let release!: () => void;
    publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  const safe =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) => {
      try {
        void Promise.resolve(handler(req, res, next)).catch(next);
      } catch (error) {
        next(error);
      }
    };
  const route = (method: 'get' | 'post' | 'delete', url: string, handlers: RequestHandler[]) =>
    app[method](url, ...handlers.map(safe));
  const get = (url: string, ...handlers: RequestHandler[]) => route('get', url, handlers);
  const post = (url: string, ...handlers: RequestHandler[]) => route('post', url, handlers);

  // Operator-facing routes go through api(): the role table in credentials.ts is the only place a route's access is declared.
  const guard = createGuard();
  const apiRoutes = new Map<string, RouteRole>();
  app.locals.apiRoutes = apiRoutes;
  const api = (
    method: 'get' | 'post' | 'delete',
    url: string,
    resolve: ProjectResolver | null,
    ...handlers: RequestHandler[]
  ) => {
    const key = `${method.toUpperCase()} ${url}`;
    const role = ROUTE_ROLES[key];
    if (!role || role === 'public')
      throw new Error(`API route ${key} has no declared role in ROUTE_ROLES`);
    apiRoutes.set(key, role);
    route(method, url, [guard(role, resolve ?? undefined), ...handlers]);
  };
  const deploymentProject: ProjectResolver = (req) =>
    db.get<{ project_id: string }>(
      'SELECT project_id FROM deployments WHERE id=?',
      String(req.params.id),
    )?.project_id;
  const commandProject: ProjectResolver = (req) => {
    const row = db.get<{ project_id: string | null }>(
      'SELECT project_id FROM commands WHERE id=?',
      String(req.params.id),
    );
    return row ? row.project_id : undefined;
  };
  /** Audit trail entry for a control action; bookkeeping failures are logged, never returned to the caller. */
  const audit = (actor: Actor, event: Omit<Parameters<typeof recordEvent>[1], 'actor'>) => {
    try {
      recordEvent(db, { ...event, actor: actor.name });
    } catch (e) {
      console.error(`audit event failed: ${errMessage(e)}`);
    }
  };
  const projectScope = (actor: Actor, column: string) =>
    actor.projects
      ? {
          where: `${column} IN (${actor.projects.map(() => '?').join(',') || "''"})`,
          args: actor.projects,
        }
      : { where: '1=1', args: [] as string[] };
  const authAgent = async (req: Request, res: Response, next: NextFunction) => {
    if (req.identity?.klass !== 'node')
      return res.status(403).json({ error: 'node credentials required' });
    req.node = req.identity.node;
    next();
  };
  const wakeAll = (project?: string): void => {
    for (const node of db.all<Pick<NodeRow, 'id'>>('SELECT id FROM nodes'))
      wakeHub.wake(node.id, project);
  };
  let endpointSnapshot = '';

  function updateDeploymentConvergence(projectId: string): void {
    const project = db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId);
    if (!project?.current_deployment_id) return;
    const ds = db.get<DesiredStateRow>(
      'SELECT * FROM desired_states WHERE deployment_id=?',
      project.current_deployment_id,
    );
    if (!ds) return;
    const state: DesiredState = JSON.parse(ds.state_json);
    const required = new Set<string>();
    for (const svc of Object.values(state.services || {}))
      for (const node of svc.placement?.nodes || []) required.add(node);
    if (!required.size) return;
    // Placement names nodes; reports are keyed by the immutable node ID, so join to the current name.
    const statuses = db.all<{
      node: string;
      observed_version: string;
      health: string;
      status_json: string;
    }>(
      'SELECT n.name AS node,s.observed_version,s.health,s.status_json FROM node_statuses s JOIN nodes n ON n.id=s.node_id WHERE s.project_id=?',
      projectId,
    );
    const byNode = new Map(statuses.map((s) => [s.node, s]));
    const reportsRevision = (node: string) =>
      state.revision
        ? JSON.parse(byNode.get(node)?.status_json || '{}').observedRevision === state.revision
        : byNode.get(node)?.observed_version === state.version;
    const failedNodes = [...required]
      .filter((node) => reportsRevision(node) && byNode.get(node)?.health === 'failed')
      .map((node) => byNode.get(node)!);
    if (failedNodes.length) {
      const marked = advance(
        db,
        deploymentLifecycle,
        project.current_deployment_id,
        'rolling_out',
        'failed',
        { error_message: deploymentFailureMessage(failedNodes), updated_at: now() },
      );
      if (marked) scheduleAutoRollback(projectId, project.current_deployment_id, state);
    }
    const ok = [...required].every(
      (node) =>
        (state.revision
          ? JSON.parse(byNode.get(node)?.status_json || '{}').observedRevision === state.revision
          : byNode.get(node)?.observed_version === state.version) &&
        ['serving', 'skipped'].includes(byNode.get(node)?.health ?? ''),
    );
    // For projects using managed ingress, wait until each enabled ingress node has applied
    // the current routing configuration. Container health alone does not prove a switch.
    const ingressServices = Object.entries(state.compose.services || {})
      .filter(([, service]) => service['x-tug']?.ingress)
      .map(([name]) => name);
    // A revision that removes its last route must wait for that removal too.
    const previous = db.get<{ state_json: string }>(
      `SELECT ds.state_json FROM desired_states ds JOIN deployments d ON d.id=ds.deployment_id
       WHERE d.project_id=? AND d.id<>? AND d.state='succeeded' ORDER BY d.created_at DESC LIMIT 1`,
      projectId,
      project.current_deployment_id,
    );
    const previouslyRouted = previous
      ? Object.values(
          (JSON.parse(previous.state_json) as DesiredState).compose.services || {},
        ).some((service) => service['x-tug']?.ingress)
      : false;
    const ingressNodes =
      ingressServices.length || previouslyRouted
        ? db.all<NodeRow>('SELECT * FROM nodes WHERE ingress=1 AND disabled_at IS NULL')
        : [];
    const staleBefore = new Date(
      Date.now() - Number(process.env.TUG_STALE_SECONDS || 60) * 1000,
    ).toISOString();
    const ingressReady =
      !ingressNodes.length ||
      ingressNodes.every((node) => {
        const work = ingressFor(node, currentDesiredStates());
        if (
          !ingressServices.every((service) =>
            work.routes.some(
              (route) =>
                route.project === projectId &&
                route.service === service &&
                // A host in maintenance is routed on purpose with no upstream, so it does not gate the rollout.
                (route.upstreams.length > 0 || route.maintenance === true),
            ),
          )
        )
          return false;
        if (!node.ingress_status_json) return false;
        try {
          const status = JSON.parse(node.ingress_status_json) as {
            state?: string;
            configHash?: string;
            reportedAt?: string;
          };
          return (
            status.state === 'serving' &&
            status.configHash === ingressConfigHash(work) &&
            typeof status.reportedAt === 'string' &&
            status.reportedAt >= staleBefore
          );
        } catch {
          return false;
        }
      });
    if (ok && ingressReady)
      advance(db, deploymentLifecycle, project.current_deployment_id, 'rolling_out', 'succeeded', {
        updated_at: now(),
      });
  }

  /** Events control writes when it rolls back on its own; they are attributed to a reserved system actor. */
  function recordAutoRollbackEvent(
    projectId: string,
    deploymentId: string | null,
    type: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    db.run(
      'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id('evt'),
      projectId,
      deploymentId,
      null,
      'warn',
      type,
      message,
      JSON.stringify(metadata),
      now(),
      AUTO_ROLLBACK_ACTOR,
    );
  }

  /**
   * Creates a rollback deployment that copies the most recent earlier deployment's desired state under a
   * new revision. Shared by `POST /api/v1/rollback` and automatic rollback; the caller holds the writer queue.
   * `auto` only considers `succeeded` deployments and requires `failedDeploymentId` to still be current.
   */
  /**
   * Ingress hostnames belong to the first project that publishes them: another project's current deployment
   * that already routes a host blocks any project from taking it, on deploy and on rollback alike.
   */
  /**
   * The managed Caddy listens on the loopback of every ingress node (its admin endpoint and the ask site), so a
   * service that publishes one of those host ports there would make every site's reload fail.
   */
  function assertNoReservedIngressPorts(compose: ComposeFile): void {
    const ingressNodes = db
      .all<{ name: string }>('SELECT name FROM nodes WHERE ingress=1')
      .map((n) => n.name);
    if (!ingressNodes.length) return;
    for (const [name, svc] of Object.entries(compose.services || {})) {
      const explicit = svc['x-tug']?.placement?.nodes;
      // Without a named node list the service may land on any node, including an ingress node.
      const nodes = explicit?.length
        ? ingressNodes.filter((n) => explicit.includes(n))
        : ingressNodes;
      if (!nodes.length) continue;
      for (const port of [ASK_PORT, CADDY_ADMIN_PORT])
        if (publishesHostPort(svc, port))
          throw httpError(
            400,
            `${name}: host port ${port} is reserved for the managed Caddy on ingress node ${nodes[0]}; publish another port`,
          );
    }
  }
  function hostnameConflict(
    host: string,
    project: string,
    owner: string,
    detail: string,
    viewer?: Actor,
  ): HttpError {
    const canSeeOwner =
      project === owner || (viewer && (!viewer.projects || viewer.projects.includes(owner)));
    return httpError(409, canSeeOwner ? detail : `${host} is already claimed by another project`);
  }

  function assertIngressHostsFree(project: string, compose: ComposeFile, viewer?: Actor): void {
    const wanted = ingressHostsOf(compose);
    if (!wanted.size) return;
    for (const domain of db.all<{ project_id: string; service: string; host: string }>(
      'SELECT project_id,service,host FROM project_domains',
    ))
      for (const [wantedHost, mine] of wanted)
        if (
          domain.project_id !== project
            ? ingressHostsOverlap(wantedHost, domain.host)
            : wantedHost === domain.host && mine !== domain.service
        )
          throw hostnameConflict(
            wantedHost,
            project,
            domain.project_id,
            `${mine}: ingress.host ${wantedHost} ${wantedHost === domain.host ? 'is' : `overlaps ${domain.host},`} already mapped as a domain of ${domain.project_id}/${domain.service}`,
            viewer,
          );
    for (const other of currentDesiredStates()) {
      if (other.project === project) continue;
      for (const [host, service] of ingressHostsOf(other.compose))
        for (const [wantedHost, mine] of wanted)
          if (ingressHostsOverlap(wantedHost, host))
            throw hostnameConflict(
              wantedHost,
              project,
              other.project,
              `${mine}: ingress.host ${wantedHost} ${wantedHost === host ? 'is' : `overlaps ${host},`} already routed by project ${other.project} (${service})`,
              viewer,
            );
    }
  }
  function createRollback(
    project: string,
    opts: {
      actor: string;
      viewer?: Actor;
      force?: boolean;
      auto?: boolean;
      failedDeploymentId?: string;
    },
  ): { deployment: ReturnType<typeof deploymentView<DeploymentRow>>; desiredState: DesiredState } {
    let lock;
    try {
      lock = acquireProjectLock(project, opts.auto ? 'auto-rollback' : 'rollback');
      const active = db.get<Pick<DeploymentRow, 'id' | 'state'>>(
        `SELECT id,state FROM deployments WHERE project_id=? AND state IN (${ACTIVE_STATES_SQL}) ORDER BY created_at DESC LIMIT 1`,
        project,
      );
      if (active && !opts.force)
        throw httpError(
          409,
          `deployment ${active.id} is already ${active.state}; retry with force to rollback anyway`,
        );
      const current = db.get('SELECT current_deployment_id FROM projects WHERE id=?', project);
      if (opts.failedDeploymentId && current?.current_deployment_id !== opts.failedDeploymentId)
        throw httpError(
          409,
          `deployment ${opts.failedDeploymentId} is no longer the current deployment`,
        );
      const states = opts.auto ? `'succeeded'` : `'succeeded','rolling_out'`;
      const previousDs = db.get<DesiredStateRow>(
        `SELECT ds.*, d.version AS deployment_version FROM desired_states ds JOIN deployments d ON d.id=ds.deployment_id
        WHERE ds.project_id=? AND ds.deployment_id != ? AND d.state IN (${states}) ORDER BY ds.created_at DESC LIMIT 1`,
        project,
        current?.current_deployment_id || '',
      );
      if (!previousDs) throw httpError(404, 'no previous deployment found');
      assertArtifactsAvailable(
        JSON.parse(previousDs.state_json),
        `roll back to ${previousDs.version}`,
      );
      const ts = now();
      const depId = id('dep');
      const previousState: DesiredState = JSON.parse(previousDs.state_json);
      assertIngressHostsFree(project, previousState.compose, opts.viewer);
      previousState.revision = depId;
      // A rollback restores the earlier configuration, variables included, so it carries that deployment's record.
      const restoredValues = db.get<{ values_json: string | null }>(
        'SELECT values_json FROM deployments WHERE id=?',
        previousDs.deployment_id,
      )?.values_json;
      db.run(
        'INSERT INTO deployments(id,project_id,version,state,created_at,updated_at,actor,values_json) VALUES(?,?,?,?,?,?,?,?)',
        depId,
        project,
        `${ROLLBACK_VERSION_PREFIX}${previousState.version}-${Date.now()}`,
        'rolling_out',
        ts,
        ts,
        opts.actor,
        restoredValues ?? null,
      );
      db.run(
        'INSERT INTO desired_states(id,project_id,deployment_id,version,state_json,created_at) VALUES(?,?,?,?,?,?)',
        id('ds'),
        project,
        depId,
        previousState.version,
        JSON.stringify(previousState),
        ts,
      );
      db.run(
        'UPDATE projects SET current_deployment_id=?,updated_at=? WHERE id=?',
        depId,
        now(),
        project,
      );
      wakeAll(project);
      return {
        deployment: deploymentView(
          db.get<DeploymentRow>('SELECT * FROM deployments WHERE id=?', depId),
        ),
        desiredState: previousState,
      };
    } finally {
      releaseLock(lock);
    }
  }

  /**
   * With `x-tug.rollback: auto`, a deployment that just turned `failed` is rolled back to the previous
   * `succeeded` one. Rollback deployments are never rolled back (their versions carry a reserved prefix
   * that `tug deploy` cannot use), so a bad rollback target cannot loop. Runs in the background so a
   * busy writer queue never blocks agent status reports; the outcome is recorded as an event either way.
   */
  function scheduleAutoRollback(
    projectId: string,
    deploymentId: string,
    state: DesiredState,
  ): void {
    if (state.compose['x-tug']?.rollback !== 'auto') return;
    void (async () => {
      const failed = db.get<DeploymentRow>('SELECT * FROM deployments WHERE id=?', deploymentId);
      if (failed?.version.startsWith(ROLLBACK_VERSION_PREFIX)) {
        recordAutoRollbackEvent(
          projectId,
          deploymentId,
          'deployment.auto_rollback_skipped',
          `rollback deployment ${failed.version} failed; not rolling back a rollback`,
        );
        return;
      }
      try {
        const out = await withWriter(() =>
          createRollback(projectId, {
            actor: AUTO_ROLLBACK_ACTOR,
            auto: true,
            failedDeploymentId: deploymentId,
          }),
        );
        recordAutoRollbackEvent(
          projectId,
          out.deployment!.id,
          'deployment.auto_rollback',
          `deployment ${deploymentId} (${failed?.version}) reported failed health; rolled back to ${out.desiredState.version} as deployment ${out.deployment!.id}`,
          {
            failedDeploymentId: deploymentId,
            rollbackDeploymentId: out.deployment!.id,
            version: out.desiredState.version,
          },
        );
      } catch (e) {
        try {
          recordAutoRollbackEvent(
            projectId,
            deploymentId,
            'deployment.auto_rollback_skipped',
            `deployment ${deploymentId} failed but automatic rollback was not possible: ${errMessage(e)}`,
          );
        } catch {
          /* Best-effort audit event. */
        }
      }
    })().catch((e) => console.error('auto rollback failed:', errMessage(e)));
  }

  function currentDesired(projectId: string): DesiredStateRow | undefined {
    return db.get<DesiredStateRow>(
      'SELECT ds.* FROM desired_states ds JOIN projects p ON p.current_deployment_id=ds.deployment_id WHERE p.id=?',
      projectId,
    );
  }

  const live = new LiveHub(
    async (actor, request) => {
      assertProject(actor, request.project);
      const row = currentDesired(request.project);
      if (!row) throw httpError(404, missingProject(request.project));
      const desired: DesiredState = JSON.parse(row.state_json);
      const nodes = db.all<NodeRow>('SELECT * FROM nodes');
      const eligible = new Set<string>();
      const services =
        request.operation === 'ps'
          ? Object.values(desired.services)
          : [desired.services[request.service]];
      if (services.some((service) => !service))
        throw httpError(
          404,
          missingService(request.project, 'service' in request ? request.service : ''),
        );
      for (const service of services)
        for (const node of nodes)
          if (!service.placement?.nodes?.length || service.placement.nodes.includes(node.name))
            eligible.add(node.name);
      if (request.node && !eligible.has(request.node))
        throw httpError(400, 'requested node is not placed for this operation');
      if (!request.node && eligible.size !== 1)
        throw httpError(400, 'operation requires --node because placement is ambiguous');
      const node = nodes.find((node) => node.name === (request.node || [...eligible][0]));
      if (!node) throw httpError(404, 'no eligible node for this operation');
      if (request.operation === 'exec' && request.oneOff)
        audit(actor, {
          type: 'job.run',
          project: request.project,
          message: `${actor.name} ran a one-off ${request.service} container on ${node.name}: ${request.command.join(' ').slice(0, 200)}`,
          metadata: {
            service: request.service,
            node: node.name,
            command: request.command.slice(0, 64),
          },
        });
      return node;
    },
    options.liveStartTimeoutMs,
    (nodeId, events) => ingestEvents(nodeId, events),
  );
  const watch = new WatchHub({
    db,
    version: ownVersion,
    nodes: () =>
      db
        .all<Pick<NodeRow, 'id' | 'name' | 'status' | 'disabled_at' | 'last_seen_at'>>(
          'SELECT id,name,status,disabled_at,last_seen_at FROM nodes ORDER BY name',
        )
        .map((row) => ({
          id: row.id,
          name: row.name,
          status: statusOf(row),
          connected: wakeHub.connected(row.id),
        })),
  });
  streamRuntimes.set(app, {
    hub: wakeHub,
    identify,
    resolvePrincipal,
    live,
    watch,
    isRestoring: () => restartRequired,
  });
  api('get', '/api/v1/live', null, (_req, res) => {
    res.status(426).json({ error: 'WebSocket upgrade required' });
  });
  api('get', '/api/v1/watch', null, (_req, res) => {
    res.status(426).json({ error: 'WebSocket upgrade required' });
  });

  const locks = lockQueries(db);

  function acquireProjectLock(
    project: string,
    operation: string,
    ttlMs = Number(process.env.TUG_LOCK_TTL_MS || 10 * 60 * 1000),
  ) {
    const name = `project:${project}`;
    const ts = now();
    locks.purgeExpired(ts);
    const owner = `${operation}:${id('lock')}`;
    try {
      locks.insert({
        name,
        owner,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
        created_at: ts,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = locks.find(name);
      const err: HttpError = new Error(
        `project ${project} is locked by ${existing?.owner} until ${existing?.expires_at}`,
      );
      err.status = 409;
      err.lock = existing;
      throw err;
    }
    const heartbeat = setInterval(
      () => {
        try {
          locks.renew(name, owner, new Date(Date.now() + ttlMs).toISOString());
        } catch {
          /* Best-effort bookkeeping. */
        }
      },
      Math.max(10, Math.floor(ttlMs / 3)),
    );
    heartbeat.unref();
    return { name, owner, heartbeat };
  }
  function releaseLock(
    lock:
      | { name: string; owner: string; heartbeat?: ReturnType<typeof setInterval> }
      | null
      | undefined,
  ): void {
    if (lock?.heartbeat) clearInterval(lock.heartbeat);
    if (lock)
      try {
        locks.release(lock.name, lock.owner);
      } catch {
        /* Best-effort bookkeeping. */
      }
  }
  function sendError(res: Response, e: unknown): void {
    const err = e as HttpError;
    res
      .status(restartRequired ? 503 : err.status || 500)
      .json({ error: err.message, lock: err.lock || undefined });
  }

  api('post', '/api/v1/scale', null, async (req, res) => {
    const project = req.body?.project;
    const service = req.body?.service;
    const replicas = Number(req.body?.replicas);
    if (!project || !service || !Number.isInteger(replicas) || replicas < 1)
      throw httpError(400, 'project, service and a positive integer replicas are required');
    assertProject(req.actor!, project);
    const dsRow = currentDesired(project);
    if (!dsRow) throw httpError(404, `project ${project} has no desired state`);
    const state: DesiredState = JSON.parse(dsRow.state_json);
    if (!state.services?.[service])
      throw httpError(404, `service ${service} not found in project ${project}`);
    const nodeRows = db.all<NodeRow>(
      'SELECT name,labels_json,last_seen_at FROM nodes WHERE disabled_at IS NULL ORDER BY created_at,name',
    );
    const nodeInfos = nodeRows
      .filter((row) => !isStale(row))
      .map((row) => ({
        name: row.name,
        labels: row.labels_json ? (JSON.parse(row.labels_json) as string[]) : [],
      }));
    const composeSvc = state.compose?.services?.[service] || {};
    const ext = composeSvc['x-tug'] || {};
    const placement = ext.placement || {};
    const global = ext.global === true;
    const labels = Array.isArray(placement.labels) ? placement.labels : [];
    const matched = nodeInfos.filter((node) =>
      labels.every((label) => node.labels.includes(label)),
    );
    // Explicit `placement.nodes` (without labels or global, which deploy resolves into nodes) bound the pool; scaling never re-homes a service off them.
    const pinned =
      !labels.length && !global && Array.isArray(placement.nodes)
        ? (placement.nodes as string[])
        : [];
    const candidates = pinned.length
      ? matched.filter((node) => pinned.includes(node.name))
      : matched;
    const pool = candidates;
    if (!pool.length)
      throw httpError(
        400,
        labels.length || pinned.length
          ? 'no healthy nodes match the service placement'
          : 'no nodes available for scaling',
      );
    const selected = global ? pool : pool.slice(0, Math.min(replicas, pool.length));
    state.services[service].placement = {
      ...(state.services[service].placement || {}),
      nodes: selected.map((node) => node.name),
    };
    state.services[service].replicas = selected.length;
    state.revision = id('rev');
    db.run('UPDATE desired_states SET state_json=? WHERE id=?', JSON.stringify(state), dsRow.id);
    wakeAll(project);
    res.json({
      ok: true,
      project,
      service,
      replicas: selected.length,
      nodes: selected.map((node) => node.name),
    });
  });

  api(
    'post',
    '/api/v1/projects',
    (req) => String(req.body?.name || 'site'),
    async (req, res) => {
      const name = req.body.name || 'site';
      const ts = now();
      db.run(
        'INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)',
        name,
        name,
        ts,
        ts,
      );
      res.json(db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', name));
    },
  );
  api(
    'get',
    '/api/v1/projects/:project',
    (req) => String(req.params.project),
    async (req, res) =>
      res.json(db.get('SELECT * FROM projects WHERE id=?', String(req.params.project))),
  );

  /** A node whose agent has been seen before but not within TUG_STALE_SECONDS; never-seen (just registered) nodes stay schedulable. */
  const isStale = (row: { last_seen_at: string | null }) =>
    !!row.last_seen_at &&
    Date.parse(row.last_seen_at) < Date.now() - Number(process.env.TUG_STALE_SECONDS || 60) * 1000;
  /** The status a client sees: staleness is derived from `last_seen_at` on every read, never stored. */
  const statusOf = (row: Pick<NodeRow, 'status' | 'disabled_at' | 'last_seen_at'>) =>
    nodeStatus(row, Date.now(), Number(process.env.TUG_STALE_SECONDS || 60));
  const NODE_INFO_SQL =
    'SELECT id,name,address,labels_json,status,disabled_at,last_seen_at,created_at,updated_at FROM nodes WHERE id=?';

  const NODE_RENEW_MIN_INTERVAL_MS = () =>
    Number(process.env.TUG_RENEW_MIN_INTERVAL_MS ?? 60 * 60 * 1000);
  const nodeInfo = (nodeId: string): NodeInfo => {
    const row = db.get<NodeRow>(NODE_INFO_SQL, nodeId);
    if (!row) throw httpError(500, 'node not found');
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      labels: row.labels_json ? (JSON.parse(row.labels_json) as string[]) : [],
      status: statusOf(row),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  };
  const NODE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
  /** Inserts a node bound to a key. Synchronous so the existence check and the write cannot interleave. */
  function insertNode(input: {
    /** The immutable ID the node's certificates already name. */
    id: string;
    name: string;
    keyHash: string;
    notAfter: Date;
    address?: string;
    labels?: string[];
  }): void {
    if (!NODE_NAME.test(input.name))
      throw httpError(400, 'node name must be 1-63 letters, numbers, dots, underscores or hyphens');
    if (input.address && !isNodeHost(input.address))
      throw httpError(400, 'address must be an IP address or hostname without a port');
    const ts = now();
    db.run(
      `INSERT INTO nodes(id,name,address,status,labels_json,key_hash,cert_not_after,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.name,
      input.address || null,
      'registered',
      JSON.stringify(Array.isArray(input.labels) ? input.labels : []),
      input.keyHash,
      input.notAfter.toISOString(),
      ts,
      ts,
    );
    wakeAll();
  }
  const identityResponse = (nodeId: string, cert: string): IdentityResponse => ({
    node: nodeInfo(nodeId),
    certificate: cert,
    ca: pki.caPem,
    url: controlUrl(),
  });
  // The node generates its key and CSR; an admin posts the CSR here. The private key is never transmitted.
  api('post', '/api/v1/nodes/:name/identity', null, async (req, res) => {
    const body: Partial<IdentityRequest> = req.body ?? {};
    const name = String(req.params.name);
    if (body.mode !== 'create' && body.mode !== 'replace')
      return res.status(400).json({ error: "mode must be 'create' or 'replace'" });
    try {
      // The certificate names the immutable node ID: the existing node's, or a fresh one for a new name. A name freed by
      // `tug node remove` therefore never inherits the old ID, and certificates for the removed node cannot match the new one.
      let nodeId = db.get<NodeRow>('SELECT * FROM nodes WHERE name=?', name)?.id ?? id('node');
      let signed = await pki.signClientCsr(body.csr, identityUri('node', nodeId), NODE_LIFETIME_MS);
      // Signing is asynchronous: re-read, and re-sign once if a concurrent request created the node meanwhile.
      const current = db.get<NodeRow>('SELECT * FROM nodes WHERE name=?', name);
      if (current && current.id !== nodeId) {
        nodeId = current.id;
        signed = await pki.signClientCsr(body.csr, identityUri('node', nodeId), NODE_LIFETIME_MS);
      }
      const existing = db.get<NodeRow>('SELECT * FROM nodes WHERE name=?', name);
      if (existing && existing.id !== nodeId)
        throw httpError(409, `node ${name} was created concurrently; retry`);
      if (body.mode === 'create') {
        if (existing) {
          if (existing.key_hash !== signed.keyHash)
            return res.status(409).json({
              error: `node ${name} already exists; use tug node replace to install a new key`,
            });
        } else {
          insertNode({
            id: nodeId,
            name,
            keyHash: signed.keyHash,
            notAfter: signed.notAfter,
            address: body.address,
            labels: body.labels,
          });
        }
      } else {
        if (!existing) return res.status(404).json({ error: 'node not found' });
        if (body.address !== undefined && !isNodeHost(body.address))
          throw httpError(400, 'address must be an IP address or hostname without a port');
        const address = body.address === undefined ? existing.address : body.address;
        db.run(
          "UPDATE nodes SET key_hash=?,disabled_at=NULL,status='registered',cert_not_after=?,address=?,updated_at=? WHERE id=?",
          signed.keyHash,
          signed.notAfter.toISOString(),
          address || null,
          now(),
          existing.id,
        );
        audit(req.actor!, {
          type: 'node.replaced',
          message: `node ${name} key replaced by ${req.actor!.name}`,
          metadata: { node: name },
        });
        reconcileSockets();
        endpointSnapshot = JSON.stringify(endpointsFor(currentDesiredStates()));
        wakeAll();
      }
      res.json(identityResponse(nodeId, signed.cert));
    } catch (e) {
      sendError(res, e);
    }
  });

  // Self-enrollment: an admin mints a short-lived, single-use, name-bound bootstrap certificate that reaches one route.
  api('post', '/api/v1/nodes/enrollment-credential', null, async (req, res) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || !NODE_NAME.test(name))
      return res
        .status(400)
        .json({ error: 'name required: a valid node name to bind the join key to' });
    const labels = req.body.labels;
    if (
      labels !== undefined &&
      (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string'))
    )
      return res.status(400).json({ error: 'labels must be a list of strings' });
    const ttlSeconds = Math.max(1, Number(req.body.ttlSeconds ?? ENROLL_DEFAULT_TTL_MS / 1000));
    const rowId = id('enr');
    const issued = await pki.issueClient(
      identityUri('enroll', rowId),
      ttlSeconds * 1000,
      controlUrl(),
    );
    const expiresAt = issued.notAfter.toISOString();
    db.run(
      'DELETE FROM enrollment_credentials WHERE expires_at < ?',
      new Date(Date.now() - 86_400_000).toISOString(),
    );
    // Minting again for a name revokes its previous unconsumed key.
    db.run(
      'UPDATE enrollment_credentials SET revoked_at=? WHERE name=? AND node_id IS NULL AND revoked_at IS NULL',
      now(),
      name,
    );
    db.run(
      'INSERT INTO enrollment_credentials(id,key_hash,name,labels_json,expires_at,reserved_node_id,created_at) VALUES(?,?,?,?,?,?,?)',
      rowId,
      issued.keyHash,
      name,
      JSON.stringify(labels ?? []),
      expiresAt,
      id('node'),
      now(),
    );
    reconcileSockets();
    const out: EnrollmentCredentialResponse = {
      credential: issued.credential,
      name,
      labels: labels ?? [],
      expiresAt,
    };
    res.json(out);
  });
  post('/agent/v1/enroll', async (req, res) => {
    const row = req.identity?.klass === 'enroll' ? req.identity.row : null;
    if (!row) return res.status(403).json({ error: 'bootstrap credentials required' });
    const body: Partial<EnrollRequest> = req.body ?? {};
    try {
      const signed = await pki.signClientCsr(
        body.csr,
        identityUri('node', row.reserved_node_id),
        NODE_LIFETIME_MS,
      );
      // Re-read the row: the checks and writes below are synchronous, so concurrent enrollments cannot both create a node.
      const fresh = db.get<EnrollmentCredentialRow>(
        'SELECT * FROM enrollment_credentials WHERE id=?',
        row.id,
      );
      if (!fresh || fresh.revoked_at || fresh.expires_at <= now())
        return res.status(401).json({ error: 'join key is expired or revoked' });
      if (fresh.node_id) {
        if (fresh.node_key_hash !== signed.keyHash)
          return res.status(403).json({ error: 'join key was already used by a different key' });
      } else {
        if (db.get('SELECT 1 FROM nodes WHERE name=?', fresh.name))
          return res
            .status(409)
            .json({ error: `node ${fresh.name} already exists; a join key cannot replace a node` });
        insertNode({
          id: fresh.reserved_node_id,
          name: fresh.name,
          keyHash: signed.keyHash,
          notAfter: signed.notAfter,
          address: body.address,
          labels: fresh.labels_json ? (JSON.parse(fresh.labels_json) as string[]) : [],
        });
        db.run(
          'UPDATE enrollment_credentials SET node_id=?,node_key_hash=? WHERE id=?',
          fresh.reserved_node_id,
          signed.keyHash,
          fresh.id,
        );
        recordEvent(db, {
          actor: `enroll:${fresh.id}`,
          type: 'node.enrolled',
          message: `node ${fresh.name} enrolled`,
        });
      }
      const enrolled: EnrollResponse = identityResponse(fresh.reserved_node_id, signed.cert);
      res.json(enrolled);
    } catch (e) {
      sendError(res, e);
    }
  });
  // Same-key renewal: another certificate for the stored key. Nothing is stored beyond an informational expiry.
  post('/agent/v1/renew', authAgent, async (req, res) => {
    const node = req.node!;
    try {
      const signed = await pki.signClientCsr(
        req.body?.csr,
        identityUri('node', node.id),
        NODE_LIFETIME_MS,
      );
      if (signed.keyHash !== node.key_hash)
        return res.status(403).json({
          error: 'renewal requires a CSR for the node key; use tug node replace to change keys',
        });
      const last = node.last_renewed_at ? Date.parse(node.last_renewed_at) : 0;
      if (Date.now() - last < NODE_RENEW_MIN_INTERVAL_MS())
        return res.status(429).json({ error: 'certificate renewed too recently' });
      db.run(
        'UPDATE nodes SET cert_not_after=?,last_renewed_at=? WHERE id=?',
        signed.notAfter.toISOString(),
        now(),
        node.id,
      );
      const renewed: RenewResponse = { certificate: signed.cert };
      res.json(renewed);
    } catch (e) {
      sendError(res, e);
    }
  });
  // Blocks a node's key without deleting its metadata or changing placement. It returns only through `tug node replace`.
  api('post', '/api/v1/nodes/:name/disable', null, async (req, res) => {
    const node = findNode(String(req.params.name));
    if (!node) return res.status(404).json({ error: 'node not found' });
    db.run(
      "UPDATE nodes SET disabled_at=COALESCE(disabled_at,?),status='disabled',updated_at=? WHERE id=?",
      now(),
      now(),
      node.id,
    );
    audit(req.actor!, {
      type: 'node.disabled',
      message: `node ${node.name} disabled by ${req.actor!.name}`,
      metadata: { node: node.name },
    });
    reconcileSockets();
    // Other nodes drop the node from service endpoints and ingress configuration on their next work fetch.
    endpointSnapshot = JSON.stringify(endpointsFor(currentDesiredStates()));
    wakeAll();
    res.json({ ok: true, node: node.name });
  });
  api('get', '/api/v1/nodes', null, async (req, res) => {
    const rows = db.all<NodeRow>(
      'SELECT id,name,address,ingress,ingress_status_json,status,labels_json,last_seen_at,disabled_at,cert_not_after,created_at,updated_at FROM nodes ORDER BY name',
    );
    res.json({
      nodes: rows.map((row) => {
        const { labels_json, ...rest } = row;
        return {
          ...rest,
          status: statusOf(row),
          connected: wakeHub.connected(row.id),
          labels: labels_json ? (JSON.parse(labels_json) as string[]) : [],
        };
      }),
    });
  });
  function findNode(nameOrId: string) {
    return db.get<Pick<NodeRow, 'id' | 'name'>>(
      'SELECT id,name FROM nodes WHERE name=? OR id=?',
      nameOrId,
      nameOrId,
    );
  }
  function queueCommand(
    nodeId: string,
    projectId: string | null,
    type: CommandType,
    payload: Record<string, unknown> = {},
    deadline: string | null = null,
  ): string {
    const commandId = id('cmd');
    const ts = now();
    db.run(
      'INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      commandId,
      nodeId,
      projectId,
      type,
      'pending',
      JSON.stringify(payload),
      0,
      ts,
      deadline,
      ts,
      ts,
    );
    wakeHub.wake(nodeId, projectId ?? undefined);
    return commandId;
  }
  // Removes a retired node: its identity, statuses and queued commands. Refused while a current deployment still places
  // something on it (redeploy without it first) or while its agent is still reporting, unless force=true.
  api('delete', '/api/v1/nodes/:name', null, async (req, res) => {
    const node = db.get<Pick<NodeRow, 'id' | 'name' | 'last_seen_at'>>(
      'SELECT id,name,last_seen_at FROM nodes WHERE name=? OR id=?',
      String(req.params.name),
      String(req.params.name),
    );
    if (!node) return res.status(404).json({ error: 'node not found' });
    const referenced: string[] = [];
    for (const state of currentDesiredStates()) {
      for (const [name, svc] of Object.entries(state.services || {}))
        if (svc.placement?.nodes?.includes(node.name)) referenced.push(`${state.project}/${name}`);
      for (const [name, vol] of Object.entries(state.compose?.volumes || {}))
        if (vol?.['x-tug']?.placement?.nodes?.includes(node.name))
          referenced.push(`${state.project}/volume ${name}`);
    }
    if (referenced.length)
      return res.status(409).json({
        error: `node ${node.name} is still placed in current deployments: ${referenced.join(', ')}; deploy without it first`,
      });
    if (node.last_seen_at && !isStale(node) && String(req.query.force) !== 'true')
      return res.status(409).json({
        error: `node ${node.name} is still reporting; stop its agent first or pass force=true`,
      });
    db.run('DELETE FROM commands WHERE node_id=?', node.id);
    db.run('DELETE FROM node_statuses WHERE node_id=?', node.id);
    db.run('DELETE FROM nodes WHERE id=?', node.id);
    db.run(
      'UPDATE enrollment_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE name=? AND node_id IS NULL',
      now(),
      node.name,
    );
    reconcileSockets();
    audit(req.actor!, {
      type: 'node.removed',
      message: `node ${node.name} removed`,
      metadata: { node: node.name },
    });
    wakeAll();
    res.json({ ok: true, node: node.name });
  });
  api('post', '/api/v1/nodes/:name/address', null, async (req, res) => {
    const node = findNode(String(req.params.name));
    if (!node) return res.status(404).json({ error: 'node not found' });
    const { address } = req.body;
    if (!isNodeHost(address))
      return res
        .status(400)
        .json({ error: 'address must be an IP address or hostname without a port' });
    db.run('UPDATE nodes SET address=?,updated_at=? WHERE id=?', address, now(), node.id);
    audit(req.actor!, {
      type: 'node.address',
      message: `node ${node.name} address changed`,
      metadata: { node: node.name, address },
    });
    endpointSnapshot = JSON.stringify(endpointsFor(currentDesiredStates()));
    wakeAll();
    res.json({ ok: true, node: node.name, address });
  });
  api('post', '/api/v1/nodes/:name/ingress', null, async (req, res) => {
    const node = findNode(String(req.params.name));
    if (!node) return res.status(404).json({ error: 'node not found' });
    const enabled = req.body.enabled !== false;
    db.run(
      'UPDATE nodes SET ingress_status_json=CASE WHEN ingress<>? THEN NULL ELSE ingress_status_json END,ingress=?,updated_at=? WHERE id=?',
      enabled ? 1 : 0,
      enabled ? 1 : 0,
      now(),
      node.id,
    );
    wakeHub.wake(node.id);
    res.json({ ok: true, node: node.name, ingress: enabled });
  });
  api('post', '/api/v1/credentials', null, async (req, res) => {
    const request = parseCredentialRequest(req.body);
    const created = await createCredential(db, pki, controlUrl(), request, req.actor!.name);
    audit(req.actor!, {
      type: 'credential.create',
      message: `credential ${created.name} (${created.role}${created.projects ? `, projects: ${created.projects.join(', ')}` : ''}) created by ${req.actor!.name}`,
      metadata: {
        name: created.name,
        role: created.role,
        projects: created.projects,
        expiresAt: created.expiresAt,
      },
    });
    res.json({ ...created, credential: encodeCredential(created.credential) });
  });
  api('get', '/api/v1/credentials', null, async (_req, res) =>
    res.json({ credentials: listCredentials(db) }),
  );
  api('delete', '/api/v1/credentials/:name', null, async (req, res) => {
    if (!revokeCredential(db, String(req.params.name)))
      return res.status(404).json({ error: 'credential not found' });
    reconcileSockets();
    audit(req.actor!, {
      type: 'credential.revoke',
      message: `credential ${String(req.params.name)} revoked by ${req.actor!.name}`,
      metadata: { name: String(req.params.name) },
    });
    res.json({ ok: true, name: String(req.params.name) });
  });

  const destinationQueries = backupDestinationQueries(db);
  const backupDestination = () => destinationQueries.find();
  const backupEnv = (): Record<string, string> => {
    const row = backupDestination();
    if (!row) return {};
    const env: Record<string, string> = {};
    for (const name of JSON.parse(row.env_names_json) as string[]) {
      const secret = destinationQueries.secret(name);
      if (secret) env[name] = decrypt(secret, masterKey);
    }
    return env;
  };
  const backups = createBackupService({
    db,
    queueCommand,
    resticImage: process.env.TUG_RESTIC_IMAGE,
    // Defensive: the agent already redacts, but a stored error must never carry a destination credential.
    redact: (text) => redactSecrets(text, Object.values(backupEnv())),
  });
  app.locals.backups = backups;
  const restores = createRestoreService({ db, backups, wake: (project) => wakeAll(project) });
  app.locals.restores = restores;
  const backupTickMs = Number(process.env.TUG_BACKUP_TICK_MS) || 30_000;
  /** Assigned with the control backup code below; control's own nightly backup into the destination. */
  let controlDestinationTick: () => void = () => {};
  const backupTimer: NodeJS.Timeout = setInterval(() => {
    // A restore closes the database for good (control restarts to use the restored one): nothing left to schedule.
    if (restartRequired) return void clearInterval(backupTimer);
    try {
      backups.tick();
      controlDestinationTick();
      restores.advance();
    } catch (e) {
      console.error(`backup scheduler failed: ${errMessage(e)}`);
    }
  }, backupTickMs);
  backupTimer.unref();
  /** Stops the scheduler; called when the server closes, so a closed control never ticks against a closed database. */
  app.locals.stopBackupScheduler = () => clearInterval(backupTimer);
  const listenOnApp = app.listen.bind(app) as (...args: unknown[]) => import('node:http').Server;
  app.listen = ((...args: unknown[]) => {
    const server = listenOnApp(...args);
    server.once('close', () => clearInterval(backupTimer));
    return server;
  }) as typeof app.listen;
  try {
    backups.tick(); // catch up on slots missed while control was down
    restores.advance(); // re-adopt unfinished restores and keep their projects locked
  } catch (e) {
    console.error(`backup scheduler failed: ${errMessage(e)}`);
  }
  api('post', '/api/v1/backups/run', bodyProject, async (req, res) => {
    const project = String(req.body.project || 'site');
    const targets = req.body.targets;
    if (
      targets !== undefined &&
      (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string'))
    )
      return res.status(400).json({ error: 'targets must be a list of service or volume names' });
    if (!db.get('SELECT 1 FROM projects WHERE id=?', project))
      return res.status(404).json({ error: `project ${project} not found` });
    const result = backups.runNow(project, targets, req.actor!.name);
    if (!result.runs.length)
      return res.status(result.errors.length ? 409 : 404).json({
        error: result.errors.join('; ') || `project ${project} has no backup targets`,
      });
    res.json(result);
  });
  api('post', '/api/v1/restores', bodyProject, async (req, res) => {
    const body = req.body ?? {};
    const project = String(body.project || 'site');
    if (typeof body.target !== 'string' || !body.target)
      return res
        .status(400)
        .json({ error: 'target is required, such as service:db or volume:uploads' });
    const target = body.target.includes(':')
      ? body.target
      : (db.get<{ target: string }>(
          'SELECT target FROM backup_schedules WHERE project_id=? AND enabled=1 AND target LIKE ?',
          project,
          `%:${body.target}`,
        )?.target ?? body.target);
    const request = {
      project,
      target,
      from: typeof body.from === 'string' ? body.from : undefined,
      scratch: body.scratch === true,
      safetyBackup: body.safetyBackup !== false,
      writers: Array.isArray(body.writers) ? body.writers.map(String) : undefined,
      noWriters: body.noWriters === true,
      actor: req.actor!.name,
    };
    const plan = restores.plan(request);
    if ('error' in plan) return res.status(plan.status).json({ error: plan.error });
    if (body.confirm !== true) return res.json({ confirmed: false, plan });
    const started = restores.start(request, plan);
    if ('error' in started) return res.status(started.status).json({ error: started.error });
    res.json({ confirmed: true, plan, ...started });
  });
  api('get', '/api/v1/restores', queryProject, async (req, res) =>
    res.json({
      restores: restores.list(
        String(req.query.project || 'site'),
        20,
        req.query.state === 'interrupted',
      ),
    }),
  );
  api('post', '/api/v1/restores/:id/release', null, async (req, res) => {
    const result = restores.releaseInterrupted(String(req.params.id));
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json(result);
  });
  api('post', '/api/v1/restores/:id/cancel', null, async (req, res) => {
    const result = restores.cancel(String(req.params.id));
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json(result);
  });
  api('post', '/api/v1/backups/:id/cancel', bodyProject, async (req, res) => {
    const result = backups.cancelRun(String(req.body.project || 'site'), String(req.params.id));
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json(result);
  });
  api('post', '/api/v1/restores/:id/resume', null, async (req, res) => {
    const result = restores.resume(String(req.params.id));
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json(result);
  });
  api('get', '/api/v1/backups', queryProject, async (req, res) => {
    backups.sync();
    const project = String(req.query.project || 'site');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json({
      project,
      destinationConfigured: Boolean(backupDestination()),
      // Failure text names the bucket, so a credential limited to some projects does not get control-wide detail.
      control: req.actor!.projects === null ? controlDestinationStatus() : null,
      ...backups.list(project, limit),
    });
  });
  api('get', '/api/v1/backup/destination', null, async (_req, res) => {
    const row = backupDestination();
    res.json(
      row
        ? {
            configured: true,
            url: row.url,
            envNames: JSON.parse(row.env_names_json),
            checkedAt: row.checked_at,
            checkResult: row.check_result_json ? JSON.parse(row.check_result_json) : null,
            updatedAt: row.updated_at,
          }
        : { configured: false },
    );
  });
  api('post', '/api/v1/backup/destination', null, async (req, res) => {
    let parsed;
    try {
      parsed = parseBackupDestination(req.body);
    } catch (e) {
      return res.status(400).json({ error: errMessage(e) });
    }
    const ts = now();
    destinationQueries.replace(
      parsed.url,
      Object.entries(parsed.env).map(([name, value]) => ({
        id: id('sec'),
        name,
        encryptedValue: encrypt(value, masterKey),
      })),
      ts,
    );
    audit(req.actor!, {
      type: 'backup.destination_set',
      message: `backup destination set to ${parsed.url} by ${req.actor!.name}`,
      metadata: { url: parsed.url, envNames: Object.keys(parsed.env).sort() },
    });
    res.json({ ok: true, url: parsed.url, envNames: Object.keys(parsed.env).sort() });
  });
  api('delete', '/api/v1/backup/destination', null, async (req, res) => {
    const removed = destinationQueries.remove();
    if (removed)
      audit(req.actor!, {
        type: 'backup.destination_removed',
        message: `backup destination removed by ${req.actor!.name}`,
      });
    res.json({ ok: true, removed });
  });
  api('get', '/api/v1/backup/repository-password', null, async (req, res) => {
    if (req.query.control !== undefined) {
      const destination = backupDestination();
      audit(req.actor!, {
        type: 'backup.key_read',
        message: `control repository password read by ${req.actor!.name}`,
      });
      return res.json({
        control: true,
        repository: destination ? controlRepository(destination.url) : null,
        password: controlRepositoryPassword(masterKey),
      });
    }
    const project = String(req.query.project || '');
    if (!PROJECT_NAME_PATTERN.test(project) || isReservedProject(project))
      return res.status(400).json({ error: 'project is required' });
    if (!db.get('SELECT 1 FROM projects WHERE id=?', project))
      return res.status(404).json({ error: `project ${project} not found` });
    const destination = backupDestination();
    audit(req.actor!, {
      type: 'backup.key_read',
      project,
      message: `repository password for ${project} read by ${req.actor!.name}`,
    });
    res.json({
      project,
      repository: destination ? projectRepository(destination.url, project) : null,
      password: repositoryPassword(masterKey, project),
    });
  });

  api('post', '/api/v1/secrets', bodyProject, async (req, res) => {
    const { project = 'site', name, value } = req.body;
    if (isReservedProject(String(project)))
      return res.status(400).json({ error: `project names starting with _ are reserved` });
    if (!name || value == null) return res.status(400).json({ error: 'name and value required' });
    let lock;
    try {
      lock = acquireProjectLock(project, 'secret.set');
      if (db.get('SELECT 1 FROM project_vars WHERE project_id=? AND name=?', project, name))
        throw httpError(
          409,
          `${name} is a variable in project ${project}: a name is either a secret or a variable. Remove the variable first with tug var remove ${name}`,
        );
      const old = db.get<Pick<SecretRow, 'version'>>(
        'SELECT version FROM secrets WHERE project_id=? AND name=?',
        project,
        name,
      );
      const ts = now();
      db.run(
        `INSERT INTO secrets(id,project_id,name,encrypted_value,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(project_id,name) DO UPDATE SET encrypted_value=excluded.encrypted_value,version=excluded.version,updated_at=excluded.updated_at`,
        id('sec'),
        project,
        name,
        encrypt(value, masterKey),
        (old?.version || 0) + 1,
        ts,
        ts,
      );
      wakeAll(project);
      audit(req.actor!, {
        type: 'secret.set',
        project,
        message: `secret ${name} set to version ${(old?.version || 0) + 1} by ${req.actor!.name}`,
        metadata: { name, version: (old?.version || 0) + 1 },
      });
      res.json({ ok: true, name, version: (old?.version || 0) + 1 });
    } catch (e) {
      sendError(res, e);
    } finally {
      releaseLock(lock);
    }
  });
  api('get', '/api/v1/secrets', queryProject, async (req, res) =>
    isReservedProject(String(req.query.project || 'site'))
      ? res.status(400).json({ error: 'project names starting with _ are reserved' })
      : res.json({
          secrets: db.all(
            'SELECT project_id,name,version,updated_at FROM secrets WHERE project_id=? ORDER BY name',
            String(req.query.project || 'site'),
          ),
        }),
  );
  /**
   * Variables are visible deployment values (image tags, hostnames, ports): the CLI interpolates them when it
   * prepares a deployment, so unlike a secret their value is readable with the `deploy` role. A name is either a
   * secret or a variable in a project, because `${NAME}` resolves from one set of names.
   */
  api('post', '/api/v1/vars', bodyProject, async (req, res) => {
    const { project = 'site', name, value } = req.body;
    if (isReservedProject(String(project)))
      return res.status(400).json({ error: `project names starting with _ are reserved` });
    if (typeof name !== 'string' || typeof value !== 'string')
      return res.status(400).json({ error: 'name and value (strings) required' });
    if (!VALUE_NAME.test(name))
      return res
        .status(400)
        .json({ error: `invalid variable name ${name}: ${VALUE_NAME_MESSAGE}` });
    if (RESERVED_VALUE_NAMES.includes(name))
      return res.status(400).json({ error: `${name} is reserved and cannot be a variable` });
    if (Buffer.byteLength(value) > MAX_VAR_BYTES)
      return res.status(400).json({
        error: `variable ${name} is larger than ${MAX_VAR_BYTES} bytes; store large or private values with tug secret set`,
      });
    let lock;
    try {
      lock = acquireProjectLock(project, 'var.set');
      if (db.get('SELECT 1 FROM secrets WHERE project_id=? AND name=?', project, name))
        throw httpError(
          409,
          `${name} is a secret in project ${project}: a name is either a secret or a variable. Remove the secret first with tug secret remove ${name}`,
        );
      const old = db.get<{ version: number }>(
        'SELECT version FROM project_vars WHERE project_id=? AND name=?',
        project,
        name,
      );
      const version = (old?.version || 0) + 1;
      const ts = now();
      db.run(
        `INSERT INTO project_vars(id,project_id,name,encrypted_value,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(project_id,name) DO UPDATE SET encrypted_value=excluded.encrypted_value,version=excluded.version,updated_at=excluded.updated_at`,
        id('var'),
        project,
        name,
        encrypt(value, masterKey),
        version,
        ts,
        ts,
      );
      audit(req.actor!, {
        type: 'var.set',
        project,
        message: `variable ${name} set to version ${version} by ${req.actor!.name}`,
        metadata: { name, version },
      });
      res.json({ ok: true, name, version });
    } catch (e) {
      sendError(res, e);
    } finally {
      releaseLock(lock);
    }
  });
  api('get', '/api/v1/vars', queryProject, async (req, res) =>
    isReservedProject(String(req.query.project || 'site'))
      ? res.status(400).json({ error: 'project names starting with _ are reserved' })
      : res.json({
          vars: db.all(
            'SELECT project_id,name,version,updated_at FROM project_vars WHERE project_id=? ORDER BY name',
            String(req.query.project || 'site'),
          ),
        }),
  );
  api('get', '/api/v1/vars/values', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    if (isReservedProject(project))
      return res.status(400).json({ error: 'project names starting with _ are reserved' });
    res.json({
      vars: db
        .all<{ name: string; version: number; encrypted_value: string; updated_at: string }>(
          'SELECT name,version,encrypted_value,updated_at FROM project_vars WHERE project_id=? ORDER BY name',
          project,
        )
        .map((row) => ({
          project_id: project,
          name: row.name,
          version: row.version,
          updated_at: row.updated_at,
          value: decrypt(row.encrypted_value, masterKey),
        })),
    });
  });
  api('delete', '/api/v1/vars/:name', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    if (isReservedProject(project))
      return res.status(400).json({ error: 'project names starting with _ are reserved' });
    const name = String(req.params.name);
    const removed = db.run('DELETE FROM project_vars WHERE project_id=? AND name=?', project, name);
    if (removed.changes)
      audit(req.actor!, {
        type: 'var.delete',
        project,
        message: `variable ${name} deleted by ${req.actor!.name}`,
        metadata: { name },
      });
    res.json({ ok: true });
  });
  api('get', '/api/v1/domains', queryProject, async (req, res) =>
    isReservedProject(String(req.query.project || 'site'))
      ? res.status(400).json({ error: 'project names starting with _ are reserved' })
      : res.json({
          domains: db.all(
            'SELECT project_id,service,host,created_at,created_by FROM project_domains WHERE project_id=? ORDER BY host',
            String(req.query.project || 'site'),
          ),
        }),
  );
  /**
   * Mapped domains are control state, not part of a deployment: a WordPress network adds sites at any time, and
   * each one is served on a service's ingress route from the next agent poll. They obey the same ownership rule as
   * declared hosts, so a name can belong to one project only.
   */
  api('post', '/api/v1/domains', bodyProject, async (req, res) => {
    const { project = 'site' } = req.body;
    const host = String(req.body.host ?? '')
      .trim()
      .toLowerCase();
    const service = String(req.body.service ?? '');
    if (isReservedProject(String(project)))
      return res.status(400).json({ error: 'project names starting with _ are reserved' });
    const problem = domainProblem(host);
    if (problem) return res.status(400).json({ error: problem });
    if (!service) return res.status(400).json({ error: 'service required' });
    let lock;
    try {
      lock = acquireProjectLock(project, 'domain.add');
      const state = currentDesiredStates().find((s) => s.project === project);
      if (!state)
        throw httpError(409, `project ${project} has no current deployment to attach a domain to`);
      const ingress = state.compose.services?.[service]?.['x-tug']?.ingress;
      if (!ingress)
        throw httpError(409, `service ${service} has no x-tug.ingress route to serve ${host} on`);
      for (const other of currentDesiredStates())
        for (const [declared, name] of ingressHostsOf(other.compose))
          if (other.project === project ? declared === host : ingressHostsOverlap(host, declared))
            throw hostnameConflict(
              host,
              project,
              other.project,
              `${host} ${declared === host ? 'is' : `overlaps ${declared},`} already the ingress.host of ${other.project}/${name}`,
              req.actor,
            );
      const existing = db.get<{ project_id: string; service: string }>(
        'SELECT project_id,service FROM project_domains WHERE host=?',
        host,
      );
      if (existing && existing.project_id === project && existing.service === service)
        return res.json({ ok: true, project, service, host, unchanged: true });
      for (const row of db.all<{ project_id: string; service: string; host: string }>(
        'SELECT project_id,service,host FROM project_domains WHERE host<>? AND project_id<>?',
        host,
        project,
      ))
        if (ingressHostsOverlap(host, row.host))
          throw hostnameConflict(
            host,
            project,
            row.project_id,
            `${host} overlaps ${row.host}, already mapped by project ${row.project_id}`,
            req.actor,
          );
      if (existing)
        throw hostnameConflict(
          host,
          project,
          existing.project_id,
          `${host} is already mapped to ${existing.project_id}/${existing.service}`,
          req.actor,
        );
      db.run(
        'INSERT INTO project_domains(id,project_id,service,host,created_at,created_by) VALUES(?,?,?,?,?,?)',
        id('dom'),
        project,
        service,
        host,
        now(),
        req.actor!.name,
      );
      wakeAll();
      audit(req.actor!, {
        type: 'domain.added',
        project,
        message: `domain ${host} mapped to ${service} by ${req.actor!.name}`,
        metadata: { host, service },
      });
      res.json({ ok: true, project, service, host });
    } catch (e) {
      sendError(res, e);
    } finally {
      releaseLock(lock);
    }
  });
  api('delete', '/api/v1/domains/:host', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    if (isReservedProject(project))
      return res.status(400).json({ error: 'project names starting with _ are reserved' });
    const host = String(req.params.host).toLowerCase();
    const removed = db.run(
      'DELETE FROM project_domains WHERE project_id=? AND host=?',
      project,
      host,
    );
    if (!removed.changes)
      return res.status(404).json({ error: `domain ${host} is not mapped in project ${project}` });
    wakeAll();
    audit(req.actor!, {
      type: 'domain.removed',
      project,
      message: `domain ${host} removed by ${req.actor!.name}`,
      metadata: { host },
    });
    res.json({ ok: true, host });
  });
  api('delete', '/api/v1/secrets/:name', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    if (isReservedProject(project))
      return res.status(400).json({ error: 'project names starting with _ are reserved' });
    const removed = db.run(
      'DELETE FROM secrets WHERE project_id=? AND name=?',
      project,
      String(req.params.name),
    );
    if (removed.changes) {
      wakeAll(project);
      audit(req.actor!, {
        type: 'secret.delete',
        project,
        message: `secret ${String(req.params.name)} deleted by ${req.actor!.name}`,
        metadata: { name: String(req.params.name) },
      });
    }
    res.json({ ok: true });
  });

  interface BuildRow {
    id: string;
    project_id: string;
    deployment_id: string;
    service: string;
    image_ref: string;
    image_id: string;
    platform: string;
    sha256: string;
    size_bytes: number;
    artifact_path: string | null;
    state: string;
  }
  const artifactDir = path.join(DATA_DIR, 'images');
  await ensureDir(artifactDir);
  function retainedStates(): DesiredState[] {
    // All published history is retained. This conservative superset protects failed/lagging versions too.
    return db
      .all<DesiredStateRow>('SELECT * FROM desired_states')
      .map((row) => JSON.parse(row.state_json));
  }
  async function collectArtifacts(): Promise<void> {
    const states = retainedStates();
    const refs = new Set(
      states.flatMap((state) =>
        Object.values(state.services).flatMap((service) =>
          service.artifact ? [service.artifact.buildId] : [],
        ),
      ),
    );
    const imageRefs = new Set(
      states.flatMap((state) => Object.values(state.services).map((service) => service.image)),
    );
    const rows = db.all<BuildRow>('SELECT * FROM builds');
    for (const row of rows) {
      if (refs.has(row.id) || imageRefs.has(row.image_ref)) continue;
      const active = db.get(
        "SELECT 1 FROM deployments WHERE id=? AND state='building'",
        row.deployment_id,
      );
      if (active) continue;
      await fs.rm(
        path.join(DATA_DIR, row.artifact_path || path.join('images', `${row.id}.tar.gz`)),
        { force: true },
      );
      await docker.removeImage(row.image_ref).catch(() => {});
      db.run('DELETE FROM builds WHERE id=?', row.id);
    }
    const remaining = db.all<{ id: string }>('SELECT id FROM builds');
    const owned = new Set(remaining.flatMap((row) => [`${row.id}.tar.gz`, `${row.id}.tar.gz.tmp`]));
    for (const name of await fs.readdir(artifactDir))
      if (!owned.has(name)) await fs.rm(path.join(artifactDir, name), { force: true });
  }
  // Previous-process builds cannot finish after a restart; clear their unpublished files.
  advanceWhere(db, buildLifecycle, 'building', 'failed', {
    sql: 'deployment_id IN (SELECT id FROM deployments WHERE state=?)',
    params: ['building'],
  });
  advanceWhere(
    db,
    deploymentLifecycle,
    'building',
    'build_failed',
    { sql: '1=1' },
    {
      error_message: 'control restarted during build',
    },
  );
  /** Archives deleted by `image prune`, or missing from a backup taken without images, can no longer be deployed. */
  async function markMissingArtifacts(): Promise<void> {
    for (const row of db.all<BuildRow>(
      "SELECT * FROM builds WHERE state='complete' AND artifact_path IS NOT NULL",
    ))
      if (!(await fs.stat(path.join(DATA_DIR, row.artifact_path!)).catch(() => null)))
        advance(db, buildLifecycle, row.id, 'complete', 'pruned', {
          artifact_path: null,
          updated_at: now(),
        });
  }
  /** Throws a 409 when a desired state needs a build archive that was pruned. */
  function assertArtifactsAvailable(state: DesiredState, action: string): void {
    for (const [name, service] of Object.entries(state.services)) {
      if (!service.artifact) continue;
      const build = db.get<BuildRow>('SELECT * FROM builds WHERE id=?', service.artifact.buildId);
      if (build?.state === 'pruned')
        throw httpError(
          409,
          `cannot ${action}: the build archive of ${name} was pruned (tug image prune); deploy it again instead`,
        );
    }
  }
  /**
   * Deletes build archives no longer needed: everything except the newest `keep` distinct builds of each project,
   * the current deployment and any version a node still reports. The desired states stay, so history lists them,
   * but rolling back to a pruned one is refused.
   */
  async function pruneArtifacts(
    keep: number,
    dryRun: boolean,
  ): Promise<{ pruned: { id: string; service: string; sizeBytes: number }[]; freedBytes: number }> {
    const kept = new Set<string>();
    const reported = db
      .all<{ project_id: string; status_json: string }>(
        'SELECT project_id,status_json FROM node_statuses',
      )
      .map((row) => ({
        project: row.project_id,
        ...(JSON.parse(row.status_json) as { observedVersion?: string; observedRevision?: string }),
      }));
    const current = new Set(
      db
        .all<{ current_deployment_id: string | null }>('SELECT current_deployment_id FROM projects')
        .map((row) => row.current_deployment_id),
    );
    const rows = db.all<DesiredStateRow>('SELECT * FROM desired_states ORDER BY created_at DESC');
    // Deployments that reuse an archive share it, so `keep` counts distinct sets of archives, newest first:
    // redeploying an unchanged image must not push the last different build out of reach of rollback.
    const ranks = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const state: DesiredState = JSON.parse(row.state_json);
      const projectRanks = ranks.get(row.project_id) ?? new Map<string, number>();
      ranks.set(row.project_id, projectRanks);
      const set = Object.values(state.services)
        .flatMap((service) => (service.artifact ? [service.artifact.buildId] : []))
        .sort()
        .join(',');
      if (!projectRanks.has(set)) projectRanks.set(set, projectRanks.size);
      const index = projectRanks.get(set)!;
      const lagging = reported.some(
        (r) =>
          r.project === row.project_id &&
          r.observedVersion === state.version &&
          (!r.observedRevision || r.observedRevision === state.revision),
      );
      if (index >= keep && !lagging && !current.has(row.deployment_id)) continue;
      for (const service of Object.values(state.services))
        if (service.artifact) kept.add(service.artifact.buildId);
    }
    const pruned: { id: string; service: string; sizeBytes: number }[] = [];
    for (const build of db.all<BuildRow>(
      "SELECT * FROM builds WHERE state='complete' AND artifact_path IS NOT NULL",
    )) {
      if (kept.has(build.id)) continue;
      pruned.push({ id: build.id, service: build.service, sizeBytes: build.size_bytes });
      if (dryRun) continue;
      await fs.rm(path.join(DATA_DIR, build.artifact_path!), { force: true });
      advance(db, buildLifecycle, build.id, 'complete', 'pruned', {
        artifact_path: null,
        updated_at: now(),
      });
      const shared = db.get(
        "SELECT 1 FROM builds WHERE image_ref=? AND state='complete'",
        build.image_ref,
      );
      if (!shared) await docker.removeImage(build.image_ref).catch(() => {});
    }
    return { pruned, freedBytes: pruned.reduce((sum, build) => sum + build.sizeBytes, 0) };
  }
  const IMAGE_KEEP = envCount('TUG_IMAGE_KEEP', 5);
  const BUILD_CACHE_KEEP = process.env.TUG_BUILD_CACHE_KEEP?.trim() || '10GB';
  if (!/^(0|\d+(\.\d+)?\s?[kmgt]b)$/i.test(BUILD_CACHE_KEEP))
    throw new Error(
      'TUG_BUILD_CACHE_KEEP must be a size with a unit such as 10GB, or 0 to turn it off',
    );
  const CAP_BUILD_CACHE = Number.parseFloat(BUILD_CACHE_KEEP) > 0;
  /**
   * Bounds growth after each successful deploy that built images: archives beyond the newest `TUG_IMAGE_KEEP` distinct
   * builds per project (the rules of `tug image prune`, run behind the writer so it cannot delete an archive a running
   * deploy is reusing) and the daemon's build cache above `TUG_BUILD_CACHE_KEEP` (outside the writer: it touches no
   * database state and can take a while). Failures are logged, never raised.
   */
  function scheduleImageMaintenance(): void {
    if (IMAGE_KEEP === 0 && !CAP_BUILD_CACHE) return;
    void (async () => {
      if (IMAGE_KEEP > 0) await withWriter(() => pruneArtifacts(IMAGE_KEEP, false));
      if (CAP_BUILD_CACHE)
        await images.run('docker', [
          'builder',
          'prune',
          '--all',
          '--force',
          '--keep-storage',
          BUILD_CACHE_KEEP.replace(/\s/g, ''),
        ]);
    })().catch((e) => console.error('image maintenance failed:', errMessage(e)));
  }
  await collectArtifacts();
  await markMissingArtifacts();
  const receiveDeployment = upload.any();
  api('post', '/api/v1/deployments', null, (req, res) => {
    receiveDeployment(req, res, (error) => {
      void withWriter(() => deployRequest(req, res, error))
        .then((built) => {
          if (built) scheduleImageMaintenance();
        })
        .catch(async (failure) => {
          const files = Array.isArray(req.files) ? req.files : [];
          await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
          sendError(res, failure);
        });
    });
  });
  /**
   * Where each referenced `${NAME}` value came from, as the CLI reported it, checked against the store: a variable
   * must still have the version the CLI interpolated (a change in between would deploy a value the operator never
   * saw), a `--var` cannot shadow a secret, and secret values never enter the record. Control fills versions and
   * variable values from its own rows.
   */
  function checkedDeploymentValues(project: string, raw: unknown): DeploymentValue[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw httpError(400, 'values must be an array');
    const out: DeploymentValue[] = [];
    const seen = new Set<string>();
    for (const item of raw as Partial<DeploymentValue>[]) {
      const name = item?.name;
      if (typeof name !== 'string' || !VALUE_NAME.test(name))
        throw httpError(400, `invalid value name ${String(name)}: ${VALUE_NAME_MESSAGE}`);
      if (seen.has(name)) throw httpError(400, `value ${name} is listed twice`);
      seen.add(name);
      const source = item.source as ValueSource;
      if (!VALUE_SOURCES.includes(source))
        throw httpError(400, `value ${name} has an unknown source ${String(item.source)}`);
      if (source === 'secret') {
        const row = db.get<{ version: number }>(
          'SELECT version FROM secrets WHERE project_id=? AND name=?',
          project,
          name,
        );
        if (!row)
          throw httpError(
            400,
            `secret ${name} not found in project ${project}; create it with tug secret set`,
          );
        out.push({ name, source, version: row.version });
      } else if (source === 'var') {
        const row = db.get<{ version: number; encrypted_value: string }>(
          'SELECT version,encrypted_value FROM project_vars WHERE project_id=? AND name=?',
          project,
          name,
        );
        if (!row)
          throw httpError(
            409,
            `variable ${name} is no longer set in project ${project}; set it with tug var set and deploy again`,
          );
        if (row.version !== item.version)
          throw httpError(
            409,
            `variable ${name} changed while the deployment was being prepared (version ${String(item.version)} is now ${row.version}); run tug deploy again`,
          );
        out.push({
          name,
          source,
          version: row.version,
          value: decrypt(row.encrypted_value, masterKey),
        });
      } else if (source === '--var') {
        if (typeof item.value !== 'string')
          throw httpError(400, `--var ${name} needs a string value`);
        if (Buffer.byteLength(item.value) > MAX_VAR_BYTES)
          throw httpError(400, `--var ${name} is larger than ${MAX_VAR_BYTES} bytes`);
        if (db.get('SELECT 1 FROM secrets WHERE project_id=? AND name=?', project, name))
          throw httpError(
            400,
            `--var ${name} conflicts with the project secret ${name}: a secret is never overridden from the command line`,
          );
        out.push({ name, source, value: item.value });
      } else out.push({ name, source });
    }
    return out;
  }
  /** A deployment row for API responses: the stored value record is returned parsed, as `values`. */
  function deploymentView<T extends { values_json?: string | null }>(
    row: T | undefined,
  ): (Omit<T, 'values_json'> & { values: DeploymentValue[] }) | undefined {
    if (!row) return undefined;
    const { values_json, ...rest } = row;
    let values: DeploymentValue[] = [];
    try {
      values = values_json ? (JSON.parse(values_json) as DeploymentValue[]) : [];
    } catch {
      /* A record this release did not write is shown as having none. */
    }
    return { ...rest, values };
  }
  /**
   * Services that keep data on a node and are placed on different nodes by `compose` than by the current
   * deployment. Deploying such a change starts the service empty on the new node: the data does not move.
   */
  function movedServices(project: string, compose: ComposeFile): string[] {
    const current = currentDesired(project);
    if (!current) return [];
    const before: DesiredState = JSON.parse(current.state_json);
    return Object.entries(compose.services || {})
      .filter(([name, svc]) => {
        const old = before.services?.[name]?.placement?.nodes ?? [];
        const next = svc['x-tug']?.placement?.nodes ?? [];
        const keepsData =
          Boolean(svc['x-tug']?.backup) ||
          (svc.volumes ?? []).some((mount) => typeof mount === 'object' && mount.type === 'volume');
        return keepsData && old.length > 0 && next.length > 0 && old.some((n) => !next.includes(n));
      })
      .map(([name]) => name);
  }
  /** Resolves to whether the deploy was published with images built on control, the only deploys that add archives or build cache. */
  async function deployRequest(
    req: Request,
    res: Response,
    uploadError?: unknown,
  ): Promise<boolean> {
    const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
    let responseBody: unknown;
    let responseError: unknown;
    let lock: Awaited<ReturnType<typeof acquireProjectLock>> | undefined;
    let depId: string | undefined;
    let contextDir: string | undefined;
    let builtAndPublished = false;
    try {
      if (uploadError) throw httpError(400, errMessage(uploadError));
      let body;
      try {
        body = req.is('multipart/form-data') ? JSON.parse(req.body.payload) : req.body;
      } catch {
        throw httpError(400, 'invalid deployment payload JSON');
      }
      if (!body || typeof body !== 'object') throw httpError(400, 'deployment payload is required');
      const project: string = body.project || 'site';
      const compose: ComposeFile = body.compose;
      const version = body.version || `git-${Date.now()}`;
      assertProject(req.actor!, project);
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(project) ||
        typeof version !== 'string' ||
        !version.length
      )
        throw httpError(400, 'invalid project or version');
      if (version.startsWith(ROLLBACK_VERSION_PREFIX))
        throw httpError(
          400,
          `version cannot start with "${ROLLBACK_VERSION_PREFIX}" (reserved for rollback deployments)`,
        );
      const nodeRows = db.all<NodeRow>(
        'SELECT name,labels_json,last_seen_at,created_at FROM nodes WHERE disabled_at IS NULL ORDER BY created_at,name',
      );
      // Stale nodes (agent not seen recently) are not scheduled onto, so a dead host cannot hold a rollout open.
      const nodeInfos = nodeRows
        .filter((row) => !isStale(row))
        .map((row) => ({
          name: row.name,
          labels: row.labels_json ? (JSON.parse(row.labels_json) as string[]) : [],
          created_at: row.created_at,
        }));
      // Resolve label-based and global placement into concrete node lists before validation.
      for (const svc of Object.values(compose.services || {})) {
        const ext = (svc['x-tug'] ||= {}) as {
          placement?: { nodes?: string[]; labels?: string[] };
          replicas?: number;
          global?: boolean;
        };
        const placement = ext.placement || {};
        const global = ext.global === true;
        const labels = Array.isArray(placement.labels) ? placement.labels : [];
        if (!placement.nodes?.length && (labels.length || global)) {
          const matched = nodeInfos
            .filter((node) => labels.every((label) => node.labels.includes(label)))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (!matched.length) throw httpError(400, 'no nodes match placement labels');
          let selected = matched;
          if (!global) {
            const replicas = ext.replicas || matched.length;
            if (!Number.isInteger(replicas) || replicas < 1)
              throw httpError(400, 'replicas must be a positive integer');
            selected = matched.slice(0, Math.min(replicas, matched.length));
          }
          ext.placement = { ...placement, nodes: selected.map((node) => node.name) };
          ext.replicas = selected.length;
        }
      }
      const nodes = nodeRows.map((row) => ({ name: row.name }));
      for (const [name, svc] of Object.entries(compose.services || {}))
        for (const node of svc['x-tug']?.placement?.nodes || [])
          if (!nodes.some((n) => n.name === node))
            throw httpError(400, `${name}: placement node ${node} is not an enabled node`);
      try {
        validateCompose(
          compose,
          nodes.map((n) => n.name),
        );
      } catch (e) {
        throw httpError(400, errMessage(e));
      }
      assertIngressHostsFree(project, compose, req.actor);
      assertNoReservedIngressPorts(compose);
      const misplaced = misplacedSecrets(compose);
      if (misplaced.length)
        throw httpError(
          400,
          `a secret cannot be used in ${misplaced.join('; ')}: secrets are substituted only in environment, command, entrypoint and healthcheck.test. Use tug var set for a value that is not a secret`,
        );
      const deploymentValues = checkedDeploymentValues(project, body.values);
      const acknowledgedMoves: string[] = Array.isArray(body.moves) ? body.moves.map(String) : [];
      const unacknowledged = movedServices(project, compose).filter(
        (name) => !acknowledgedMoves.includes(name),
      );
      if (unacknowledged.length)
        throw httpError(
          409,
          `${unacknowledged.join(', ')} would start empty on a different node: its data does not move. Back it up, then deploy with --move ${unacknowledged.join(' --move ')} to hold the services that write to it, and run tug restore run <target> --confirm`,
        );
      // The CLI interpolates control secrets as sentinels; a reference to a secret that is gone would deploy an empty value.
      const referenced = sentinelNames(compose);
      if (referenced.includes(REGISTRY_AUTH_SECRET))
        throw httpError(
          400,
          REGISTRY_AUTH_SECRET +
            ' is reserved for registry authentication and cannot be used in service definitions',
        );
      if (referenced.length) {
        const known = new Set(
          db
            .all<{ name: string }>('SELECT name FROM secrets WHERE project_id=?', project)
            .map((row) => row.name),
        );
        const missing = referenced.filter((name) => !known.has(name));
        if (missing.length)
          throw httpError(
            400,
            `secrets not found in project ${project}: ${missing.join(', ')}; create them with tug secret set`,
          );
      }
      const builtServices = Object.entries(compose.services)
        .filter(([, service]) => service.build)
        .map(([name]) => name);
      const local: LocalImageUpload[] | undefined = body.localImages;
      const context = files.find((file) => file.fieldname === 'context');
      if (local !== undefined && (!Array.isArray(local) || context))
        throw httpError(400, 'localImages must be an array and cannot accompany a source context');
      if (files.filter((file) => file.fieldname === 'context').length > 1)
        throw httpError(400, 'duplicate source context');
      if (local) {
        if (local.some((item) => !item || typeof item !== 'object'))
          throw httpError(400, 'invalid local image manifest');
        if (
          local.length !== builtServices.length ||
          new Set(local.map((item) => item.service)).size !== local.length ||
          new Set(local.map((item) => item.field)).size !== local.length
        )
          throw httpError(400, 'localImages must contain exactly one image for each build service');
        for (const item of local) {
          if (
            !/^tug-build\/[a-f0-9-]{36}\/image-\d+:local$/.test(item.imageRef) ||
            item.imageRef.split('/').at(-1) !== `${item.field}:local` ||
            !builtServices.includes(item.service) ||
            !/^image-\d+$/.test(item.field) ||
            files.filter((file) => file.fieldname === item.field).length !== 1 ||
            !/^[a-f0-9]{64}$/.test(item.sha256) ||
            !Number.isSafeInteger(item.sizeBytes) ||
            item.sizeBytes <= 0 ||
            item.sizeBytes > MAX_IMAGE_BYTES
          )
            throw httpError(400, 'invalid local image manifest or file');
        }
      }
      if (files.length !== (local ? local.length : context ? 1 : 0))
        throw httpError(400, 'unexpected deployment upload');
      if (builtServices.length && !context && !local)
        throw httpError(400, 'build services require a source context or localImages upload');
      for (const [svcName, svc] of Object.entries(compose.services)) {
        const ing = svc['x-tug']?.ingress;
        if (ing?.tls !== 'custom') continue;
        for (const secret of [ing.cert, ing.key])
          if (
            !db.get('SELECT 1 FROM secrets WHERE project_id=? AND name=?', project, secret ?? null)
          )
            throw httpError(
              400,
              `${svcName}: custom TLS secret ${secret} not found in project ${project}; set it with tug secret set first`,
            );
      }
      lock = acquireProjectLock(project, 'deploy');
      const active = db.get<DeploymentRow>(
        `SELECT * FROM deployments WHERE project_id=? AND state IN (${ACTIVE_STATES_SQL}) LIMIT 1`,
        project,
      );
      if (active)
        throw httpError(
          409,
          `deployment ${active.id} is already ${active.state}; wait for it, or cancel it with: tug deploy cancel ${active.id}`,
        );
      depId = id('dep');
      const ts = now();
      db.run(
        'INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)',
        project,
        project,
        ts,
        ts,
      );
      db.run(
        'INSERT INTO deployments(id,project_id,version,state,created_at,updated_at,actor,values_json) VALUES(?,?,?,?,?,?,?,?)',
        depId,
        project,
        version,
        'building',
        ts,
        ts,
        req.actor!.name,
        JSON.stringify(deploymentValues),
      );
      const desired = buildDesiredState({
        project,
        version,
        revision: depId,
        compose,
        defaultNode: nodes[0]?.name || null,
      });
      if (context) {
        contextDir = path.resolve(DATA_DIR, 'build-contexts', depId);
        await unpackContext(context.path, contextDir);
      }
      for (const service of builtServices) {
        const spec = desired.services[service];
        const buildId = id('build');
        const imageRef = spec.image!;
        db.run(
          'INSERT INTO builds(id,project_id,deployment_id,service,image_ref,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
          buildId,
          project,
          depId,
          service,
          imageRef,
          'building',
          ts,
          ts,
        );
        let info: ArchiveInfo | undefined;
        let importedClientRef: string | undefined;
        const relative = path.join('images', `${buildId}.tar.gz`);
        const final = path.join(DATA_DIR, relative);
        const temporary = `${final}.tmp`;
        try {
          if (local) {
            const item = local.find((item) => item.service === service)!;
            const file = files.find((file) => file.fieldname === item.field)!;
            try {
              info = await images.validate(file.path, item.imageRef);
            } catch (error) {
              throw httpError(400, `${service}: invalid image archive: ${errMessage(error)}`);
            }
            if (
              info.sha256 !== item.sha256 ||
              info.sizeBytes !== item.sizeBytes ||
              info.imageId !== item.imageId ||
              info.platform !== item.platform
            )
              throw httpError(400, `${service}: local image metadata/checksum mismatch`);
            importedClientRef = item.imageRef;
            await images.run('docker', ['load', '-i', file.path]);
            const imported = await images.inspect(item.imageRef, docker);
            if (imported.platform !== info.platform)
              throw httpError(400, 'imported image identity mismatch');
            await images.run('docker', ['tag', item.imageRef, imageRef]);
          } else
            await images.build({
              contextDir: contextDir!,
              service,
              buildSpec: compose.services[service].build!,
              imageRef,
            });
          // An unchanged rebuild produces the image the project already has an archive for: point at that
          // artifact instead of saving, hashing and storing another full copy. Nodes match by image ID, so they
          // download nothing and the running container is kept. The stored `image_id` is the archive's config
          // digest, which is not what a containerd-store daemon reports as an image ID, so compare what the
          // daemon says about the earlier tag (it stays while any retained state references it).
          const built = await images.inspect(imageRef, docker);
          let prior: BuildRow | undefined;
          for (const candidate of db.all<BuildRow>(
            "SELECT * FROM builds WHERE project_id=? AND service=? AND platform=? AND state='complete' AND artifact_path IS NOT NULL ORDER BY created_at DESC LIMIT 20",
            project,
            service,
            built.platform,
          )) {
            if (!(await fs.stat(path.join(DATA_DIR, candidate.artifact_path!)).catch(() => null)))
              continue;
            const earlier = await images
              .inspect(candidate.image_ref, docker)
              .catch(() => undefined);
            if (earlier?.imageId === built.imageId && earlier.platform === built.platform) {
              prior = candidate;
              break;
            }
          }
          if (prior) {
            spec.image = prior.image_ref;
            spec.artifact = {
              buildId: prior.id,
              imageRef: prior.image_ref,
              imageId: prior.image_id,
              platform: prior.platform,
              sha256: prior.sha256,
              sizeBytes: prior.size_bytes,
            };
            db.run('DELETE FROM builds WHERE id=?', buildId);
            await docker.removeImage(imageRef).catch(() => {});
            continue;
          }
          info = await images.save(imageRef, temporary);
          await fs.rename(temporary, final);
          const artifact: ImageArtifact = { buildId, imageRef, ...info };
          spec.artifact = artifact;
          advance(db, buildLifecycle, buildId, 'building', 'complete', {
            image_id: info.imageId,
            platform: info.platform,
            sha256: info.sha256,
            size_bytes: info.sizeBytes,
            artifact_path: relative,
            updated_at: now(),
          });
        } finally {
          if (importedClientRef) await docker.removeImage(importedClientRef).catch(() => {});
          await fs.rm(temporary, { force: true });
        }
      }
      const registrySecret = db.get<SecretRow>(
        'SELECT * FROM secrets WHERE project_id=? AND name=?',
        project,
        REGISTRY_AUTH_SECRET,
      );
      const credentials = parseRegistryCredentials(
        registrySecret ? decrypt(registrySecret.encrypted_value, masterKey) : undefined,
      );
      const resolved = new Map<string, string>();
      for (const [name, spec] of Object.entries(desired.services)) {
        if (spec.artifact) continue;
        const image = spec.image!;
        if (!resolved.has(image)) resolved.set(image, await images.resolve(image, credentials));
        spec.image = resolved.get(image)!;
        desired.compose.services[name].image = spec.image;
      }
      const buildLock = lock;
      const publishingId = depId;
      await withPublication(() => {
        const owned = locks.owns(buildLock.name, buildLock.owner, now());
        const pending = db.get(
          'SELECT 1 FROM deployments WHERE id=? AND state=?',
          publishingId,
          'building',
        );
        if (!owned || !pending)
          throw httpError(409, 'deployment was cancelled or its build lease was lost');
        // The first check ran before the build and image resolution, which can take minutes: another project may
        // have been published, or mapped a domain, since. Publication is the one serialized point where a hostname is
        // actually claimed, so the claim is checked again here.
        assertIngressHostsFree(project, desired.compose, req.actor);
        immediateTransaction(db, () => {
          const published = advance(
            db,
            deploymentLifecycle,
            publishingId,
            'building',
            'rolling_out',
            { updated_at: now() },
          );
          if (!published || !locks.owns(buildLock.name, buildLock.owner, now()))
            throw httpError(409, 'deployment was cancelled or its build lease was lost');
          db.run(
            'INSERT INTO desired_states(id,project_id,deployment_id,version,state_json,created_at) VALUES(?,?,?,?,?,?)',
            id('ds'),
            project,
            publishingId,
            version,
            JSON.stringify(desired),
            ts,
          );
          // The moved service starts empty: keep what writes to it stopped until its data is restored. A writer
          // that moved too is held as well: acknowledging its own move says its files start empty, and it would
          // otherwise run (a fresh WordPress installer) against the database that is still empty.
          for (const moved of acknowledgedMoves.filter((name: string) => compose.services?.[name]))
            for (const writer of discoverWriters(compose, `service:${moved}`))
              db.run(
                'INSERT OR REPLACE INTO service_holds(project_id,service,reason,restore_id,created_at) VALUES(?,?,?,?,?)',
                project,
                writer,
                `moved ${moved}`,
                null,
                ts,
              );
          for (const [volumeName, volumeSpec] of Object.entries(compose.volumes || {})) {
            const lp = volumeSpec?.['x-tug'] || {};
            const nodeName = lp.placement?.nodes?.[0] || null;
            const node = nodeName
              ? db.get<Pick<NodeRow, 'id'>>(
                  'SELECT id FROM nodes WHERE name=? OR id=?',
                  nodeName,
                  nodeName,
                )
              : null;
            db.run(
              `INSERT INTO volumes(id,project_id,name,type,driver,node_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,name) DO UPDATE SET type=excluded.type,driver=excluded.driver,node_id=excluded.node_id,config_json=excluded.config_json,updated_at=excluded.updated_at`,
              id('vol'),
              project,
              volumeName,
              lp.type || 'local',
              lp.driver || null,
              node?.id || null,
              JSON.stringify(lp),
              ts,
              ts,
            );
          }
          db.run(
            'UPDATE projects SET current_deployment_id=?,updated_at=? WHERE id=?',
            publishingId,
            now(),
            project,
          );
        });
      });
      audit(req.actor!, {
        type: 'deploy',
        project,
        deploymentId: depId,
        message: `deployment ${depId} (${version}) started by ${req.actor!.name}`,
        metadata: { version },
      });
      wakeAll(project);
      builtAndPublished = builtServices.length > 0;
      responseBody = {
        deployment: {
          id: depId,
          project,
          version,
          state: 'rolling_out',
          actor: req.actor!.name,
          values: deploymentValues,
        },
        desiredState: desired,
      };
    } catch (e) {
      if (depId)
        try {
          advance(db, deploymentLifecycle, depId, 'building', 'build_failed', {
            error_message: errMessage(e),
            updated_at: now(),
          });
          advanceWhere(
            db,
            buildLifecycle,
            'building',
            'failed',
            {
              sql: 'deployment_id=?',
              params: [depId],
            },
            { updated_at: now() },
          );
        } catch {
          /* Best-effort bookkeeping. */
        }
      responseError = e;
    } finally {
      releaseLock(lock);
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
      if (contextDir) await fs.rm(contextDir, { recursive: true, force: true });
      await collectArtifacts().catch((e) => console.error('image cleanup failed:', errMessage(e)));
    }
    if (responseError) sendError(res, responseError);
    else res.json(responseBody);
    return builtAndPublished;
  }
  get('/agent/v1/images/:buildId', authAgent, async (req, res) => {
    const states = retainedStates();
    const allowed = states.some((state) =>
      Object.values(state.services).some(
        (service) =>
          service.artifact?.buildId === String(req.params.buildId) &&
          (!service.placement.nodes?.length || service.placement.nodes.includes(req.node!.name)),
      ),
    );
    if (!allowed) return res.status(404).json({ error: 'image not found' });
    const row = db.get<BuildRow>(
      'SELECT * FROM builds WHERE id=? AND state=?',
      String(req.params.buildId),
      'complete',
    );
    if (!row?.artifact_path) return res.status(404).json({ error: 'image not found' });
    try {
      await fs.access(path.join(DATA_DIR, row.artifact_path));
      res.set({
        'Content-Type': 'application/gzip',
        'Content-Length': String(row.size_bytes),
        'X-Tug-Sha256': row.sha256,
        'Cache-Control': 'private, no-store',
      });
      await pipeline(createReadStream(path.join(DATA_DIR, row.artifact_path)), res);
    } catch {
      if (!res.headersSent) res.status(404).json({ error: 'image artifact unavailable' });
    }
  });

  api('get', '/api/v1/deployments/:id', deploymentProject, async (req, res) =>
    res.json(
      deploymentView(
        db.get<DeploymentRow>('SELECT * FROM deployments WHERE id=?', String(req.params.id)),
      ),
    ),
  );
  api('post', '/api/v1/deployments/:id/cancel', deploymentProject, async (req, res) =>
    withPublication(() => {
      const row = db.get<DeploymentRow>(
        'SELECT * FROM deployments WHERE id=?',
        String(req.params.id),
      );
      if (!row) return res.status(404).json({ error: 'deployment not found' });
      if (!(ACTIVE_DEPLOYMENT_STATES as readonly string[]).includes(row.state))
        return res.status(409).json({ error: `deployment is ${row.state}` });
      const cancelled = advance(
        db,
        deploymentLifecycle,
        String(req.params.id),
        row.state as DeploymentState,
        'cancelled',
        { updated_at: now() },
      );
      if (!cancelled) return res.status(409).json({ error: 'deployment is no longer active' });
      audit(req.actor!, {
        type: 'cancel',
        project: row.project_id,
        deploymentId: row.id,
        message: `deployment ${row.id} cancelled by ${req.actor!.name}`,
      });
      res.json({ ok: true });
    }),
  );
  api('post', '/api/v1/rollback', bodyProject, async (req, res) =>
    withWriter(async () => {
      const project = req.body.project || 'site';
      try {
        const out = createRollback(project, {
          actor: req.actor!.name,
          viewer: req.actor,
          force: Boolean(req.body.force),
        });
        audit(req.actor!, {
          type: 'rollback',
          project,
          deploymentId: out.deployment!.id,
          message: `rollback to ${out.desiredState.version} (deployment ${out.deployment!.id}) started by ${req.actor!.name}`,
          metadata: { version: out.desiredState.version, force: Boolean(req.body.force) },
        });
        res.json(out);
      } catch (e) {
        sendError(res, e);
      }
    }),
  );
  api('get', '/api/v1/volumes', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    const desired = currentDesired(project);
    const state: DesiredState | undefined = desired ? JSON.parse(desired.state_json) : undefined;
    const volumes = db.all<VolumeRow & { node: string | null }>(
      'SELECT v.*,n.name AS node FROM volumes v LEFT JOIN nodes n ON n.id=v.node_id WHERE v.project_id=? ORDER BY v.name',
      project,
    );
    res.json({
      volumes: volumes.map((volume) => ({
        ...volume,
        persistent: Boolean(
          JSON.parse(volume.config_json || '{}').persistent || volume.type !== 'ephemeral',
        ),
        usedBy: Object.entries(state?.compose?.services || {})
          .filter(([, service]) =>
            (service.volumes || []).some(
              (mount) =>
                (typeof mount === 'string' ? mount.split(':')[0] : mount.source) === volume.name,
            ),
          )
          .map(([name]) => name),
      })),
    });
  });
  api('delete', '/api/v1/volumes/:name', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    const deleteData = String(req.query.deleteData || 'false') === 'true';
    let lock;
    try {
      lock = deleteData ? acquireProjectLock(project, 'volume.delete') : null;
      const volume = db.get<VolumeRow>(
        'SELECT * FROM volumes WHERE project_id=? AND name=?',
        project,
        String(req.params.name),
      );
      if (!volume) return res.status(404).json({ error: 'volume not found' });
      const config = JSON.parse(volume.config_json || '{}');
      if ((config.persistent || volume.type !== 'ephemeral') && !deleteData)
        return res
          .status(409)
          .json({ error: 'refusing to delete persistent volume without deleteData=true' });
      const ds = currentDesired(project);
      if (ds) {
        const state: DesiredState = JSON.parse(ds.state_json);
        const inUse = Object.entries(state.compose?.services || {})
          .filter(([, svc]) =>
            (svc.volumes || []).some(
              (v) =>
                (typeof v === 'string' ? v.split(':')[0] : v.source) === String(req.params.name),
            ),
          )
          .map(([name]) => name);
        if (inUse.length)
          return res
            .status(409)
            .json({ error: `volume is still referenced by services: ${inUse.join(', ')}` });
      }
      let commandId = null;
      if (deleteData && volume.node_id) {
        commandId = queueCommand(volume.node_id, project, 'volume.delete', {
          project,
          volume: String(req.params.name),
        });
      }
      db.run('DELETE FROM volumes WHERE project_id=? AND name=?', project, String(req.params.name));
      res.json({ ok: true, commandId, deletedMetadata: true, deleteData });
    } catch (e) {
      sendError(res, e);
    } finally {
      releaseLock(lock);
    }
  });
  api('post', '/api/v1/holds/release', bodyProject, async (req, res) =>
    withWriter(async () => {
      const project = String(req.body?.project || 'site');
      const services: string[] = Array.isArray(req.body?.services)
        ? req.body.services.map(String)
        : [];
      // Only holds a deploy placed for a move; a restore's holds are dropped by `restore release`.
      const rows = db.all<{ service: string }>(
        'SELECT service FROM service_holds WHERE project_id=? AND restore_id IS NULL',
        project,
      );
      const released = rows
        .map((row) => row.service)
        .filter((service) => !services.length || services.includes(service));
      for (const service of released)
        db.run(
          'DELETE FROM service_holds WHERE project_id=? AND service=? AND restore_id IS NULL',
          project,
          service,
        );
      wakeAll(project);
      res.json({ ok: true, project, released });
    }),
  );
  api('post', '/api/v1/images/prune', null, async (req, res) =>
    withWriter(async () => {
      const keep = req.body?.keep === undefined ? 5 : Number(req.body.keep);
      if (!Number.isInteger(keep) || keep < 1)
        return res.status(400).json({ error: 'keep must be a positive integer' });
      res.json({
        dryRun: Boolean(req.body?.dryRun),
        keep,
        ...(await pruneArtifacts(keep, Boolean(req.body?.dryRun))),
      });
    }),
  );
  const RESTORE_MARKER = '.tug-control-restore';
  const restoreRoot = () =>
    process.env.TUG_CONTROL_RESTORE_DIR || path.join(DATA_DIR, 'control-restore');
  const controlBackupDir = () =>
    process.env.TUG_CONTROL_BACKUP_DIR || path.join(DATA_DIR, 'control-backups');
  /**
   * Removes what a crash left behind. Files and directories control never recorded are removed once they are old
   * enough that nothing is still writing them: archives and staging copies in the backup directory (both hold keys),
   * and downloads of a restore source. The restore scratch directory and restic helper containers cannot belong to
   * anything running at startup, so they go at once.
   */
  async function sweepControlLeftovers(): Promise<void> {
    const old = async (target: string) => {
      const stat = await fs.stat(target).catch(() => null);
      return Boolean(stat && Date.now() - stat.mtimeMs > 3600_000);
    };
    const dir = controlBackupDir();
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const target = path.resolve(dir, name);
      if (/^cbak_[A-Za-z0-9_-]+-staging$/.test(name)) {
        if (await old(target)) await fs.rm(target, { recursive: true, force: true });
      } else if (/^cbak_[A-Za-z0-9_-]+\.tar\.gz$/.test(name)) {
        if (!db.get('SELECT 1 FROM backups WHERE artifact_ref=?', target) && (await old(target)))
          await fs.rm(target, { force: true });
      }
    }
    for (const name of await fs.readdir(DATA_DIR).catch(() => [] as string[]))
      if (
        /^control-restore-(download|upload)-.+\.tar\.gz$/.test(name) &&
        (await old(path.join(DATA_DIR, name)))
      )
        await fs.rm(path.join(DATA_DIR, name), { force: true });
    // Only directories a restore made and marked: the configured path is a parent and is never removed itself.
    for (const name of await fs.readdir(restoreRoot()).catch(() => [] as string[])) {
      const target = path.join(restoreRoot(), name);
      if (
        /^r_[A-Za-z0-9]+$/.test(name) &&
        (await fs.stat(path.join(target, RESTORE_MARKER)).catch(() => null))
      )
        await fs.rm(target, { recursive: true, force: true });
    }
    for (const helper of await docker
      .listContainers({ label: ['tug.job=control-backup'] })
      .catch(() => []))
      await docker.removeContainer(helper.Id).catch(() => undefined);
  }
  /** Writes a consistent control archive into the control backup directory; the caller records it and decides how long it stays. */
  async function createControlArchive(
    withImages: boolean,
  ): Promise<{ backupId: string; artifactRef: string; createdAt: string }> {
    const backupDir = controlBackupDir();
    // The archive holds the master key and the CA key, so nothing here is ever readable beyond the control user.
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await fs.chmod(backupDir, 0o700);
    const ts = now();
    const backupId = id('cbak');
    const staging = path.join(backupDir, `${backupId}-staging`);
    const artifactRef = path.resolve(backupDir, `${backupId}.tar.gz`);
    try {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { mode: 0o700 });
      const snapshotPath = path.join(staging, 'tug.db');
      db.run('VACUUM INTO ?', snapshotPath);
      await fs.chmod(snapshotPath, 0o600);
      await fs.copyFile(masterKeyFile, path.join(staging, 'master.key'));
      await fs.chmod(path.join(staging, 'master.key'), 0o600);
      await fs.cp(path.join(DATA_DIR, 'pki'), path.join(staging, 'pki'), {
        recursive: true,
        filter: (src) => path.basename(src) !== 'server.json',
      });
      if (withImages) await fs.cp(artifactDir, path.join(staging, 'images'), { recursive: true });
      await fs.writeFile(
        path.join(staging, 'metadata.json'),
        JSON.stringify({ backupId, createdAt: ts, type: 'control', images: withImages }, null, 2),
        { mode: 0o600 },
      );
      await tar.c({ gzip: true, file: artifactRef, cwd: staging, mode: 0o600 }, [
        'tug.db',
        'master.key',
        'metadata.json',
        'pki',
        ...(withImages ? ['images'] : []),
      ]);
    } catch (error) {
      await fs.rm(artifactRef, { force: true });
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    return { backupId, artifactRef, createdAt: ts };
  }
  api(
    'post',
    '/api/v1/control/backups/run',
    null,
    // `toDestination` stores a backup in the destination now and returns where it went, instead of a local archive.
    async (req, res, next) => {
      if (!req.body?.toDestination) return next();
      if (!backupDestination())
        return res.status(409).json({
          error:
            'no backup destination is configured; run tug backup destination set <url>, or use tug control backup --local for an archive on the control host, or -o <file> to save one on this machine',
        });
      if (controlPushRunning)
        return res.status(409).json({ error: 'a control backup is already running' });
      const result = await runControlDestination('manual');
      if (!result)
        return res.status(409).json({ error: 'control cannot back up right now; restart it' });
      audit(req.actor!, {
        type: 'control.backup',
        message: `control backup stored in the backup destination by ${req.actor!.name}`,
        metadata: { snapshotId: result.snapshotId },
      });
      return res.status(result.ok ? 200 : 502).json(result);
    },
    async (req, res) =>
      withWriter(async () => {
        const withImages = req.body?.images !== false;
        const { backupId, artifactRef, createdAt } = await createControlArchive(withImages);
        db.run(
          'INSERT INTO backups(id,project_id,target,node_id,state,artifact_ref,metadata_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)',
          backupId,
          '_control',
          'control-plane',
          null,
          'completed',
          artifactRef,
          JSON.stringify({ type: 'control', images: withImages }),
          createdAt,
          now(),
        );
        audit(req.actor!, {
          type: 'control.backup',
          message: `control backup ${backupId} created by ${req.actor!.name}`,
        });
        res.json({
          ok: true,
          stored: 'control-host',
          backupId,
          artifactRef,
          state: 'completed',
          images: withImages,
        });
      }),
  );
  const controlIntervalMs = () =>
    Number(process.env.TUG_CONTROL_BACKUP_INTERVAL_MS) || 24 * 3600_000;
  const controlRetryMs = () => Number(process.env.TUG_CONTROL_BACKUP_RETRY_MS) || 3600_000;
  const resticImage = () => process.env.TUG_RESTIC_IMAGE || DEFAULT_RESTIC_IMAGE;
  /** How long one control backup, listing or fetch may take before its helper is removed; the module default is 30 minutes. */
  const controlJobLimitMs = () => Number(process.env.TUG_CONTROL_BACKUP_LIMIT_MS) || undefined;
  /** How long restic may print only backend retry notices before the job is failed with the cause; the module default is 2 minutes. */
  const controlStallMs = () => Number(process.env.TUG_CONTROL_BACKUP_STALL_MS) || undefined;
  const controlEvent = (level: 'info' | 'error', type: string, message: string, meta: object) =>
    db.run(
      'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id('evt'),
      '_control',
      null,
      null,
      level,
      type,
      message,
      JSON.stringify(meta),
      now(),
    );
  /**
   * Which destination an outcome belongs to. Success in one destination says nothing about another, so status and
   * scheduling only look at outcomes for the destination in use now, and a switch starts a first backup there.
   */
  const destinationKey = (url: string) =>
    crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const lastControlDestination = (key: string, onlyCompleted: boolean) =>
    db.get<{ state: string; created_at: string; metadata_json: string }>(
      `SELECT state,created_at,metadata_json FROM backups WHERE project_id='_control' AND target='control-destination' AND json_extract(metadata_json,'$.destination')=?${onlyCompleted ? " AND state='completed'" : ''} ORDER BY created_at DESC LIMIT 1`,
      key,
    );
  /** What `tug backup list` shows about control's own backup in the current destination; null while there is none. */
  function controlDestinationStatus(): {
    lastSuccessAt: string | null;
    lastStatus: string | null;
    problem: string | null;
    scope: 'shared' | 'local';
    repository: string;
  } | null {
    const destination = backupDestination();
    if (!destination) return null;
    const key = destinationKey(destination.url);
    const ok = lastControlDestination(key, true);
    const last = lastControlDestination(key, false);
    const failure =
      last?.state === 'failed'
        ? `the last control backup failed: ${(JSON.parse(last.metadata_json) as { error?: string }).error ?? 'unknown error'}`
        : null;
    const stale =
      ok && Date.now() - Date.parse(ok.created_at) > 2 * controlIntervalMs()
        ? `no successful control backup since ${ok.created_at}`
        : null;
    // A destination that is new, or was switched to, is unprotected until its first backup completes.
    const unprotected =
      !ok && Date.now() - Date.parse(destination.updated_at) > controlRetryMs()
        ? `no control backup has completed in this destination since it was set (${destination.updated_at})`
        : null;
    return {
      lastSuccessAt: ok?.created_at ?? null,
      lastStatus: last?.state ?? null,
      problem: failure ?? stale ?? unprotected,
      // A local path is for development: it does not survive losing the host, so it is never shown as off-host.
      scope: destination.url.startsWith('/') ? 'local' : 'shared',
      repository: controlRepository(destination.url),
    };
  }
  let controlPushRunning = false;
  /** Backs control up into the shared destination: a consistent archive without images, streamed into restic. */
  interface ControlDestinationResult {
    ok: boolean;
    stored?: 'destination';
    backupId?: string;
    repository?: string;
    snapshotId?: string;
    sizeBytes?: number;
    warning?: string;
    error?: string;
  }
  async function runControlDestination(
    trigger: 'schedule' | 'manual',
  ): Promise<ControlDestinationResult | null> {
    // The URL and its credentials are read together, before anything awaits: a destination changed meanwhile
    // must not pair the old URL with the new credentials.
    const destination = backupDestination();
    if (!destination || controlPushRunning) return null;
    const env = backupEnv();
    const key = destinationKey(destination.url);
    controlPushRunning = true;
    const startedAt = now();
    let archive: { backupId: string; artifactRef: string } | undefined;
    try {
      archive = await withWriter(() => createControlArchive(false));
      const size = (await fs.stat(archive.artifactRef)).size;
      if (restartRequired) return null;
      const push = await pushControlArchive(
        docker,
        {
          url: destination.url,
          env,
          password: controlRepositoryPassword(masterKey),
          resticImage: resticImage(),
          limitMs: controlJobLimitMs(),
          stallMs: controlStallMs(),
        },
        archive.artifactRef,
        // What the snapshot holds, visible when choosing one: no images and, always, no workload data.
        { tags: ['images:none', `tug:${ownVersion}`, `trigger:${trigger}`] },
      );
      if (restartRequired) return null;
      const meta = {
        type: 'control',
        destination: key,
        snapshotId: push.snapshotId,
        sizeBytes: size,
        ...push,
      };
      db.run(
        'INSERT INTO backups(id,project_id,target,node_id,state,artifact_ref,metadata_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)',
        archive.backupId,
        '_control',
        'control-destination',
        null,
        'completed',
        push.snapshotId ?? null,
        JSON.stringify(meta),
        startedAt,
        now(),
      );
      controlEvent(
        'info',
        'backup.completed',
        'control backup stored in the backup destination',
        meta,
      );
      return {
        ok: true,
        stored: 'destination',
        backupId: archive.backupId,
        repository: controlRepository(destination.url),
        snapshotId: push.snapshotId,
        sizeBytes: size,
        ...(push.warning ? { warning: push.warning } : {}),
      };
    } catch (e) {
      // A restore replaced the database while this push ran; there is nothing left to record it in.
      if (restartRequired) return null;
      const error = errMessage(e);
      db.run(
        'INSERT INTO backups(id,project_id,target,node_id,state,artifact_ref,metadata_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id('cbak'),
        '_control',
        'control-destination',
        null,
        'failed',
        null,
        JSON.stringify({ type: 'control', destination: key, error }),
        startedAt,
        now(),
      );
      controlEvent('error', 'backup.failed', `control backup failed: ${error}`, { error });
      return { ok: false, stored: 'destination', error };
    } finally {
      if (archive) await fs.rm(archive.artifactRef, { force: true });
      controlPushRunning = false;
    }
  }
  controlDestinationTick = () => {
    const destination = backupDestination();
    if (controlPushRunning || restartRequired || !destination) return;
    const key = destinationKey(destination.url);
    const at = Date.now();
    const ok = lastControlDestination(key, true);
    if (ok && at - Date.parse(ok.created_at) < controlIntervalMs()) return;
    const last = lastControlDestination(key, false);
    if (last?.state === 'failed' && at - Date.parse(last.created_at) < controlRetryMs()) return;
    void runControlDestination('schedule').catch((e) =>
      console.error(`control backup failed: ${errMessage(e)}`),
    );
  };
  api('get', '/api/v1/control/backups', null, async (_req, res) => {
    const destination = backupDestination();
    const rows = db.all<{
      id: string;
      created_at: string;
      artifact_ref: string | null;
      metadata_json: string;
    }>(
      "SELECT id,created_at,artifact_ref,metadata_json FROM backups WHERE project_id='_control' AND target='control-plane' ORDER BY created_at DESC LIMIT 50",
    );
    // Copies on the control host, from the catalog; a file that was deleted by hand shows as gone.
    const local = await Promise.all(
      rows.map(async (row) => {
        const stat = row.artifact_ref ? await fs.stat(row.artifact_ref).catch(() => null) : null;
        const meta = JSON.parse(row.metadata_json || '{}') as { images?: boolean };
        return {
          id: row.id,
          createdAt: row.created_at,
          path: row.artifact_ref,
          onDisk: Boolean(stat),
          sizeBytes: stat?.size ?? null,
          images: meta.images ?? null,
        };
      }),
    );
    // Copies in the destination, read from the destination itself: what is actually there, not what control remembers.
    let remote: { state: 'ok' | 'missing' | 'error'; snapshots: unknown[]; error?: string } | null =
      null;
    if (destination)
      try {
        remote = await listControlSnapshots(docker, {
          url: destination.url,
          env: backupEnv(),
          password: controlRepositoryPassword(masterKey),
          resticImage: resticImage(),
          limitMs: controlJobLimitMs(),
          stallMs: controlStallMs(),
        });
      } catch (e) {
        remote = { state: 'error', snapshots: [], error: errMessage(e) };
      }
    res.json({
      destinationConfigured: Boolean(destination),
      repository: destination ? controlRepository(destination.url) : null,
      local,
      remote,
    });
  });
  void sweepControlLeftovers().catch((e) =>
    console.error(`startup cleanup failed: ${errMessage(e)}`),
  );
  api('get', '/api/v1/control/backups/:id/download', null, async (req, res) => {
    const row = db.get<{ artifact_ref: string | null }>(
      "SELECT artifact_ref FROM backups WHERE id=? AND project_id='_control' AND target='control-plane'",
      String(req.params.id),
    );
    if (!row?.artifact_ref) return res.status(404).json({ error: 'no such control backup' });
    if (!(await fs.stat(row.artifact_ref).catch(() => null)))
      return res.status(404).json({ error: 'the control backup is no longer on disk' });
    audit(req.actor!, {
      type: 'control.backup_download',
      message: `control backup ${String(req.params.id)} downloaded by ${req.actor!.name}`,
    });
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/gzip');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${path.basename(row.artifact_ref)}"`,
    );
    res.sendFile(row.artifact_ref, { dotfiles: 'allow' });
  });
  /**
   * Reads the newest control snapshot of a destination into a private file before the restore takes the writer queue:
   * a slow or hung bucket must not block deploys and every other write for the length of the fetch.
   */
  const fetchRestoreSource: RequestHandler = async (req, res, next) => {
    const from = req.body?.fromDestination;
    if (!from) return next();
    if (!req.body.confirm && !req.body.verify)
      return res.status(400).json({
        error: 'confirm=true is required; restore overwrites control data then requires restart',
      });
    if (restartRequired)
      return res.status(503).json({ error: 'control restored; restart required' });
    let source;
    try {
      source = parseBackupDestination(from);
    } catch (e) {
      return res.status(400).json({ error: errMessage(e) });
    }
    if (source.url.startsWith('/'))
      return res.status(400).json({
        error: 'a restore reads a shared destination (s3:, sftp: or rest:), not a local path',
      });
    const snapshot = (from as { snapshot?: unknown }).snapshot;
    if (
      snapshot !== undefined &&
      (typeof snapshot !== 'string' || !CONTROL_SNAPSHOT_ID.test(snapshot))
    )
      return res.status(400).json({
        error: 'snapshot must be an id from tug control backup list (8 to 64 hex digits)',
      });
    const password = (from as { password?: unknown }).password;
    if (typeof password !== 'string' || !/^[0-9a-f]{64}$/.test(password))
      return res.status(400).json({
        error:
          'the control password is required; it is the one printed by `tug backup password --control` on the old control',
      });
    const fetched = path.join(DATA_DIR, `control-restore-download-${id('dl')}.tar.gz`);
    res.locals.fetched = fetched;
    // A client that gives up must not leave a restore running: abort the fetch and drop the file.
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
      void fs.rm(fetched, { force: true });
    });
    try {
      await fetchControlArchive(
        docker,
        {
          url: source.url,
          env: source.env,
          password,
          resticImage: resticImage(),
          limitMs: controlJobLimitMs(),
          stallMs: controlStallMs(),
          signal: abort.signal,
        },
        fetched,
        snapshot as string | undefined,
      );
    } catch (e) {
      return res.status(400).json({ error: errMessage(e) });
    }
    next();
  };
  /**
   * `tug control restore --from-file`: the archive arrives as the request body (`application/gzip`, with
   * `confirm=1` or `verify=1` in the query) and is streamed to a private file, so the operator never has to copy it
   * into the control host's volume. From there it takes exactly the path of a server-side archive.
   */
  const receiveRestoreUpload: RequestHandler = async (req, res, next) => {
    if (!req.is('application/gzip')) return next();
    const confirm = req.query.confirm === '1';
    const verify = req.query.verify === '1';
    if (!confirm && !verify)
      return res.status(400).json({
        error: 'confirm=1 is required; restore overwrites control data then requires restart',
      });
    if (restartRequired)
      return res.status(503).json({ error: 'control restored; restart required' });
    const uploaded = path.join(DATA_DIR, `control-restore-upload-${id('ul')}.tar.gz`);
    res.locals.fetched = uploaded;
    res.once('close', () => void fs.rm(uploaded, { force: true }));
    try {
      await pipeline(req, createWriteStream(uploaded, { flags: 'wx', mode: 0o600 }));
    } catch (e) {
      return res.status(400).json({ error: `the archive upload failed: ${errMessage(e)}` });
    }
    req.body = { confirm, verify };
    next();
  };
  api(
    'post',
    '/api/v1/control/restore',
    null,
    receiveRestoreUpload,
    fetchRestoreSource,
    async (req, res) =>
      withWriter(async () => {
        if (!req.body.confirm && !req.body.verify)
          return res.status(400).json({
            error:
              'confirm=true is required; restore overwrites control data then requires restart',
          });
        let artifactRef = req.body.artifactRef;
        const fetched = res.locals.fetched as string | undefined;
        if (fetched) artifactRef = fetched;
        if (typeof artifactRef !== 'string' || !artifactRef)
          return res
            .status(400)
            .json({ error: 'artifactRef, fromDestination or an uploaded archive required' });
        // The configured path is only a parent: every restore gets a private directory of its own, marked as Tug's, so
        // neither this cleanup nor the startup one can ever remove anything but what a restore made.
        const restoreDir = path.join(restoreRoot(), id('r'));
        let snapshot;
        try {
          await fs.mkdir(restoreDir, { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(restoreDir, RESTORE_MARKER), '', { mode: 0o600 });
          await scanArchive(artifactRef, (entry) => {
            if (
              path.isAbsolute(entry.path) ||
              entry.path.split('/').includes('..') ||
              !['File', 'Directory'].includes(entry.type)
            )
              throw new Error('unsafe control backup entry');
          });
          await tar.x({ file: artifactRef, cwd: restoreDir, strict: true });
          // The fetched copy is extracted; do not leave a second copy of the keys on disk while the restore runs.
          if (fetched) await fs.rm(fetched, { force: true });
          const key = (await fs.readFile(path.join(restoreDir, 'master.key'), 'utf8')).trim();
          if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('invalid backup master key');
          snapshot = openSnapshotDb(path.join(restoreDir, 'tug.db'));
          const integrity = snapshot.get('PRAGMA integrity_check');
          if (integrity?.integrity_check !== 'ok')
            throw new Error('backup database failed integrity check');
          await Pki.load(path.join(restoreDir, 'pki'), false).catch((e) => {
            throw new Error(`backup PKI is not usable: ${errMessage(e)}`, { cause: e });
          });
          for (const secret of snapshot.all<SecretRow>('SELECT * FROM secrets'))
            decrypt(secret.encrypted_value, key);
          const states = snapshot.all<DesiredStateRow>('SELECT * FROM desired_states');
          const meta = JSON.parse(
            await fs.readFile(path.join(restoreDir, 'metadata.json'), 'utf8').catch(() => '{}'),
          ) as { images?: boolean; backupId?: string; createdAt?: string };
          // A backup taken without images restores the archive-less builds as pruned on the next start.
          for (const stateRow of meta.images === false ? [] : states) {
            const state: DesiredState = JSON.parse(stateRow.state_json);
            for (const service of Object.values(state.services)) {
              if (!service.artifact) continue;
              // `image prune` already removed this one before the backup.
              if (
                snapshot.get(
                  "SELECT 1 FROM builds WHERE id=? AND state='pruned'",
                  service.artifact.buildId,
                )
              )
                continue;
              const build = snapshot.get<BuildRow>(
                'SELECT * FROM builds WHERE id=? AND state=?',
                service.artifact.buildId,
                'complete',
              );
              if (
                !build?.artifact_path ||
                !/^images\/build_[a-zA-Z0-9_-]+\.tar\.gz$/.test(build.artifact_path)
              )
                throw new Error('backup contains an unsafe or missing image reference');
              const actual = await hashArchive(path.join(restoreDir, build.artifact_path));
              if (
                actual.sha256 !== build.sha256 ||
                actual.sizeBytes !== build.size_bytes ||
                actual.sha256 !== service.artifact.sha256 ||
                actual.sizeBytes !== service.artifact.sizeBytes
              )
                throw new Error('backup image archive checksum mismatch');
            }
          }
          if (req.body.verify) {
            // Everything above ran against the archive alone: nothing live was touched, and nothing needs a restart.
            const count = (query: string) =>
              Number(Object.values(snapshot!.get(query) ?? {})[0] ?? 0);
            const summary = {
              ok: true,
              verified: true,
              backupId: meta.backupId ?? null,
              createdAt: meta.createdAt ?? null,
              images: meta.images !== false,
              projects: count('SELECT COUNT(DISTINCT project_id) FROM desired_states'),
              nodes: count('SELECT COUNT(*) FROM nodes'),
              secrets: count('SELECT COUNT(*) FROM secrets'),
            };
            snapshot.close();
            snapshot = undefined;
            return res.json(summary);
          }
          snapshot.close();
          snapshot = undefined;
          await ensureDir(path.join(restoreDir, 'images'));
          // Validation completes before changing any live file. Stop DB-dependent work until restart.
          restartRequired = true;
          db.close();
          // Images are only added, so they go first; the database, master key and CA change together or not at all.
          await fs.cp(path.join(restoreDir, 'images'), artifactDir, { recursive: true });
          await activateRestore({
            dataDir: DATA_DIR,
            restoreDir,
            afterStep: options.restoreAfterStep,
          });
          // Authorization follows the restored database: older snapshots forget later principals and revive revoked ones.
          // Close every session, including this one, but only after the response has been delivered.
          // The extracted copy holds the master key, the CA key and every secret; the live files now have them.
          await fs.rm(restoreDir, { recursive: true, force: true });
          res.once('finish', closeAllSockets);
          res.json({ ok: true, restored: true, restartRequired: true });
        } catch (e) {
          try {
            snapshot?.close();
          } catch {
            /* Preserve the restore error. */
          }
          res.status(restartRequired ? 500 : 400).json({
            error: restartRequired
              ? `${errMessage(e)}; the previous state was put back, restart control`
              : errMessage(e),
            restartRequired,
          });
        } finally {
          if (fetched) await fs.rm(fetched, { force: true });
          await fs.rm(restoreDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }),
  );
  function commandForService({
    project,
    service,
    type,
    payload,
  }: {
    project: string;
    service?: string;
    type: CommandType;
    payload: Record<string, unknown>;
  }) {
    if (!service) throw httpError(400, 'service required');
    const ds = currentDesired(project);
    if (!ds) throw httpError(404, missingProject(project));
    const state = JSON.parse(ds.state_json);
    const svc = state.services?.[service];
    if (!svc) throw httpError(404, missingService(project, service));
    const nodeName = svc.placement?.nodes?.[0];
    if (!nodeName) throw httpError(400, 'service has no explicit node placement');
    const node = db.get<Pick<NodeRow, 'id'>>(
      'SELECT id FROM nodes WHERE name=? OR id=?',
      nodeName,
      nodeName,
    );
    if (!node) throw httpError(404, 'node not found');
    const cmdId = queueCommand(node.id, project, type, { project, service, ...payload });
    return { commandId: cmdId, nodeId: node.id };
  }
  api('post', '/api/v1/restart', bodyProject, async (req, res) => {
    try {
      const project = req.body.project || 'site';
      const queued = commandForService({
        project,
        service: req.body.service,
        type: 'service.restart',
        payload: {},
      });
      audit(req.actor!, {
        type: 'restart',
        project,
        message: `service ${req.body.service} restart requested by ${req.actor!.name}`,
        metadata: { service: req.body.service, commandId: queued.commandId },
      });
      res.json(queued);
    } catch (e) {
      res.status((e as HttpError).status || 500).json({ error: errMessage(e) });
    }
  });
  api('post', '/api/v1/logs', bodyProject, async (req, res) => {
    const project = req.body.project || 'site';
    const service = req.body.service;
    const tail = Number(req.body.tail || 200);
    if (!service) return res.status(400).json({ error: 'service required' });
    const ds = currentDesired(project);
    if (!ds) return res.status(404).json({ error: missingProject(project) });
    const state = JSON.parse(ds.state_json);
    const svc = state.services?.[service];
    if (!svc) return res.status(404).json({ error: missingService(project, service) });
    const nodeName = svc.placement?.nodes?.[0];
    if (!nodeName) return res.status(400).json({ error: 'service has no explicit node placement' });
    const node = db.get<Pick<NodeRow, 'id'>>(
      'SELECT id FROM nodes WHERE name=? OR id=?',
      nodeName,
      nodeName,
    );
    if (!node) return res.status(404).json({ error: 'node not found' });
    const cmdId = queueCommand(node.id, project, 'logs.fetch', { project, service, tail });
    res.json({ commandId: cmdId, nodeId: node.id });
  });
  api('get', '/api/v1/commands/:id', commandProject, async (req, res) =>
    res.json(db.get('SELECT * FROM commands WHERE id=?', String(req.params.id))),
  );
  api('get', '/api/v1/projects', null, async (req, res) => {
    const scope = projectScope(req.actor!, 'id');
    res.json({
      projects: db.all(
        `SELECT id AS name FROM projects WHERE ${scope.where} ORDER BY id`,
        ...scope.args,
      ),
    });
  });
  api('get', '/api/v1/services', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    const row = currentDesired(project);
    const desired: DesiredState | undefined = row ? JSON.parse(row.state_json) : undefined;
    const nodes = db.all<NodeRow>('SELECT * FROM nodes ORDER BY name');
    res.json({
      services: Object.entries(desired?.services || {})
        .map(([name, service]) => ({
          name,
          nodes: nodes
            .filter(
              (node) =>
                !service.placement?.nodes?.length || service.placement.nodes.includes(node.name),
            )
            .map((node) => ({
              name: node.name,
              status: statusOf(node),
            })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });
  api('get', '/api/v1/deployments', queryProject, async (req, res) => {
    res.json({
      deployments: db.all(
        `SELECT id,project_id,version,state,created_at FROM deployments WHERE project_id=? AND state IN (${ACTIVE_STATES_SQL}) ORDER BY created_at DESC,id`,
        String(req.query.project || 'site'),
      ),
    });
  });
  api('get', '/api/v1/backup/snapshots', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    const target = String(req.query.target || '');
    if (!target) throw httpError(400, 'target is required');
    res.json({
      snapshots: db.all(
        `SELECT id,target,snapshot_id,finished_at,size_bytes,trigger FROM backup_runs WHERE project_id=? AND target=? AND state='succeeded' AND snapshot_id IS NOT NULL ORDER BY finished_at DESC,id`,
        project,
        target,
      ),
    });
  });
  api('get', '/api/v1/holds', queryProject, async (req, res) => {
    res.json({
      holds: db.all(
        'SELECT service,reason,created_at FROM service_holds WHERE project_id=? AND restore_id IS NULL ORDER BY service',
        String(req.query.project || 'site'),
      ),
    });
  });
  // First call a happy client makes: the CLI's version probe compares control's version with its own (for flows the
  // stamp cannot cover), so a version skew fails with the remediation command instead of a 404 on a route the CLI's
  // own family depends on.
  api('get', '/api/v1/version', null, async (req, res) => {
    res.json({ v: ownVersion });
  });
  // Lets a client such as `tug tui` offer only the actions its credential may use; nothing here is secret.
  api('get', '/api/v1/whoami', null, async (req, res) => {
    const { name, role, projects } = req.actor!;
    res.json({ name, role, projects });
  });
  api('get', '/api/v1/status', null, async (req, res) => {
    const projects = projectScope(req.actor!, 'id');
    const deployments = projectScope(req.actor!, 'project_id');
    const statuses = projectScope(req.actor!, 's.project_id');
    res.json({
      projects: db.all(`SELECT * FROM projects WHERE ${projects.where}`, ...projects.args),
      deployments: db.all(
        `SELECT * FROM deployments WHERE ${deployments.where} ORDER BY created_at DESC LIMIT 20`,
        ...deployments.args,
      ),
      nodes: db
        .all<Pick<NodeRow, 'id' | 'name' | 'status' | 'disabled_at' | 'last_seen_at'>>(
          'SELECT id,name,status,disabled_at,last_seen_at FROM nodes',
        )
        .map((row) => ({
          id: row.id,
          name: row.name,
          status: statusOf(row),
          last_seen_at: row.last_seen_at,
          connected: wakeHub.connected(row.id),
        })),
      statuses: db.all(
        `SELECT s.*,n.name AS node FROM node_statuses s LEFT JOIN nodes n ON n.id=s.node_id WHERE ${statuses.where}`,
        ...statuses.args,
      ),
    });
  });
  api('get', '/api/v1/events', null, async (req, res) => {
    const project = req.query.project ? String(req.query.project) : null;
    if (project) assertProject(req.actor!, project);
    // A missing or non-numeric limit is the default; anything else is clamped into 1-500, never an error.
    const asked =
      typeof req.query.limit === 'string' && req.query.limit.trim() ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 500) : 100;
    const after = req.query.after === undefined ? undefined : Number(req.query.after);
    if (after !== undefined && !(Number.isSafeInteger(after) && after >= 0))
      throw httpError(400, 'after must be a non-negative integer (an event seq)');
    const scope = project
      ? { where: 'project_id=?', args: [project] }
      : projectScope(req.actor!, 'project_id'); // scoped credentials never see node-level or other projects' events
    // Without `after`: the newest events first. With it: the events after that seq, oldest first, so a client can follow the log.
    const events =
      after === undefined
        ? db.all(
            `SELECT rowid AS seq,* FROM events WHERE ${scope.where} ORDER BY created_at DESC LIMIT ?`,
            ...scope.args,
            limit,
          )
        : db.all(
            `SELECT rowid AS seq,* FROM events WHERE ${scope.where} AND rowid > ? ORDER BY rowid LIMIT ?`,
            ...scope.args,
            after,
            limit,
          );
    // The newest seq this caller can see under the same filter (never the global end, which would leak how many events
    // other projects have). To follow the log, pass `cursor` as the next `after`: with `after` it is the last row returned,
    // so paging with `limit` skips nothing, and it never runs ahead of the log if the log was emptied.
    const visibleEnd =
      db.get<{ seq: number | null }>(
        `SELECT MAX(rowid) AS seq FROM events WHERE ${scope.where}`,
        ...scope.args,
      )?.seq ?? 0;
    const cursor =
      after === undefined
        ? visibleEnd
        : events.length
          ? (events[events.length - 1] as { seq: number }).seq
          : Math.min(after, visibleEnd);
    res.json({
      events: (events as unknown as RedactableEvent[]).map((event) =>
        eventForRole(event, req.actor!.role),
      ),
      cursor,
    });
  });
  api('get', '/api/v1/diagnostics', null, async (req, res) => {
    const checks: { name: string; ok: boolean; [key: string]: unknown }[] = [];
    async function check(name: string, fn: () => Promise<Record<string, unknown>>) {
      try {
        checks.push({ name, ok: true, ...(await fn()) });
      } catch (e) {
        checks.push({ name, ok: false, error: errMessage(e) });
      }
    }
    await check('sqlite', async () => ({
      value: db.get<{ count: number }>('SELECT COUNT(*) AS count FROM projects')!.count,
    }));
    await check('certificates', async () => {
      const nowMs = Date.now();
      const ca = certificateExpiry(pki.caNotAfter, nowMs, EXPIRY_WARN_DAYS.ca);
      const saved = JSON.parse(
        await fs.readFile(path.join(DATA_DIR, 'pki', 'server.json'), 'utf8'),
      );
      const server = certificateExpiry(
        new Date(new crypto.X509Certificate(saved.cert).validTo),
        nowMs,
        EXPIRY_WARN_DAYS.server,
      );
      const problems = [
        ...(ca.state === 'expired'
          ? ['the control CA has expired; see the CA-loss recovery runbook']
          : []),
        ...(server.state === 'expired' ? ['the control server certificate has expired'] : []),
      ];
      const warnings = [
        ...(ca.state === 'expiring'
          ? [`the control CA expires in ${ca.daysLeft} days; plan a CA rotation`]
          : []),
        ...(server.state === 'expiring'
          ? [`the server certificate expires in ${server.daysLeft} days and has not renewed`]
          : []),
      ];
      return {
        ok: problems.length === 0,
        ca,
        server,
        ...(problems.length && { error: problems.join('; ') }),
        ...(warnings.length && { warnings }),
      };
    });
    await check('nodes', async () => {
      const nowMs = Date.now();
      const staleSeconds = Number(process.env.TUG_STALE_SECONDS || 60);
      const nodes = db
        .all<NodeRow>('SELECT * FROM nodes ORDER BY name')
        .map((n) => diagnoseNode(n, nowMs, staleSeconds));
      const problems = nodes.flatMap((n) => n.problems.map((p) => `${n.name}: ${p}`));
      const warnings = nodes.flatMap((n) => n.warnings.map((w) => `${n.name}: ${w}`));
      return {
        ok: problems.length === 0,
        nodes: nodes.map(({ problems: _p, warnings: _w, ...rest }) => rest),
        ...(problems.length && { error: problems.join('; ') }),
        ...(warnings.length && { warnings }),
      };
    });
    await check('master_key', async () => ({ configured: Boolean(masterKey) }));
    await check('docker', async () => ({ output: (await docker.version()).Version }));
    const ingressNodes = db.all<Pick<NodeRow, 'name' | 'ingress_status_json'>>(
      'SELECT name,ingress_status_json FROM nodes WHERE ingress=1',
    );
    if (ingressNodes.length) {
      await check('ingress', async () => {
        const bad = ingressNodes
          .filter(
            (n) =>
              (n.ingress_status_json ? JSON.parse(n.ingress_status_json).state : 'unreported') !==
              'serving',
          )
          .map((n) => n.name);
        if (bad.length) throw new Error(`ingress nodes not serving: ${bad.join(', ')}`);
        return { nodes: ingressNodes.map((n) => n.name) };
      });
    }
    res.json({ ok: checks.every((c) => c.ok), checks });
  });
  api('post', '/api/v1/diagnostics/nodes', null, async (req, res) => {
    const nodes = req.body.node
      ? db.all<Pick<NodeRow, 'id'>>(
          'SELECT id FROM nodes WHERE id=? OR name=?',
          req.body.node,
          req.body.node,
        )
      : db.all<Pick<NodeRow, 'id'>>('SELECT id FROM nodes');
    if (req.body.node && !nodes.length)
      return res.status(404).json({ error: `node ${req.body.node} not found` });
    const commands = [];
    for (const node of nodes) {
      const cmdId = queueCommand(node.id, null, 'diagnostics.run');
      commands.push({ commandId: cmdId, nodeId: node.id });
    }
    res.json({ commands });
  });

  function currentDesiredStates(): DesiredState[] {
    const rows = db.all<DesiredStateRow>(
      `SELECT ds.* FROM desired_states ds JOIN projects p ON p.current_deployment_id=ds.deployment_id ORDER BY ds.created_at DESC`,
    );
    return rows.map((s): DesiredState => JSON.parse(s.state_json));
  }
  function endpointsFor(states: DesiredState[]): ServiceEndpoints {
    const staleBefore = new Date(
      Date.now() - Number(process.env.TUG_STALE_SECONDS || 60) * 1000,
    ).toISOString();
    const nodes = db.all<NodeRow>('SELECT * FROM nodes WHERE disabled_at IS NULL');
    const views: NodeView[] = nodes.map((n) => ({
      name: n.name,
      address: n.address,
      lastSeenAt: n.last_seen_at,
    }));
    const statuses = db
      .all<{ node_id: string; project_id: string; status_json: string }>(
        'SELECT node_id,project_id,status_json FROM node_statuses',
      )
      .map((r) => ({
        node: nodes.find((n) => n.id === r.node_id)?.name ?? r.node_id,
        project: r.project_id,
        status: JSON.parse(r.status_json),
      }));
    return resolveServiceEndpoints(states, views, statuses, staleBefore);
  }
  /** Names of all nodes and of the ingress nodes, for port binding and upstream decisions. */
  function nodeTopology(): { nodes: string[]; ingressNodes: string[] } {
    const rows = db.all<Pick<NodeRow, 'name' | 'ingress'>>(
      'SELECT name,ingress FROM nodes WHERE disabled_at IS NULL ORDER BY name',
    );
    return {
      nodes: rows.map((r) => r.name),
      ingressNodes: rows.filter((r) => r.ingress).map((r) => r.name),
    };
  }
  /** Where this node's published ports listen: the address other nodes and the ingress reach it on, or loopback. */
  function portBindingFor(node: NodeRow, states: DesiredState[]): PortBinding {
    const { nodes, ingressNodes } = nodeTopology();
    const loopback: Record<string, string[]> = {};
    for (const state of states) {
      const services = loopbackIngressServices(state, node.name, ingressNodes, nodes);
      if (services.length) loopback[state.project] = services;
    }
    return { address: node.address || null, loopback };
  }
  function ingressFor(node: NodeRow, states: DesiredState[]) {
    const secrets = new Map<string, string>();
    for (const state of states) {
      for (const svc of Object.values(state.compose.services || {})) {
        const ing = svc['x-tug']?.ingress;
        if (ing?.tls !== 'custom') continue;
        for (const name of [ing.cert, ing.key]) {
          const row = db.get<Pick<SecretRow, 'encrypted_value'>>(
            'SELECT encrypted_value FROM secrets WHERE project_id=? AND name=?',
            state.project,
            name ?? null,
          );
          if (row) secrets.set(`${state.project}/${name}`, decrypt(row.encrypted_value, masterKey));
        }
      }
    }
    return buildIngressWork({
      states,
      endpoints: endpointsFor(states),
      node: node.name,
      ...nodeTopology(),
      secrets,
      acmeEmail: ACME_EMAIL,
      accessLog: INGRESS_ACCESS_LOG,
      domains: db.all<{ project: string; service: string; host: string }>(
        'SELECT project_id AS project, service, host FROM project_domains ORDER BY host',
      ),
    });
  }

  get('/agent/v1/wake', authAgent, async (req, res) => {
    const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0);
    const timeoutMs = Math.min(
      30_000,
      Math.max(0, Number.parseInt(String(req.query.timeout ?? '25000'), 10) || 0),
    );
    db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', now(), 'online', req.node!.id);
    res.json(await wakeHub.wait(req.node!.id, after, timeoutMs));
  });
  get('/agent/v1/work', authAgent, async (req, res) => {
    db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', now(), 'online', req.node!.id);
    const node = db.get<NodeRow>('SELECT * FROM nodes WHERE id=?', req.node!.id)!;
    const allStates = currentDesiredStates();
    const desiredStates = allStates.filter((st) =>
      Object.values(st.services).some(
        (svc) => (svc.placement?.nodes || []).includes(node.name) || !svc.placement?.nodes?.length,
      ),
    );
    // A command past its deadline is never delivered late; the backup scheduler turns it into a missed run.
    advanceWhere(
      db,
      commandLifecycle,
      'pending',
      'expired',
      { sql: 'node_id=? AND deadline IS NOT NULL AND deadline<?', params: [node.id, now()] },
      { updated_at: now() },
    );
    const commands = db.all<CommandRow>(
      'SELECT * FROM commands WHERE node_id=? AND state=?',
      node.id,
      'pending',
    );
    for (const command of commands)
      advance(db, commandLifecycle, command.id, 'pending', 'running', {
        attempts: command.attempts + 1,
        updated_at: now(),
      });
    // A pruned archive refuses rollback, so no node needs its image: leave it off the list and the agent removes it
    // (an image a container still uses is kept regardless).
    const prunedBuilds = new Set(
      db.all<{ id: string }>("SELECT id FROM builds WHERE state='pruned'").map((row) => row.id),
    );
    const retainedImages = [
      ...new Set(
        retainedStates().flatMap((state) =>
          Object.values(state.services)
            .filter(
              (service) =>
                service.artifact &&
                !prunedBuilds.has(service.artifact.buildId) &&
                (!service.placement.nodes?.length || service.placement.nodes.includes(node.name)),
            )
            .map((service) => service.image!),
        ),
      ),
    ];
    const work: WorkResponse = {
      serverTime: now(),
      nodeId: node.id,
      desiredStates,
      commands,
      retainedImages,
    };
    work.ports = portBindingFor(node, desiredStates);
    const holds = restores.holds();
    if (Object.keys(holds).length) work.holds = holds;
    if (SERVICE_DNS) {
      const all = endpointsFor(allStates);
      work.serviceEndpoints = Object.fromEntries(
        desiredStates.map((st) => [st.project, all[st.project] || {}]),
      );
    }
    if (node.ingress) work.ingress = ingressFor(node, allStates);
    res.json(work);
  });
  post('/agent/v1/status', authAgent, async (req, res) => {
    const ts = now();
    let report: StatusReport;
    try {
      report = parseStatusReport(req.body);
    } catch (e) {
      throw httpError(400, errMessage(e));
    }
    for (const st of report.projects) {
      // A node reports only the services currently placed on it; anything else would feed other nodes' work.
      const ds = currentDesired(st.project);
      const desired: DesiredState | undefined = ds ? JSON.parse(ds.state_json) : undefined;
      const placed = Object.entries(desired?.services || {})
        .filter(([, svc]) => svc.placement?.nodes?.includes(req.node!.name))
        .map(([name]) => name);
      if (!placed.length) continue;
      const sanitized: ProjectStatus = {
        ...st,
        ...(st.services && { services: st.services.filter((name) => placed.includes(name)) }),
        ...(st.serviceStates && {
          serviceStates: Object.fromEntries(
            Object.entries(st.serviceStates).filter(([name]) => placed.includes(name)),
          ),
        }),
      };
      const before = db.get<{ status_json: string; health: string }>(
        'SELECT status_json,health FROM node_statuses WHERE node_id=? AND project_id=?',
        req.node!.id,
        st.project,
      );
      const stored = JSON.stringify(sanitized);
      if (before?.status_json !== stored || before?.health !== st.health)
        watch.mark('status', st.project);
      db.run(
        `INSERT INTO node_statuses(id,node_id,project_id,observed_version,status_json,health,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,project_id) DO UPDATE SET observed_version=excluded.observed_version,status_json=excluded.status_json,health=excluded.health,updated_at=excluded.updated_at`,
        id('ns'),
        req.node!.id,
        st.project,
        st.observedVersion,
        stored,
        st.health,
        ts,
      );
    }
    // Commands are resolved under the calling node first: only a running command of this node can be
    // heartbeated or completed, so foreign and already-finished command ids change nothing.
    const runningHere = (commandId: string) =>
      db.get<Pick<CommandRow, 'id'>>(
        "SELECT id FROM commands WHERE id=? AND node_id=? AND state='running'",
        commandId,
        req.node!.id,
      );
    const jobs = (report.jobs || []).filter((job) => runningHere(job.commandId));
    if (jobs.length) backups.onHeartbeat(jobs);
    for (const cr of report.commandResults) {
      if (!runningHere(cr.commandId)) continue;
      backups.onResult(cr.commandId, cr.state, cr.result);
      advanceWhere(
        db,
        commandLifecycle,
        'running',
        cr.state,
        { sql: 'id=? AND node_id=?', params: [cr.commandId, req.node!.id] },
        { result_json: JSON.stringify(cr.result), updated_at: ts },
      );
    }
    if (report.ingress)
      db.run(
        'UPDATE nodes SET ingress_status_json=? WHERE id=? AND ingress=1 AND disabled_at IS NULL',
        JSON.stringify({ ...report.ingress, reportedAt: ts }),
        req.node!.id,
      );
    db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', ts, 'online', req.node!.id);
    if (report.sentAt)
      db.run(
        'UPDATE nodes SET clock_skew_ms=?,clock_observed_at=? WHERE id=?',
        Date.parse(report.sentAt) - Date.parse(ts),
        ts,
        req.node!.id,
      );
    // Ingress-only nodes can acknowledge routing without reporting any project; recheck
    // every active rollout after all project and ingress observations have been stored.
    for (const deployment of db.all<{ project_id: string }>(
      "SELECT DISTINCT project_id FROM deployments WHERE state='rolling_out'",
    ))
      updateDeploymentConvergence(deployment.project_id);
    try {
      restores.advance();
    } catch (e) {
      console.error(`restore failed to advance: ${errMessage(e)}`);
    }
    const nextEndpointSnapshot = JSON.stringify(endpointsFor(currentDesiredStates()));
    if (nextEndpointSnapshot !== endpointSnapshot) {
      endpointSnapshot = nextEndpointSnapshot;
      wakeAll();
    }
    res.json({ ok: true });
  });
  /**
   * Events from an agent, by HTTP or over its stream socket, into the one event log. Fields are coerced and bounded, and
   * the node is whichever one the connection belongs to. An event names a project only if that project currently places
   * a service on this node (the rule status reports already follow); otherwise it is stored without one, as a node-level
   * event, so an agent cannot put rows in another project's log, where that project's scoped readers and watchers would
   * see them. A deployment id is kept only if it belongs to the project the event ends up in.
   */
  function ingestEvents(nodeId: string, input: unknown[]): void {
    const text = (value: unknown, max: number): string | null =>
      typeof value === 'string' && value ? value.slice(0, max) : null;
    const nodeName = db.get<{ name: string }>('SELECT name FROM nodes WHERE id=?', nodeId)?.name;
    const placed = new Map<string, boolean>();
    const placesHere = (project: string): boolean => {
      let known = placed.get(project);
      if (known === undefined) {
        const row = currentDesired(project);
        const desired: DesiredState | undefined = row ? JSON.parse(row.state_json) : undefined;
        known = Object.values(desired?.services ?? {}).some(
          (service) => nodeName !== undefined && service.placement?.nodes?.includes(nodeName),
        );
        placed.set(project, known);
      }
      return known;
    };
    for (const raw of input.slice(0, 100)) {
      if (!objectFrame(raw)) continue;
      const ev = raw as AgentEvent;
      const claimed = text(ev.projectId, 128);
      const project = claimed && placesHere(claimed) ? claimed : null;
      const claimedDeployment = text(ev.deploymentId, 128);
      const deployment =
        project &&
        claimedDeployment &&
        db.get<{ project_id: string }>(
          'SELECT project_id FROM deployments WHERE id=?',
          claimedDeployment,
        )?.project_id === project
          ? claimedDeployment
          : null;
      const metadata = JSON.stringify(objectFrame(ev.metadata) ? ev.metadata : {});
      db.run(
        'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id('evt'),
        project,
        deployment,
        nodeId,
        text(ev.level, 16) ?? 'info',
        text(ev.type, 100) ?? 'event',
        text(ev.message, 8000) ?? '',
        metadata.length <= 16_384 ? metadata : '{}',
        now(),
      );
    }
    if (Date.now() - lastEventPrune >= eventPruneIntervalMs)
      try {
        pruneEvents();
      } catch (e) {
        console.error(`event pruning failed: ${errMessage(e)}`);
      }
  }
  post('/agent/v1/events', authAgent, async (req, res) => {
    ingestEvents(req.node!.id, Array.isArray(req.body.events) ? req.body.events : [req.body]);
    res.json({ ok: true });
  });
  // Credentials for a backup helper are released only while its command is running on the calling node, and
  // never ride in the command payload, events or results.
  get('/agent/v1/backup/credentials', authAgent, async (req, res) => {
    const command = db.get<Pick<CommandRow, 'node_id' | 'project_id' | 'type' | 'state'>>(
      'SELECT node_id,project_id,type,state FROM commands WHERE id=?',
      String(req.query.command || ''),
    );
    if (!command) return res.status(404).json({ error: 'command not found' });
    if (command.node_id !== req.node!.id)
      return res.status(403).json({ error: 'command belongs to another node' });
    if (!(BACKUP_COMMAND_TYPES as readonly string[]).includes(command.type))
      return res.status(403).json({ error: 'command does not use backup credentials' });
    if (command.state !== 'running')
      return res.status(409).json({ error: `command is ${command.state}, not running` });
    if (!command.project_id || !backupDestination())
      return res.status(409).json({ error: 'no backup destination is configured' });
    // A command that outlived the project's placement on this node (a newer version moved it) gets nothing.
    const desiredRow = currentDesired(command.project_id);
    const desiredNow: DesiredState | undefined = desiredRow
      ? JSON.parse(desiredRow.state_json)
      : undefined;
    const placedHere = Object.values(desiredNow?.services || {}).some((svc) =>
      svc.placement?.nodes?.includes(req.node!.name),
    );
    if (!placedHere)
      return res.status(403).json({ error: 'project is no longer placed on this node' });
    const response: BackupCredentialsResponse = {
      env: {
        ...backupEnv(),
        RESTIC_PASSWORD: repositoryPassword(masterKey, command.project_id),
      },
    };
    res.json(response);
  });
  get('/agent/v1/secrets', authAgent, async (req, res) => {
    const project = String(req.query.project || 'site');
    let rows = db.all<Pick<SecretRow, 'name' | 'encrypted_value' | 'version'>>(
      'SELECT name,encrypted_value,version FROM secrets WHERE project_id=?',
      project,
    );
    const ds = currentDesired(project);
    const desired: DesiredState | undefined = ds ? JSON.parse(ds.state_json) : undefined;
    const requested = req.query.services
      ? String(req.query.services)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : Object.keys(desired?.services || {});
    const names = requested.filter((name) =>
      desired?.services[name]?.placement.nodes?.includes(req.node!.name),
    );
    const allowed = serviceSecretNames(desired?.compose, names);
    const registrySecret = rows.find((row) => row.name === REGISTRY_AUTH_SECRET);
    const registryAuth: NonNullable<SecretsResponse['registryAuth']> = {};
    const credentials = parseRegistryCredentials(
      registrySecret ? decrypt(registrySecret.encrypted_value, masterKey) : undefined,
    );
    for (const name of names) {
      const spec = desired!.services[name];
      if (!spec.artifact && spec.image) {
        const host = imageLocation(spec.image).host;
        if (credentials[host]) registryAuth[host] = credentials[host];
      }
    }
    rows = rows.filter((row) => allowed.has(row.name) && row.name !== REGISTRY_AUTH_SECRET);
    const secrets: SecretsResponse = {
      secrets: Object.fromEntries(rows.map((r) => [r.name, decrypt(r.encrypted_value, masterKey)])),
      versions: Object.fromEntries(rows.map((r) => [r.name, r.version])),
      ...(Object.keys(registryAuth).length ? { registryAuth } : {}),
    };
    res.json(secrets);
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    sendError(res, error);
  });
  return app;
}

/** Attaches the agent and operator WebSocket upgrade handling to `server`; `listen` uses it on the mTLS listener. */
export function attachAgentStream(app: express.Express, server: http.Server | https.Server): void {
  const runtime = streamRuntimes.get(app);
  if (!runtime) throw new Error('control app is missing its stream runtime');
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_MAX_FRAME_BYTES });
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // Match exact origin-form paths so parsing a request target cannot throw during upgrade.
    const pathname = request.url?.split('?', 1)[0];
    if (
      pathname !== '/agent/v1/stream' &&
      pathname !== '/api/v1/live' &&
      pathname !== '/api/v1/watch'
    ) {
      reject(404, 'Not Found');
      return;
    }
    void (async () => {
      // The same current-state check as every HTTP request.
      const identity = runtime.isRestoring() ? null : runtime.identify(request);
      if (!identity) {
        reject(401, 'Unauthorized');
        return;
      }
      if (pathname === '/api/v1/watch') {
        // Read-only, and open to every operator credential (the same role as `status`).
        if (identity.klass !== 'operator' || !hasRole(identity.actor, 'read')) {
          reject(403, 'Forbidden');
          return;
        }
        const actor = identity.actor;
        if (runtime.watch.admits(actor) !== 'ok') {
          reject(429, 'Too Many Watchers');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => runtime.watch.subscribe(actor, ws));
      } else if (pathname === '/api/v1/live') {
        if (identity.klass !== 'operator') {
          reject(403, 'Forbidden');
          return;
        }
        if (!hasRole(identity.actor, 'deploy')) {
          reject(403, 'Forbidden');
          return;
        }
        const actor = identity.actor;
        wss.handleUpgrade(request, socket, head, (ws) => runtime.live.operator(actor, ws));
      } else {
        if (identity.klass !== 'node') {
          reject(403, 'Forbidden');
          return;
        }
        const node = identity.node;
        wss.handleUpgrade(request, socket, head, (ws) => {
          runtime.live.agent(node.id, ws);
          runtime.hub.connect(node.id, ws);
        });
      }
    })().catch(() => reject(500, 'Internal Server Error'));
  });
  server.once('close', () => {
    runtime.watch.closeAll();
    wss.close();
  });
}

/** Loads the persisted server credential, or issues one when it is missing, for different names or two thirds expired. */
async function ensureServerCredential(
  pki: Pki,
  dir: string,
  names: ReturnType<typeof serverNames>,
  force = false,
): Promise<{ cert: string; key: string; renewed: boolean }> {
  const file = path.join(dir, 'pki', 'server.json');
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
      cert: string;
      key: string;
      names: string;
    };
    const x = new (await import('node:crypto')).X509Certificate(saved.cert);
    const lifetime = Date.parse(x.validTo) - Date.parse(x.validFrom);
    const age = Date.now() - Date.parse(x.validFrom);
    const signedByCa = x.verify(
      new (await import('node:crypto')).X509Certificate(pki.caPem).publicKey,
    );
    if (!force && signedByCa && saved.names === namesKey(names) && age < (lifetime * 2) / 3)
      return { cert: saved.cert, key: saved.key, renewed: false };
  } catch {
    /* Missing or unreadable: issue a new one. */
  }
  const issued = await pki.issueServer(names);
  await writeFileDurable(
    file,
    JSON.stringify({ cert: issued.cert, key: issued.key, names: namesKey(names) }),
  );
  return { cert: issued.cert, key: issued.key, renewed: true };
}

/**
 * Starts the single mTLS listener. Chain validation rejects missing or foreign client certificates during the handshake;
 * the secureConnection gate then checks current database state, and every request checks it again.
 */
export async function listen(app: express.Express, port = PORT): Promise<https.Server> {
  const pki = app.locals.pki as Pki;
  const dataDir = app.locals.dataDir as string;
  const advertised = app.locals.controlUrl as string | undefined;
  if (!advertised)
    throw new Error(
      'TUG_CONTROL_URL is required: the credential-free https origin clients connect to',
    );
  const url = new URL(advertised);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'TUG_CONTROL_URL must be a credential-free https origin such as https://control.example.com:8443',
    );
  const names = serverNames(advertised, (process.env.TUG_EXTRA_SANS || '').split(','));
  const credential = await ensureServerCredential(pki, dataDir, names);
  const server = https.createServer(
    serverTlsOptions({ cert: credential.cert, key: credential.key, ca: pki.caPem }),
    app,
  );
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 30_000;
  attachAgentStream(app, server);
  const runtime = streamRuntimes.get(app)!;
  const liveSockets = app.locals.liveSockets as Set<{
    socket: import('node:tls').TLSSocket;
    uri: string;
    keyHash: string;
    notAfter: number;
  }>;
  server.on('tlsClientError', (error) => {
    console.warn(`tls handshake refused: ${errMessage(error)}`.slice(0, 200));
  });
  // Connection authorization gate: after a full handshake, refuse reused sessions and identities the database does not authorize.
  server.on('secureConnection', (socket) => {
    // After a restore the database is closed until restart: refuse everything, and never let the gate throw.
    let presented: ReturnType<typeof peerIdentity> = null;
    try {
      if (!runtime.isRestoring() && !socket.isSessionReused()) presented = peerIdentity(socket);
      if (presented && !runtime.resolvePrincipal(presented.uri, presented.keyHash))
        presented = null;
    } catch {
      presented = null;
    }
    if (!presented) {
      socket.destroy();
      return;
    }
    const entry = { socket, ...presented };
    liveSockets.add(entry);
    socket.once('close', () => liveSockets.delete(entry));
  });
  // Out-of-process changes (host-side root recovery) are noticed within a second; renewal reloads the secure context.
  const sweep = setInterval(() => {
    try {
      (app.locals.reconcileSockets as () => void)();
    } catch (e) {
      console.error(`session sweep failed: ${errMessage(e)}`);
    }
  }, 1000);
  const renew = setInterval(
    () => {
      ensureServerCredential(pki, dataDir, names)
        .then((next) => {
          if (next.renewed) {
            server.setSecureContext(
              serverTlsOptions({ cert: next.cert, key: next.key, ca: pki.caPem }),
            );
            console.log('server certificate renewed');
          }
          const left = pki.caNotAfter.getTime() - Date.now();
          if (left < 90 * 86_400_000)
            console.warn(`control CA expires in ${Math.floor(left / 86_400_000)} days`);
        })
        .catch((e) => console.error(`server certificate renewal failed: ${errMessage(e)}`));
    },
    Math.min(SERVER_LIFETIME_MS / 90, 3_600_000),
  );
  sweep.unref();
  renew.unref();
  server.once('close', () => {
    (app.locals.stopBackupScheduler as () => void)();
    clearInterval(sweep);
    clearInterval(renew);
  });
  return new Promise((resolve) =>
    server.listen(port, () => {
      console.log(`tug-control listening on ${port} (mTLS)`);
      resolve(server);
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) createApp().then((app) => listen(app));
