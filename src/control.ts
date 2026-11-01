#!/usr/bin/env node
import express from 'express';
import {
  resolveImage,
  parseRegistryCredentials,
  imageLocation,
  REGISTRY_AUTH_SECRET,
} from './registry.ts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { saveImageArchive, inspectImage, validateImageArchive, hashArchive } from './artifacts.ts';
import type { ArchiveInfo } from './artifacts.ts';
import { scanArchive } from './archive.ts';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as tar from 'tar';
import { openDb, openSnapshotDb } from './db.ts';
import { isUniqueViolation } from './db-driver.ts';
import type {
  CommandRow,
  DeploymentRow,
  DesiredStateRow,
  EnrollTokenRow,
  LockRow,
  NodeRow,
  ProjectRow,
  SecretRow,
  VolumeRow,
  WgPeerRow,
} from './db.ts';
import { encrypt, decrypt, loadOrCreateMasterKey } from './secrets.ts';
import {
  buildDesiredState,
  loopbackIngressServices,
  serviceSecretNames,
  validateCompose,
} from './compose.ts';
import { buildImage, unpackContext, run as runCommand } from './build.ts';
import { sentinelNames } from './normalize.ts';
import { ensureDir, errMessage, hashToken, id, now, token } from './util.ts';
import {
  DEFAULT_MESH_CIDR,
  DEFAULT_WG_PORT,
  WG_INTERFACE,
  WG_KEEPALIVE,
  allocateOverlayIp,
  isWgKey,
  parseCidr,
  wgEndpoint,
} from './mesh.ts';
import { buildIngressWork, resolveServiceEndpoints } from './ingress.ts';
import type { NodeView } from './ingress.ts';
import {
  ACTIVE_DEPLOYMENT_STATES,
  LIVE_MAX_FRAME_BYTES,
  LIVE_MAX_BUFFERED_BYTES,
  LIVE_MAX_SESSIONS,
  LIVE_START_TIMEOUT_MS,
} from './protocol.ts';
import {
  AUTO_ROLLBACK_ACTOR,
  ROUTE_ROLES,
  PROJECT_NAME_PATTERN,
  authenticate,
  hasRole,
  assertProject,
  bodyProject,
  createGuard,
  createToken,
  listTokens,
  parseTokenRequest,
  queryProject,
  recordEvent,
  revokeToken,
} from './tokens.ts';
import type { Actor, ProjectResolver, RouteRole } from './tokens.ts';
import type {
  LiveRequest,
  LiveInput,
  OperatorLiveMessage,
  ImageArtifact,
  LocalImageUpload,
  AgentEvent,
  CommandResult,
  CommandType,
  ComposeFile,
  DesiredState,
  EnrollRequest,
  EnrollResponse,
  NetworkConfig,
  NodeInfo,
  PortBinding,
  RegisterResponse,
  SecretsResponse,
  ServiceEndpoints,
  StatusReport,
  StreamMessage,
  WakeResponse,
  WgKeyRequest,
  WorkResponse,
} from './protocol.ts';

class WakeHub {
  private readonly cursors = new Map<string, number>();
  private readonly projects = new Map<string, string | undefined>();
  private readonly streams = new Map<string, WebSocket>();
  private readonly waiters = new Map<string, Set<() => void>>();

  cursor(nodeId: string): number {
    return this.cursors.get(nodeId) ?? 0;
  }

  connect(nodeId: string, ws: WebSocket): void {
    const previous = this.streams.get(nodeId);
    if (previous && previous !== ws) previous.close(1000, 'replaced by a newer agent connection');
    this.streams.set(nodeId, ws);
    const ready: StreamMessage = { type: 'ready', nodeId, cursor: this.cursor(nodeId) };
    ws.send(JSON.stringify(ready));
    ws.once('close', () => {
      if (this.streams.get(nodeId) === ws) this.streams.delete(nodeId);
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
    frameKeys(value, [...common, 'service', 'command', 'interactive', 'tty', 'columns', 'rows']) &&
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
class LiveHub {
  private readonly agents = new Map<string, WebSocket>();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly retired = new WeakMap<WebSocket, Set<string>>();
  private readonly startTimeoutMs: number;
  private readonly resolve: (actor: Actor, request: LiveRequest) => Promise<NodeRow>;
  constructor(
    resolve: (actor: Actor, request: LiveRequest) => Promise<NodeRow>,
    startTimeoutMs = LIVE_START_TIMEOUT_MS,
  ) {
    this.resolve = resolve;
    this.startTimeoutMs = startTimeoutMs;
  }
  private send(ws: WebSocket, frame: unknown): boolean {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > LIVE_MAX_BUFFERED_BYTES)
      return false;
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) + ws.bufferedAmount > LIVE_MAX_BUFFERED_BYTES) return false;
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
        if (!objectFrame(frame) || frame.v !== 1 || typeof frame.sessionId !== 'string')
          throw new Error('invalid frame');
        const session = this.sessions.get(frame.sessionId);
        if (!session && this.retired.get(ws)?.has(frame.sessionId)) return;
        if (!session || session.agent !== ws) throw new Error('foreign or unknown session');
        const keys = ['v', 'type', 'sessionId'];
        if (frame.type === 'live.started' && frameKeys(frame, keys) && !session.started) {
          session.started = true;
          clearTimeout(session.timer);
          if (
            !this.send(session.operator, {
              v: 1,
              type: 'live.started',
              sessionId: session.id,
              node: session.node,
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
  authenticate(token: string): NodeRow | undefined;
  authenticateOperator(token: string): Actor | null;
  live: LiveHub;
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
function deploymentFailureMessage(rows: { node_id: string; status_json: string }[]): string {
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
    return detail ? `${row.node_id}: ${detail}` : row.node_id;
  });
  return `one or more assigned nodes reported failed health: ${details.join('; ')}`;
}

/** Versions of rollback deployments start with this; `tug deploy` may not use it, which is how automatic rollback tells them apart. */
const ROLLBACK_VERSION_PREFIX = 'rollback-';
const ACTIVE_STATES_SQL = ACTIVE_DEPLOYMENT_STATES.map((s) => `'${s}'`).join(',');

const PORT = Number(process.env.PORT || 8080);

export interface ControlImageOperations {
  resolve: typeof resolveImage;
  build: typeof buildImage;
  save: typeof saveImageArchive;
  inspect: typeof inspectImage;
  validate: typeof validateImageArchive;
  run: typeof runCommand;
}
export async function createApp(
  options: {
    images?: Partial<ControlImageOperations>;
    openDatabase?: typeof openDb;
    /** Minimum time between event prunes triggered by agent reports; default one hour. */ eventPruneIntervalMs?: number;
    /** Override the live open/agent startup timeout in milliseconds. */ liveStartTimeoutMs?: number;
  } = {},
) {
  const images: ControlImageOperations = {
    resolve: resolveImage,
    build: buildImage,
    save: saveImageArchive,
    inspect: inspectImage,
    validate: validateImageArchive,
    run: runCommand,
    ...options.images,
  };
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
  // Networking layers are opt-in; with all of them off the work response is unchanged.
  const MESH = process.env.TUG_MESH === 'true';
  const MESH_CIDR = process.env.TUG_MESH_CIDR || DEFAULT_MESH_CIDR;
  const WG_PORT = Number(process.env.TUG_WG_PORT || DEFAULT_WG_PORT);
  const SERVICE_DNS = (process.env.TUG_SERVICE_DNS ?? String(MESH)) === 'true';
  const ACME_EMAIL = process.env.TUG_ACME_EMAIL || undefined;
  if (MESH) parseCidr(MESH_CIDR);

  const db = await (options.openDatabase || openDb)(dbFile);
  const wakeHub = new WakeHub();

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
  const operator = db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash');
  if (!operator) {
    const t = process.env.TUG_OPERATOR_TOKEN || token('tug_op');
    db.run('INSERT INTO meta(key,value) VALUES(?,?)', 'operator_token_hash', hashToken(t));
    await fs
      .writeFile(path.join(DATA_DIR, 'operator.token'), `${t}\n`, { mode: 0o600 })
      .catch(() => {});
    console.log(`operator token: ${t}`);
  }

  const app = express();
  const authenticateAgent = (raw: string): NodeRow | undefined =>
    raw
      ? db.get<NodeRow>('SELECT * FROM nodes WHERE agent_token_hash=?', hashToken(raw))
      : undefined;
  let restartRequired = false;
  app.use((_req, res, next) =>
    restartRequired
      ? res.status(503).json({ error: 'control restored; restart required', restartRequired: true })
      : next(),
  );
  app.use(express.json({ limit: '20mb' }));
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

  // Operator-facing routes go through api(): the role table in tokens.ts is the only place a route's access is declared.
  const guard = createGuard(db);
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
    db.get<{ project_id: string }>('SELECT project_id FROM deployments WHERE id=?', req.params.id)
      ?.project_id;
  const commandProject: ProjectResolver = (req) => {
    const row = db.get<{ project_id: string | null }>(
      'SELECT project_id FROM commands WHERE id=?',
      req.params.id,
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
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const node = authenticateAgent(raw);
    if (!node) return res.status(401).json({ error: 'unauthorized' });
    req.node = node;
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
    const statuses = db.all<{
      node_id: string;
      observed_version: string;
      health: string;
      status_json: string;
    }>(
      'SELECT node_id,observed_version,health,status_json FROM node_statuses WHERE project_id=?',
      projectId,
    );
    const byNode = new Map(statuses.map((s) => [s.node_id, s]));
    const reportsRevision = (node: string) =>
      state.revision
        ? JSON.parse(byNode.get(node)?.status_json || '{}').observedRevision === state.revision
        : byNode.get(node)?.observed_version === state.version;
    const failedNodes = [...required]
      .filter((node) => reportsRevision(node) && byNode.get(node)?.health === 'failed')
      .map((node) => byNode.get(node)!);
    if (failedNodes.length) {
      const marked = db.run(
        'UPDATE deployments SET state=?,error_message=?,updated_at=? WHERE id=? AND state=?',
        'failed',
        deploymentFailureMessage(failedNodes),
        now(),
        project.current_deployment_id,
        'rolling_out',
      );
      if (marked.changes === 1)
        scheduleAutoRollback(projectId, project.current_deployment_id, state);
    }
    const ok = [...required].every(
      (node) =>
        (state.revision
          ? JSON.parse(byNode.get(node)?.status_json || '{}').observedRevision === state.revision
          : byNode.get(node)?.observed_version === state.version) &&
        ['serving', 'skipped'].includes(byNode.get(node)?.health ?? ''),
    );
    if (ok)
      db.run(
        'UPDATE deployments SET state=?,updated_at=? WHERE id=? AND state=?',
        'succeeded',
        now(),
        project.current_deployment_id,
        'rolling_out',
      );
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
  function createRollback(
    project: string,
    opts: { actor: string; force?: boolean; auto?: boolean; failedDeploymentId?: string },
  ): { deployment: DeploymentRow | undefined; desiredState: DesiredState } {
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
      const ts = now();
      const depId = id('dep');
      const previousState: DesiredState = JSON.parse(previousDs.state_json);
      previousState.revision = depId;
      db.run(
        'INSERT INTO deployments(id,project_id,version,state,created_at,updated_at,actor) VALUES(?,?,?,?,?,?,?)',
        depId,
        project,
        `${ROLLBACK_VERSION_PREFIX}${previousState.version}-${Date.now()}`,
        'rolling_out',
        ts,
        ts,
        opts.actor,
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
        deployment: db.get<DeploymentRow>('SELECT * FROM deployments WHERE id=?', depId),
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

  const live = new LiveHub(async (actor, request) => {
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
    return node;
  }, options.liveStartTimeoutMs);
  streamRuntimes.set(app, {
    hub: wakeHub,
    authenticate: authenticateAgent,
    authenticateOperator: (raw) => authenticate(db, raw),
    live,
  });
  api('get', '/api/v1/live', null, (_req, res) => {
    res.status(426).json({ error: 'WebSocket upgrade required' });
  });

  function acquireProjectLock(
    project: string,
    operation: string,
    ttlMs = Number(process.env.TUG_LOCK_TTL_MS || 10 * 60 * 1000),
  ) {
    const name = `project:${project}`;
    const ts = now();
    db.run('DELETE FROM locks WHERE expires_at < ?', ts);
    const owner = `${operation}:${id('lock')}`;
    try {
      db.run(
        'INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)',
        name,
        owner,
        new Date(Date.now() + ttlMs).toISOString(),
        ts,
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = db.get<LockRow>('SELECT * FROM locks WHERE name=?', name);
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
          db.run(
            'UPDATE locks SET expires_at=? WHERE name=? AND owner=?',
            new Date(Date.now() + ttlMs).toISOString(),
            name,
            owner,
          );
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
        db.run('DELETE FROM locks WHERE name=? AND owner=?', lock.name, lock.owner);
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
      'SELECT name,labels_json,last_seen_at FROM nodes ORDER BY created_at,name',
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
    const global = ext.global === true || placement.global === true;
    const labels = Array.isArray(placement.labels) ? placement.labels : [];
    const matched = nodeInfos.filter((node) =>
      labels.every((label) => node.labels.includes(label)),
    );
    const pool = labels.length ? matched : nodeInfos;
    if (!pool.length)
      throw httpError(
        400,
        labels.length
          ? 'no healthy nodes match the service placement labels'
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
  get('/healthz', (req, res) => res.json({ ok: true }));

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
    (req) => req.params.project,
    async (req, res) => res.json(db.get('SELECT * FROM projects WHERE id=?', req.params.project)),
  );

  /** A node whose agent has been seen before but not within TUG_STALE_SECONDS; never-seen (just registered) nodes stay schedulable. */
  const isStale = (row: { last_seen_at: string | null }) =>
    !!row.last_seen_at &&
    Date.parse(row.last_seen_at) < Date.now() - Number(process.env.TUG_STALE_SECONDS || 60) * 1000;
  const NODE_INFO_SQL =
    'SELECT id,name,address,public_address,overlay_ip,labels_json,status,created_at,updated_at FROM nodes WHERE id=?';

  /** Allocates the node's stable overlay IP on first registration (retrying if a concurrent register took it). */
  function ensureOverlayIp(nodeId: string): void {
    if (!MESH) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = db.get<Pick<NodeRow, 'overlay_ip'>>(
        'SELECT overlay_ip FROM nodes WHERE id=?',
        nodeId,
      );
      if (row?.overlay_ip) return;
      const used = db
        .all<{ overlay_ip: string }>('SELECT overlay_ip FROM nodes WHERE overlay_ip IS NOT NULL')
        .map((r) => r.overlay_ip);
      try {
        db.run(
          'UPDATE nodes SET overlay_ip=? WHERE id=? AND overlay_ip IS NULL',
          allocateOverlayIp(MESH_CIDR, used),
          nodeId,
        );
        return;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new Error('could not allocate an overlay address');
  }
  /** Stores (or refreshes) the node's WireGuard peer entry; the private key never reaches control. */
  function syncWgPeer(nodeId: string, publicKey?: string): void {
    if (!MESH) return;
    const node = db.get<NodeRow>('SELECT * FROM nodes WHERE id=?', nodeId);
    const existing = db.get<WgPeerRow>('SELECT * FROM wg_peers WHERE node_id=?', nodeId);
    const key = publicKey ?? existing?.public_key;
    if (!node?.overlay_ip || !key) return;
    db.run(
      `INSERT INTO wg_peers(node_id,public_key,overlay_ip,endpoint,allowed_ips,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET public_key=excluded.public_key,overlay_ip=excluded.overlay_ip,endpoint=excluded.endpoint,allowed_ips=excluded.allowed_ips,updated_at=excluded.updated_at`,
      nodeId,
      key,
      node.overlay_ip,
      wgEndpoint(node.public_address, WG_PORT) ?? null,
      `${node.overlay_ip}/32`,
      now(),
    );
  }

  async function registerNode({
    name,
    address,
    publicAddress,
    wgPublicKey,
    labels,
  }: {
    name: string;
    address?: string;
    publicAddress?: string;
    wgPublicKey?: string;
    labels?: string[];
  }): Promise<RegisterResponse> {
    if (wgPublicKey !== undefined && !isWgKey(wgPublicKey))
      throw httpError(400, 'wgPublicKey must be a base64 WireGuard public key');
    const agentToken = token('tug_agent');
    const ts = now();
    db.run(
      `INSERT INTO nodes(id,name,address,public_address,status,labels_json,agent_token_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,public_address=excluded.public_address,labels_json=excluded.labels_json,agent_token_hash=excluded.agent_token_hash,updated_at=excluded.updated_at`,
      name,
      name,
      address || null,
      publicAddress || null,
      'registered',
      JSON.stringify(Array.isArray(labels) ? labels : []),
      hashToken(agentToken),
      ts,
      ts,
    );
    ensureOverlayIp(name);
    syncWgPeer(name, wgPublicKey);
    wakeAll();
    const row = db.get<NodeRow>(NODE_INFO_SQL, name);
    if (!row) throw httpError(500, 'node not found after registration');
    const node: NodeInfo = {
      id: row.id,
      name: row.name,
      address: row.address,
      public_address: row.public_address,
      overlay_ip: row.overlay_ip,
      labels: row.labels_json ? (JSON.parse(row.labels_json) as string[]) : [],
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { node, agentToken };
  }
  api('post', '/api/v1/nodes/register', null, async (req, res) => {
    const name = req.body.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      res.json(
        await registerNode({
          name,
          address: req.body.address,
          publicAddress: req.body.publicAddress,
          wgPublicKey: req.body.wgPublicKey,
          labels: req.body.labels,
        }),
      );
    } catch (e) {
      sendError(res, e);
    }
  });

  // Self-service enrollment: operator mints a short-lived, limited-use key; the agent
  // exchanges it for durable credentials on first boot (Portainer Edge-style join).
  api('post', '/api/v1/nodes/enroll-token', null, async (req, res) => {
    const name = req.body.name || null;
    const ttlSeconds = Math.max(1, Number(req.body.ttlSeconds ?? 3600));
    const uses = Math.max(1, Number(req.body.uses ?? 1));
    const enrollToken = token('tug_enroll');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.run(
      'INSERT INTO enroll_tokens(token_hash,name,uses_remaining,expires_at,created_at) VALUES(?,?,?,?,?)',
      hashToken(enrollToken),
      name,
      uses,
      expiresAt,
      now(),
    );
    res.json({ enrollToken, name, usesRemaining: uses, expiresAt });
  });
  post('/agent/v1/enroll', async (req, res) => {
    const body: EnrollRequest = req.body;
    const raw = String(
      body.enrollToken || (req.headers.authorization || '').replace(/^Bearer /, ''),
    ).trim();
    if (!raw) return res.status(400).json({ error: 'enrollToken required' });
    const row = db.get<EnrollTokenRow>(
      'SELECT * FROM enroll_tokens WHERE token_hash=?',
      hashToken(raw),
    );
    if (!row || row.uses_remaining < 1 || row.expires_at < now()) {
      if (row) db.run('DELETE FROM enroll_tokens WHERE token_hash=?', hashToken(raw));
      return res.status(401).json({ error: 'invalid or expired enroll token' });
    }
    const name = row.name || body.name;
    if (!name)
      return res
        .status(400)
        .json({ error: 'node name required (bind one to the enroll token or send name)' });
    let result: RegisterResponse;
    try {
      result = await registerNode({
        name,
        address: body.address,
        publicAddress: body.publicAddress,
        wgPublicKey: body.wgPublicKey,
        labels: body.labels,
      });
    } catch (e) {
      return sendError(res, e);
    }
    const remaining = row.uses_remaining - 1;
    if (remaining < 1) db.run('DELETE FROM enroll_tokens WHERE token_hash=?', hashToken(raw));
    else
      db.run(
        'UPDATE enroll_tokens SET uses_remaining=? WHERE token_hash=?',
        remaining,
        hashToken(raw),
      );
    const enrolled: EnrollResponse = { ...result };
    res.json(enrolled);
  });
  api('get', '/api/v1/nodes', null, async (req, res) => {
    const rows = db.all<NodeRow>(
      'SELECT id,name,address,public_address,overlay_ip,ingress,ingress_status_json,status,labels_json,last_seen_at,created_at,updated_at FROM nodes ORDER BY name',
    );
    res.json({
      nodes: rows.map((row) => {
        const { labels_json, ...rest } = row;
        return { ...rest, labels: labels_json ? (JSON.parse(labels_json) as string[]) : [] };
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
      null,
      ts,
      ts,
    );
    wakeHub.wake(nodeId, projectId ?? undefined);
    return commandId;
  }
  // The private key lives only on the node, so rotation is a command the agent executes: it
  // generates a new keypair, reports the public key and peers pick it up from their next work response.
  api('post', '/api/v1/nodes/:name/rotate-wg-key', null, async (req, res) => {
    if (!MESH)
      return res.status(409).json({ error: 'the WireGuard mesh is not enabled (TUG_MESH=true)' });
    const node = findNode(req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    res.json({ commandId: queueCommand(node.id, null, 'wg.rotate-key'), nodeId: node.id });
  });
  // Removes a retired node: its token, WireGuard peer, statuses and queued commands. Refused while a current deployment still places
  // something on it (redeploy without it first) or while its agent is still reporting, unless force=true.
  api('delete', '/api/v1/nodes/:name', null, async (req, res) => {
    const node = db.get<Pick<NodeRow, 'id' | 'name' | 'last_seen_at'>>(
      'SELECT id,name,last_seen_at FROM nodes WHERE name=? OR id=?',
      req.params.name,
      req.params.name,
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
    db.run('DELETE FROM wg_peers WHERE node_id=?', node.id);
    db.run('DELETE FROM nodes WHERE id=?', node.id);
    audit(req.actor!, {
      type: 'node.removed',
      message: `node ${node.name} removed`,
      metadata: { node: node.name },
    });
    wakeAll();
    res.json({ ok: true, node: node.name });
  });
  api('post', '/api/v1/nodes/:name/ingress', null, async (req, res) => {
    const node = findNode(req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    const enabled = req.body.enabled !== false;
    db.run('UPDATE nodes SET ingress=?,updated_at=? WHERE id=?', enabled ? 1 : 0, now(), node.id);
    wakeHub.wake(node.id);
    res.json({ ok: true, node: node.name, ingress: enabled });
  });
  post('/agent/v1/wireguard/key', authAgent, async (req, res) => {
    if (!MESH) return res.status(409).json({ error: 'the WireGuard mesh is not enabled' });
    const { publicKey }: Partial<WgKeyRequest> = req.body;
    if (!isWgKey(publicKey))
      return res.status(400).json({ error: 'publicKey must be a base64 WireGuard public key' });
    try {
      syncWgPeer(req.node!.id, publicKey);
      wakeAll();
      res.json({ ok: true });
    } catch (e) {
      sendError(
        res,
        isUniqueViolation(e) ? httpError(409, 'public key already registered to another node') : e,
      );
    }
  });
  api('post', '/api/v1/tokens', null, async (req, res) => {
    const request = parseTokenRequest(req.body);
    const created = createToken(db, request, req.actor!.name);
    audit(req.actor!, {
      type: 'token.create',
      message: `token ${created.name} (${created.role}${created.projects ? `, projects: ${created.projects.join(', ')}` : ''}) created by ${req.actor!.name}`,
      metadata: {
        name: created.name,
        role: created.role,
        projects: created.projects,
        expiresAt: created.expiresAt,
      },
    });
    res.json(created);
  });
  api('get', '/api/v1/tokens', null, async (_req, res) => res.json({ tokens: listTokens(db) }));
  api('delete', '/api/v1/tokens/:name', null, async (req, res) => {
    if (!revokeToken(db, req.params.name))
      return res.status(404).json({ error: 'token not found' });
    audit(req.actor!, {
      type: 'token.revoke',
      message: `token ${req.params.name} revoked by ${req.actor!.name}`,
      metadata: { name: req.params.name },
    });
    res.json({ ok: true, name: req.params.name });
  });

  api('post', '/api/v1/secrets', bodyProject, async (req, res) => {
    const { project = 'site', name, value } = req.body;
    if (!name || value == null) return res.status(400).json({ error: 'name and value required' });
    let lock;
    try {
      lock = acquireProjectLock(project, 'secret.set');
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
    res.json({
      secrets: db.all(
        'SELECT project_id,name,version,updated_at FROM secrets WHERE project_id=? ORDER BY name',
        String(req.query.project || 'site'),
      ),
    }),
  );
  api('delete', '/api/v1/secrets/:name', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    const removed = db.run(
      'DELETE FROM secrets WHERE project_id=? AND name=?',
      project,
      req.params.name,
    );
    if (removed.changes) {
      wakeAll(project);
      audit(req.actor!, {
        type: 'secret.delete',
        project,
        message: `secret ${req.params.name} deleted by ${req.actor!.name}`,
        metadata: { name: req.params.name },
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
        "SELECT 1 FROM deployments WHERE id=? AND state IN ('uploading','building')",
        row.deployment_id,
      );
      if (active) continue;
      await fs.rm(
        path.join(DATA_DIR, row.artifact_path || path.join('images', `${row.id}.tar.gz`)),
        { force: true },
      );
      await images.run('docker', ['image', 'rm', row.image_ref]).catch(() => {});
      db.run('DELETE FROM builds WHERE id=?', row.id);
    }
    const remaining = db.all<{ id: string }>('SELECT id FROM builds');
    const owned = new Set(remaining.flatMap((row) => [`${row.id}.tar.gz`, `${row.id}.tar.gz.tmp`]));
    for (const name of await fs.readdir(artifactDir))
      if (!owned.has(name)) await fs.rm(path.join(artifactDir, name), { force: true });
  }
  // Previous-process builds cannot finish after a restart; clear their unpublished files.
  db.run(
    "UPDATE deployments SET state='build_failed',error_message='control restarted during build' WHERE state IN ('uploading','building')",
  );
  await collectArtifacts();
  const receiveDeployment = upload.any();
  api('post', '/api/v1/deployments', null, (req, res) => {
    receiveDeployment(req, res, (error) => {
      void withWriter(() => deployRequest(req, res, error)).catch(async (failure) => {
        const files = Array.isArray(req.files) ? req.files : [];
        await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
        sendError(res, failure);
      });
    });
  });
  async function deployRequest(req: Request, res: Response, uploadError?: unknown): Promise<void> {
    const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
    let responseBody: unknown;
    let responseError: unknown;
    let lock: Awaited<ReturnType<typeof acquireProjectLock>> | undefined;
    let depId: string | undefined;
    let contextDir: string | undefined;
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
        'SELECT name,labels_json,last_seen_at,created_at FROM nodes ORDER BY created_at,name',
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
          placement?: { nodes?: string[]; labels?: string[]; global?: boolean };
          replicas?: number;
          global?: boolean;
        };
        const placement = ext.placement || {};
        const global = ext.global === true || placement.global === true;
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
      try {
        validateCompose(
          compose,
          nodes.map((n) => n.name),
        );
      } catch (e) {
        throw httpError(400, errMessage(e));
      }
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
            `secrets not found in project ${project}: ${missing.join(', ')}; create them with tug secret-set`,
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
              `${svcName}: custom TLS secret ${secret} not found in project ${project}; set it with secret-set first`,
            );
      }
      lock = acquireProjectLock(project, 'deploy');
      const active = db.get<DeploymentRow>(
        `SELECT * FROM deployments WHERE project_id=? AND state IN (${ACTIVE_STATES_SQL}) LIMIT 1`,
        project,
      );
      if (active) throw httpError(409, `deployment ${active.id} is already ${active.state}`);
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
        'INSERT INTO deployments(id,project_id,version,state,created_at,updated_at,actor) VALUES(?,?,?,?,?,?,?)',
        depId,
        project,
        version,
        'building',
        ts,
        ts,
        req.actor!.name,
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
            const imported = await images.inspect(item.imageRef);
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
          info = await images.save(imageRef, temporary);
          await fs.rename(temporary, final);
          const artifact: ImageArtifact = { buildId, imageRef, ...info };
          spec.artifact = artifact;
          db.run(
            'UPDATE builds SET state=?,image_id=?,platform=?,sha256=?,size_bytes=?,artifact_path=?,updated_at=? WHERE id=?',
            'complete',
            info.imageId,
            info.platform,
            info.sha256,
            info.sizeBytes,
            relative,
            now(),
            buildId,
          );
        } finally {
          if (importedClientRef)
            await images.run('docker', ['image', 'rm', importedClientRef]).catch(() => {});
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
        const owned = db.get(
          'SELECT 1 FROM locks WHERE name=? AND owner=? AND expires_at>?',
          buildLock.name,
          buildLock.owner,
          now(),
        );
        const pending = db.get(
          'SELECT 1 FROM deployments WHERE id=? AND state=?',
          publishingId,
          'building',
        );
        if (!owned || !pending)
          throw httpError(409, 'deployment was cancelled or its build lease was lost');
        db.exec('BEGIN IMMEDIATE');
        try {
          const published = db.run(
            "UPDATE deployments SET state='rolling_out',updated_at=? WHERE id=? AND state='building'",
            now(),
            publishingId,
          );
          if (
            published.changes !== 1 ||
            !db.get(
              'SELECT 1 FROM locks WHERE name=? AND owner=? AND expires_at>?',
              buildLock.name,
              buildLock.owner,
              now(),
            )
          )
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
          db.exec('COMMIT');
        } catch (e) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* Preserve the publication error. */
          }
          throw e;
        }
      });
      audit(req.actor!, {
        type: 'deploy',
        project,
        deploymentId: depId,
        message: `deployment ${depId} (${version}) started by ${req.actor!.name}`,
        metadata: { version },
      });
      wakeAll(project);
      responseBody = {
        deployment: { id: depId, project, version, state: 'rolling_out', actor: req.actor!.name },
        desiredState: desired,
      };
    } catch (e) {
      if (depId)
        try {
          db.run(
            "UPDATE deployments SET state='build_failed',error_message=?,updated_at=? WHERE id=? AND state='building'",
            errMessage(e),
            now(),
            depId,
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
  }
  get('/agent/v1/images/:buildId', authAgent, async (req, res) => {
    const states = retainedStates();
    const allowed = states.some((state) =>
      Object.values(state.services).some(
        (service) =>
          service.artifact?.buildId === req.params.buildId &&
          (!service.placement.nodes?.length || service.placement.nodes.includes(req.node!.name)),
      ),
    );
    if (!allowed) return res.status(404).json({ error: 'image not found' });
    const row = db.get<BuildRow>(
      'SELECT * FROM builds WHERE id=? AND state=?',
      req.params.buildId,
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
    res.json(db.get('SELECT * FROM deployments WHERE id=?', req.params.id)),
  );
  api('post', '/api/v1/deployments/:id/cancel', deploymentProject, async (req, res) =>
    withPublication(() => {
      const row = db.get<DeploymentRow>('SELECT * FROM deployments WHERE id=?', req.params.id);
      if (!row) return res.status(404).json({ error: 'deployment not found' });
      if (!(ACTIVE_DEPLOYMENT_STATES as readonly string[]).includes(row.state))
        return res.status(409).json({ error: `deployment is ${row.state}` });
      const result = db.run(
        `UPDATE deployments SET state=?,updated_at=? WHERE id=? AND state IN (${ACTIVE_STATES_SQL})`,
        'cancelled',
        now(),
        req.params.id,
      );
      if (result.changes !== 1)
        return res.status(409).json({ error: 'deployment is no longer active' });
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
  api('get', '/api/v1/volumes', queryProject, async (req, res) =>
    res.json({
      volumes: db.all(
        'SELECT * FROM volumes WHERE project_id=? ORDER BY name',
        String(req.query.project || 'site'),
      ),
    }),
  );
  api('delete', '/api/v1/volumes/:name', queryProject, async (req, res) => {
    const project = String(req.query.project || 'site');
    const deleteData = String(req.query.deleteData || 'false') === 'true';
    let lock;
    try {
      lock = deleteData ? acquireProjectLock(project, 'volume.delete') : null;
      const volume = db.get<VolumeRow>(
        'SELECT * FROM volumes WHERE project_id=? AND name=?',
        project,
        req.params.name,
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
              (v) => (typeof v === 'string' ? v.split(':')[0] : v.source) === req.params.name,
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
          volume: req.params.name,
        });
      }
      db.run('DELETE FROM volumes WHERE project_id=? AND name=?', project, req.params.name);
      res.json({ ok: true, commandId, deletedMetadata: true, deleteData });
    } catch (e) {
      sendError(res, e);
    } finally {
      releaseLock(lock);
    }
  });
  api('post', '/api/v1/control/backups/run', null, async (req, res) =>
    withWriter(async () => {
      const backupDir =
        process.env.TUG_CONTROL_BACKUP_DIR || path.join(DATA_DIR, 'control-backups');
      await ensureDir(backupDir);
      const ts = now();
      const backupId = id('cbak');
      const staging = path.join(backupDir, `${backupId}-staging`);
      await fs.rm(staging, { recursive: true, force: true });
      await ensureDir(staging);
      const snapshotPath = path.join(staging, 'tug.db');
      db.run('VACUUM INTO ?', snapshotPath);
      await fs.copyFile(masterKeyFile, path.join(staging, 'master.key'));
      await fs.cp(artifactDir, path.join(staging, 'images'), { recursive: true });
      await fs.writeFile(
        path.join(staging, 'metadata.json'),
        JSON.stringify({ backupId, createdAt: ts, type: 'control' }, null, 2),
      );
      const artifactRef = path.resolve(backupDir, `${backupId}.tar.gz`);
      await tar.c({ gzip: true, file: artifactRef, cwd: staging }, [
        'tug.db',
        'master.key',
        'metadata.json',
        'images',
      ]);
      await fs.rm(staging, { recursive: true, force: true });
      db.run(
        'INSERT INTO backups(id,project_id,target,node_id,state,artifact_ref,metadata_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)',
        backupId,
        '_control',
        'control-plane',
        null,
        'completed',
        artifactRef,
        JSON.stringify({ type: 'control' }),
        ts,
        now(),
      );
      res.json({ backupId, artifactRef, state: 'completed' });
    }),
  );
  api('post', '/api/v1/control/restore', null, async (req, res) =>
    withWriter(async () => {
      if (!req.body.confirm)
        return res.status(400).json({
          error: 'confirm=true is required; restore overwrites control data then requires restart',
        });
      const artifactRef = req.body.artifactRef;
      if (typeof artifactRef !== 'string' || !artifactRef)
        return res.status(400).json({ error: 'artifactRef required' });
      const restoreDir =
        process.env.TUG_CONTROL_RESTORE_DIR || path.join(DATA_DIR, 'control-restore');
      let snapshot;
      try {
        await fs.rm(restoreDir, { recursive: true, force: true });
        await ensureDir(restoreDir);
        await scanArchive(artifactRef, (entry) => {
          if (
            path.isAbsolute(entry.path) ||
            entry.path.split('/').includes('..') ||
            !['File', 'Directory'].includes(entry.type)
          )
            throw new Error('unsafe control backup entry');
        });
        await tar.x({ file: artifactRef, cwd: restoreDir, strict: true });
        const key = (await fs.readFile(path.join(restoreDir, 'master.key'), 'utf8')).trim();
        if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('invalid backup master key');
        snapshot = openSnapshotDb(path.join(restoreDir, 'tug.db'));
        const integrity = snapshot.get('PRAGMA integrity_check');
        if (integrity?.integrity_check !== 'ok')
          throw new Error('backup database failed integrity check');
        if (!snapshot.get("SELECT 1 FROM meta WHERE key='operator_token_hash'"))
          throw new Error('backup database has no operator identity');
        for (const secret of snapshot.all<SecretRow>('SELECT * FROM secrets'))
          decrypt(secret.encrypted_value, key);
        const states = snapshot.all<DesiredStateRow>('SELECT * FROM desired_states');
        for (const stateRow of states) {
          const state: DesiredState = JSON.parse(stateRow.state_json);
          for (const service of Object.values(state.services)) {
            if (!service.artifact) continue;
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
        snapshot.close();
        snapshot = undefined;
        await ensureDir(path.join(restoreDir, 'images'));
        // Validation completes before changing any live file. Stop DB-dependent work until restart.
        restartRequired = true;
        db.close();
        await fs.rm(`${dbFile}-wal`, { force: true });
        await fs.rm(`${dbFile}-shm`, { force: true });
        await fs.cp(path.join(restoreDir, 'images'), artifactDir, { recursive: true });
        await fs.copyFile(path.join(restoreDir, 'tug.db'), dbFile);
        await fs.copyFile(path.join(restoreDir, 'master.key'), masterKeyFile);
        res.json({ ok: true, restored: true, restartRequired: true });
      } catch (e) {
        try {
          snapshot?.close();
        } catch {
          /* Preserve the restore error. */
        }
        res.status(restartRequired ? 500 : 400).json({ error: errMessage(e), restartRequired });
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
    res.json(db.get('SELECT * FROM commands WHERE id=?', req.params.id)),
  );
  api('get', '/api/v1/status', null, async (req, res) => {
    const staleSeconds = Number(process.env.TUG_STALE_SECONDS || 60);
    const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
    db.run(
      "UPDATE nodes SET status='stale',updated_at=? WHERE last_seen_at IS NOT NULL AND last_seen_at < ?",
      now(),
      cutoff,
    );
    const projects = projectScope(req.actor!, 'id');
    const deployments = projectScope(req.actor!, 'project_id');
    const statuses = projectScope(req.actor!, 'project_id');
    res.json({
      projects: db.all(`SELECT * FROM projects WHERE ${projects.where}`, ...projects.args),
      deployments: db.all(
        `SELECT * FROM deployments WHERE ${deployments.where} ORDER BY created_at DESC LIMIT 20`,
        ...deployments.args,
      ),
      nodes: db.all('SELECT id,name,status,last_seen_at FROM nodes'),
      statuses: db.all(`SELECT * FROM node_statuses WHERE ${statuses.where}`, ...statuses.args),
    });
  });
  api('get', '/api/v1/events', null, async (req, res) => {
    const project = req.query.project ? String(req.query.project) : null;
    if (project) assertProject(req.actor!, project);
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const scope = projectScope(req.actor!, 'project_id'); // scoped tokens never see node-level or other projects' events
    const events = project
      ? db.all(
          'SELECT * FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT ?',
          project,
          limit,
        )
      : db.all(
          `SELECT * FROM events WHERE ${scope.where} ORDER BY created_at DESC LIMIT ?`,
          ...scope.args,
          limit,
        );
    res.json({ events });
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
    await check('operator_token', async () => ({
      configured: Boolean(db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash')),
    }));
    await check('master_key', async () => ({ configured: Boolean(masterKey) }));
    await check('docker', async () => ({
      output: (
        await runCommand('docker', ['version', '--format', '{{.Server.Version}}'])
      ).out.trim(),
    }));
    await check('docker_compose', async () => ({
      output: (await runCommand('docker', ['compose', 'version'])).out.trim(),
    }));
    if (MESH) {
      await check('mesh', async () => {
        const nodes = db.all<{ name: string; overlay_ip: string | null; has_key: number }>(
          'SELECT n.name, n.overlay_ip, EXISTS(SELECT 1 FROM wg_peers w WHERE w.node_id=n.id) AS has_key FROM nodes n',
        );
        const missing = nodes.filter((n) => !n.has_key).map((n) => n.name);
        if (missing.length)
          throw new Error(
            `nodes without a reported WireGuard key (is TUG_MESH=true on their agents?): ${missing.join(', ')}`,
          );
        return { cidr: MESH_CIDR, port: WG_PORT, nodes: nodes.length };
      });
    }
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
    const nodes = db.all<NodeRow & { has_key: number }>(
      'SELECT n.*, EXISTS(SELECT 1 FROM wg_peers w WHERE w.node_id=n.id) AS has_key FROM nodes n',
    );
    const views: NodeView[] = nodes.map((n) => ({
      name: n.name,
      overlayIp: MESH && n.has_key ? n.overlay_ip : null,
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
  function networkFor(node: NodeRow): NetworkConfig | undefined {
    if (!MESH || !node.overlay_ip) return undefined;
    const peers = db.all<WgPeerRow & { name: string }>(
      'SELECT w.*, n.name FROM wg_peers w JOIN nodes n ON n.id=w.node_id WHERE w.node_id != ? ORDER BY n.name',
      node.id,
    );
    return {
      interface: WG_INTERFACE,
      overlayIp: node.overlay_ip,
      cidr: MESH_CIDR,
      listenPort: WG_PORT,
      peers: peers.map((p) => ({
        node: p.name,
        publicKey: p.public_key,
        endpoint: p.endpoint ?? undefined,
        allowedIps: p.allowed_ips.split(','),
        persistentKeepalive: WG_KEEPALIVE,
      })),
    };
  }
  /** Names of all nodes and of the ingress nodes, for port binding and upstream decisions. */
  function nodeTopology(): { nodes: string[]; ingressNodes: string[] } {
    const rows = db.all<Pick<NodeRow, 'name' | 'ingress'>>(
      'SELECT name,ingress FROM nodes ORDER BY name',
    );
    return {
      nodes: rows.map((r) => r.name),
      ingressNodes: rows.filter((r) => r.ingress).map((r) => r.name),
    };
  }
  /** Where this node's published ports listen: the address other nodes and the ingress reach it on, or loopback. */
  function portBindingFor(node: NodeRow, states: DesiredState[]): PortBinding {
    const hasKey =
      MESH && node.overlay_ip && db.get('SELECT 1 FROM wg_peers WHERE node_id=?', node.id);
    const { nodes, ingressNodes } = nodeTopology();
    const loopback: Record<string, string[]> = {};
    for (const state of states) {
      const services = loopbackIngressServices(state, node.name, ingressNodes, nodes);
      if (services.length) loopback[state.project] = services;
    }
    return { address: (hasKey ? node.overlay_ip : node.address) || null, loopback };
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
    const commands = db.all<CommandRow>(
      'SELECT * FROM commands WHERE node_id=? AND state=?',
      node.id,
      'pending',
    );
    if (commands.length)
      db.run(
        `UPDATE commands SET state='running',attempts=attempts+1,updated_at=? WHERE node_id=? AND state='pending'`,
        now(),
        node.id,
      );
    const retainedImages = [
      ...new Set(
        retainedStates().flatMap((state) =>
          Object.values(state.services)
            .filter(
              (service) =>
                service.artifact &&
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
    const network = networkFor(node);
    if (network) work.network = network;
    work.ports = portBindingFor(node, desiredStates);
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
    const report: Partial<StatusReport> = req.body;
    for (const st of report.projects || []) {
      db.run(
        `INSERT INTO node_statuses(id,node_id,project_id,observed_version,status_json,health,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,project_id) DO UPDATE SET observed_version=excluded.observed_version,status_json=excluded.status_json,health=excluded.health,updated_at=excluded.updated_at`,
        id('ns'),
        req.node!.id,
        st.project,
        st.observedVersion,
        JSON.stringify(st),
        st.health || 'unknown',
        ts,
      );
      updateDeploymentConvergence(st.project);
    }
    for (const cr of (report.commandResults || []) as Partial<CommandResult>[]) {
      const result = cr.result || {};
      db.run(
        'UPDATE commands SET state=?,result_json=?,updated_at=? WHERE id=? AND node_id=?',
        cr.state || 'succeeded',
        JSON.stringify(result),
        ts,
        cr.commandId ?? null,
        req.node!.id,
      );
    }
    if (report.ingress)
      db.run(
        'UPDATE nodes SET ingress_status_json=? WHERE id=?',
        JSON.stringify({ ...report.ingress, reportedAt: ts }),
        req.node!.id,
      );
    db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', ts, 'online', req.node!.id);
    const nextEndpointSnapshot = JSON.stringify(endpointsFor(currentDesiredStates()));
    if (nextEndpointSnapshot !== endpointSnapshot) {
      endpointSnapshot = nextEndpointSnapshot;
      wakeAll();
    }
    res.json({ ok: true });
  });
  post('/agent/v1/events', authAgent, async (req, res) => {
    const evs: AgentEvent[] = req.body.events || [req.body];
    for (const ev of evs)
      db.run(
        'INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id('evt'),
        ev.projectId || null,
        ev.deploymentId || null,
        req.node!.id,
        ev.level || 'info',
        ev.type || 'event',
        ev.message || '',
        JSON.stringify(ev.metadata || {}),
        now(),
      );
    if (Date.now() - lastEventPrune >= eventPruneIntervalMs)
      try {
        pruneEvents();
      } catch (e) {
        console.error(`event pruning failed: ${errMessage(e)}`);
      }
    res.json({ ok: true });
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

function attachAgentStream(app: express.Express, server: http.Server | https.Server): void {
  const runtime = streamRuntimes.get(app);
  if (!runtime) throw new Error('control app is missing its stream runtime');
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_MAX_FRAME_BYTES });
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!['/agent/v1/stream', '/api/v1/live'].includes(pathname)) {
      reject(404, 'Not Found');
      return;
    }
    const raw = String(request.headers.authorization || '').replace(/^Bearer /, '');
    void (async () => {
      if (pathname === '/api/v1/live') {
        const actor = runtime.authenticateOperator(raw);
        if (!actor) {
          reject(401, 'Unauthorized');
          return;
        }
        if (!hasRole(actor, 'deploy')) {
          reject(403, 'Forbidden');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => runtime.live.operator(actor, ws));
      } else {
        const node = runtime.authenticate(raw);
        if (!node) {
          reject(401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          runtime.live.agent(node.id, ws);
          runtime.hub.connect(node.id, ws);
        });
      }
    })().catch(() => reject(500, 'Internal Server Error'));
  });
  server.once('close', () => wss.close());
}

export async function listen(
  app: express.Express,
  port = PORT,
): Promise<http.Server | https.Server> {
  const certFile = process.env.TUG_TLS_CERT_FILE;
  const keyFile = process.env.TUG_TLS_KEY_FILE;
  if (certFile && keyFile) {
    const [cert, key] = await Promise.all([fs.readFile(certFile), fs.readFile(keyFile)]);
    const server = https.createServer({ cert, key }, app);
    attachAgentStream(app, server);
    return new Promise((resolve) =>
      server.listen(port, () => {
        console.log(`tug-control listening on ${port} (tls)`);
        resolve(server);
      }),
    );
  }
  console.warn('TUG_TLS_CERT_FILE/TUG_TLS_KEY_FILE not set; serving plain HTTP');
  const server = http.createServer(app);
  attachAgentStream(app, server);
  return new Promise((resolve) =>
    server.listen(port, () => {
      console.log(`tug-control listening on ${port}`);
      resolve(server);
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) createApp().then((app) => listen(app));
