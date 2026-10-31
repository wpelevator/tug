#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateImageArchive, verifyDownload } from './artifacts.ts';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns/promises';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { addressBoundServices, isRolling, serviceSecretVersions } from './compose.ts';
import { containerSpecs, networkName, volumeName } from './container-spec.ts';
import { API_VERSION, DockerEngine, isNotFound } from './docker-api.ts';
import type { ContainerSummary, DockerApi } from './docker-api.ts';
import type { PortBind } from './compose.ts';
import { LIVE_MAX_FRAME_BYTES, LIVE_START_TIMEOUT_MS } from './protocol.ts';
import type {
  AgentLiveCommand,
  AgentLiveFrame,
  LiveRequest as ProtocolLiveRequest,
} from './protocol.ts';
import { LiveOperationEngine } from './live.ts';
import type { LiveEngineOptions } from './live.ts';
import {
  activeRollingStates,
  clearRolloutState,
  ensureProjectResources,
  loadRolloutState,
  projectContainers,
  reconcileRecreate,
  reconcileRolling,
  sweepOrphans,
} from './reconciler.ts';
import { ensureDir, errMessage, isPublicAddress, now, parseDuration } from './util.ts';
import { openAgentDb } from './db.ts';
import type { AppliedStateRow, Db, EventStateRow } from './db.ts';
import { createHostRunner } from './runners.ts';
import type { HostRunner, HttpClient } from './runners.ts';
import { CADDY_CONTAINER, reconcileIngress, removeIngress } from './ingress.ts';
import {
  WG_INTERFACE,
  ensureWgKeys,
  readReportedKey,
  reconcileMesh,
  rotateWgKeys,
  writeReportedKey,
} from './mesh.ts';
import type {
  Command,
  CommandResult,
  DesiredState,
  DiagnosticCheck,
  EnrollResponse,
  HealthCheck,
  IngressStatus,
  JoinKey,
  ProjectStatus,
  ImageArtifact,
  PortBinding,
  SecretsResponse,
  ServiceEndpoint,
  ServiceState,
  StatusReport,
  WakeResponse,
  WorkResponse,
} from './protocol.ts';

const CONTROL_URL_FROM_ENV = Boolean(process.env.TUG_CONTROL_URL);
let CONTROL_URL = process.env.TUG_CONTROL_URL || 'http://localhost:8080';
let TOKEN: string | undefined = process.env.TUG_AGENT_TOKEN;
let NODE_NAME = process.env.TUG_NODE_NAME || process.env.HOSTNAME || 'node1';
const STATE_DIR = process.env.TUG_STATE_DIR || '/var/lib/tug';
const APPLY = process.env.TUG_APPLY !== 'false';
const INTERVAL = Number(process.env.TUG_POLL_INTERVAL_MS || 5000);
// Opt-in WireGuard mesh: needs `wg`/`ip` in the agent image, host networking and NET_ADMIN.
const MESH = process.env.TUG_MESH === 'true';

// Everything the reconcile/command logic needs from the outside world. Production wiring is
// `defaultContext()`; tests pass a fake `docker` runner / `http` client and temp dirs.
export interface AgentContext {
  docker: DockerApi;
  http: HttpClient;
  nodeName: string;
  stateDir: string;
  apply: boolean;
  controlUrl: string;
  token: string | undefined;
  /** Runs `wg` / `ip` for the mesh. */
  host?: HostRunner;
  /** Manage the WireGuard mesh (generate a key, report it, reconcile `wg0`). */
  mesh?: boolean;
  caddyImage?: string;
  /** Host port range (`LOW-HIGH`) for rolling-rollout revisions; default 20000-20999. */
  rolloutPorts?: string;
}

export function defaultContext(): AgentContext {
  return {
    docker: new DockerEngine(),
    http: fetch,
    nodeName: NODE_NAME,
    stateDir: STATE_DIR,
    apply: APPLY,
    controlUrl: CONTROL_URL,
    token: TOKEN,
    host: createHostRunner(),
    mesh: MESH,
    caddyImage: process.env.TUG_CADDY_IMAGE,
    rolloutPorts: process.env.TUG_ROLLOUT_PORTS,
  };
}

const dbsByStateDir = new Map<string, Db>();
async function agentDb(stateDir: string): Promise<Db> {
  let db = dbsByStateDir.get(stateDir);
  if (!db) {
    await ensureDir(stateDir);
    db = await openAgentDb(path.join(stateDir, 'agent.db'));
    dbsByStateDir.set(stateDir, db);
  }
  return db;
}

function authHeaders(ctx: AgentContext): Record<string, string> {
  if (!ctx.token) throw new Error('TUG_AGENT_TOKEN required');
  return { Authorization: `Bearer ${ctx.token}` };
}
async function api<T = unknown>(
  ctx: AgentContext,
  route: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await ctx.http(`${ctx.controlUrl}${route}`, {
    ...opts,
    headers: {
      ...authHeaders(ctx),
      ...((opts.headers as Record<string, string> | undefined) || {}),
    },
  });
  if (!res.ok)
    throw new Error(`${opts.method || 'GET'} ${route}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type AgentLiveControlFrame = AgentLiveCommand;
export type AgentLiveOutputFrame = AgentLiveFrame;
type LiveAgentRequest = ProtocolLiveRequest & { sessionId: string };
interface LiveChannelHandlers {
  onLive?: (frame: AgentLiveControlFrame) => void | Promise<void>;
  onDisconnect?: () => void;
}

type WebSocketFactory = (url: string, token: string) => WebSocket;

/** Keeps one outbound stream open and falls back to a bounded HTTP wait when an intermediary rejects WebSockets. */
export class AgentWakeChannel {
  private readonly ctx: AgentContext;
  private readonly createSocket: WebSocketFactory;
  private socket?: WebSocket;
  private cursor = 0;
  private pending = false;
  private waiter?: () => void;
  private readonly handlers: LiveChannelHandlers;

  constructor(
    ctx: AgentContext,
    createSocket: WebSocketFactory = (url, token) =>
      new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: LIVE_MAX_FRAME_BYTES,
      }),
    handlers: LiveChannelHandlers = {},
  ) {
    this.ctx = ctx;
    this.createSocket = createSocket;
    this.handlers = handlers;
  }

  private notify(): void {
    this.pending = true;
    this.waiter?.();
  }

  private async connect(): Promise<boolean> {
    if (this.socket?.readyState === WebSocket.OPEN) return true;
    if (!this.ctx.token) throw new Error('TUG_AGENT_TOKEN required');
    const url = new URL('/agent/v1/stream', this.ctx.controlUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve) => {
      let settled = false;
      const socket = this.createSocket(url.toString(), this.ctx.token!);
      this.socket = socket;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(connected);
      };
      const timer = setTimeout(() => {
        socket.terminate();
        finish(false);
      }, 1500);
      socket.on('open', () => finish(true));
      socket.on('message', (data) => {
        if (this.socket !== socket) return;
        let message: unknown;
        const json = data.toString();
        if (Buffer.byteLength(json) > LIVE_MAX_FRAME_BYTES) {
          this.close();
          return;
        }
        try {
          message = JSON.parse(json);
        } catch {
          return;
        }
        if (!message || typeof message !== 'object') return;
        const frame = message as Record<string, unknown>;
        if (typeof frame.type === 'string' && frame.type.startsWith('live.')) {
          if (frame.v === 1)
            void Promise.resolve(this.handlers.onLive?.(message as AgentLiveControlFrame)).catch(
              (error) => console.error('agent live frame failed:', errMessage(error)),
            );
          return;
        }
        if (
          (frame.type !== 'ready' && frame.type !== 'work-available') ||
          !Number.isSafeInteger(frame.cursor) ||
          Number(frame.cursor) < 0
        )
          return;
        this.cursor = Math.max(this.cursor, Number(frame.cursor));
        if (frame.type === 'work-available') this.notify();
      });
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.handlers.onDisconnect?.();
        }
        if (settled) this.waiter?.();
        else finish(false);
      });
      socket.on('error', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.handlers.onDisconnect?.();
        }
        socket.terminate();
        this.waiter?.();
        finish(false);
      });
    });
  }

  private async waitOnSocket(timeoutMs: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.waiter === done) this.waiter = undefined;
        resolve();
      };
      this.waiter = done;
      const timer = setTimeout(done, timeoutMs);
    });
    this.pending = false;
  }

  private async longPoll(timeoutMs: number): Promise<void> {
    const wake = await api<WakeResponse>(
      this.ctx,
      `/agent/v1/wake?after=${this.cursor}&timeout=${Math.min(timeoutMs, 30_000)}`,
    );
    this.cursor = Math.max(this.cursor, wake.cursor);
  }

  async wait(timeoutMs: number): Promise<void> {
    if (await this.connect()) return this.waitOnSocket(timeoutMs);
    await this.longPoll(timeoutMs);
  }

  send(frame: AgentLiveOutputFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 1048576) {
      this.close();
      socket.terminate();
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.handlers.onDisconnect?.();
    socket?.close();
    this.waiter?.();
  }
}
interface PendingLiveSession {
  ready: Promise<void>;
  queuedBytes: number;
}

/** Resolves a service once before starting a process so rollouts cannot silently retarget an open session. */
export async function resolveLiveContainer(
  ctx: AgentContext,
  request: { project: string; service?: string },
): Promise<string> {
  const name = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
  if (
    !name.test(request.project) ||
    request.project === '..' ||
    !request.service ||
    !name.test(request.service)
  )
    throw new Error('A valid project and service are required');
  const state = await loadRolloutState(path.join(ctx.stateDir, 'projects', request.project));
  const rolling = state.services[request.service];
  if (rolling && !rolling.active) throw new Error('Rolling service has no active revision');
  const containers = await projectContainers(ctx.docker, request.project, request.service);
  // A rolling service has the draining revision beside the serving one; only the serving one is addressed.
  const candidates = rolling?.active
    ? containers.filter((c) => c.Names.includes(`/${rolling.active!.container}`))
    : containers;
  if (candidates.length !== 1)
    throw new Error(
      candidates.length
        ? 'Service has multiple containers; select an unambiguous service'
        : 'Service has no container on this node',
    );
  if (!/^[a-f0-9]{12,64}$/.test(candidates[0].Id))
    throw new Error('Docker returned an invalid container ID');
  return candidates[0].Id;
}

export class AgentLiveOperations {
  private readonly ctx: AgentContext;
  private readonly emit: (frame: AgentLiveOutputFrame) => void;
  private readonly engine: LiveOperationEngine;
  private readonly sessions = new Map<string, PendingLiveSession>();
  constructor(
    ctx: AgentContext,
    emit: (frame: AgentLiveOutputFrame) => void,
    options: Omit<LiveEngineOptions, 'emit' | 'docker'> = {},
  ) {
    this.ctx = ctx;
    this.emit = emit;
    this.engine = new LiveOperationEngine({
      docker: ctx.docker,
      ...options,
      emit: (event) => {
        if (!this.sessions.has(event.sessionId)) return;
        if (event.type === 'exit') this.sessions.delete(event.sessionId);
        if (event.type === 'output')
          this.emit({
            v: 1,
            type: 'live.output',
            sessionId: event.sessionId,
            stream: event.stream,
            data: event.data,
          });
        else if (event.type === 'result')
          this.emit({
            v: 1,
            type: 'live.result',
            sessionId: event.sessionId,
            result: event.result,
          });
        else this.emit({ ...event, v: 1, type: 'live.exit' });
      },
    });
  }
  async handle(frame: AgentLiveControlFrame): Promise<void> {
    if (
      frame.v !== 1 ||
      typeof frame.sessionId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(frame.sessionId)
    )
      return;
    if (frame.type === 'live.open') {
      // An existing open belongs to its original request; replaying it must not start another process.
      if (this.sessions.has(frame.sessionId)) return;
      const entry: PendingLiveSession = { ready: Promise.resolve(), queuedBytes: 0 };
      this.sessions.set(frame.sessionId, entry);
      entry.ready = this.open({ ...frame.request, sessionId: frame.sessionId }, entry);
      await entry.ready;
      return;
    }
    const entry = this.sessions.get(frame.sessionId);
    if (!entry) return;
    if (frame.type === 'live.cancel') {
      this.engine.cancel(frame.sessionId);
      if (this.sessions.delete(frame.sessionId))
        this.emit({
          v: 1,
          type: 'live.exit',
          sessionId: frame.sessionId,
          code: null,
          signal: null,
          cancelled: true,
        });
      return;
    }
    let queued = 0;
    try {
      let input: Buffer | undefined;
      if (frame.type === 'live.stdin') {
        if (typeof frame.data !== 'string' || frame.data.length > 87384)
          throw new Error('Invalid stdin frame');
        input = Buffer.from(frame.data, 'base64');
        if (input.toString('base64') !== frame.data || input.length > 65536)
          throw new Error('Invalid base64 stdin');
        queued = input.length;
        entry.queuedBytes += queued;
        if (entry.queuedBytes > 262144) throw new Error('Live stdin queue exceeds size limit');
      }
      await entry.ready;
      if (this.sessions.get(frame.sessionId) !== entry) return;
      if (frame.type === 'live.stdin' && input) this.engine.stdin(frame.sessionId, input);
      else if (frame.type === 'live.stdin-end') this.engine.endStdin(frame.sessionId);
      else if (frame.type === 'live.resize')
        this.engine.resize(frame.sessionId, frame.columns, frame.rows);
    } catch (error) {
      this.fail(frame.sessionId, entry, error);
    } finally {
      entry.queuedBytes -= queued;
    }
  }
  dispose(): void {
    const ids = [...this.sessions.keys()];
    this.engine.dispose();
    for (const id of ids)
      if (this.sessions.delete(id))
        this.emit({
          v: 1,
          type: 'live.exit',
          sessionId: id,
          code: null,
          signal: null,
          cancelled: true,
        });
  }
  private fail(id: string, entry: PendingLiveSession, error: unknown): void {
    if (this.sessions.get(id) !== entry) return;
    this.sessions.delete(id);
    this.emit({
      v: 1,
      type: 'live.exit',
      sessionId: id,
      code: null,
      signal: null,
      cancelled: false,
      error: errMessage(error),
    });
    this.engine.cancel(id);
  }
  private async open(request: LiveAgentRequest, entry: PendingLiveSession): Promise<void> {
    const current = () => this.sessions.get(request.sessionId) === entry;
    const started = () => this.emit({ v: 1, type: 'live.started', sessionId: request.sessionId });
    try {
      if (this.sessions.size > 16) throw new Error('Live session limit reached');
      if (!this.ctx.apply) throw new Error('Live operations require an applying agent');
      if (request.node && request.node !== this.ctx.nodeName)
        throw new Error('Live request selected a different node');
      if (
        typeof request.project !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(request.project)
      )
        throw new Error('Invalid project');
      if (request.operation === 'ps') {
        // A query's result and exit follow `started` immediately, so announce it first.
        started();
        await this.engine.start({
          operation: 'ps',
          sessionId: request.sessionId,
          projects: [request.project],
        });
        return;
      }
      if (!['exec', 'logs', 'inspect'].includes(request.operation))
        throw new Error('Invalid live operation');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let container: string;
      try {
        container = await Promise.race([
          resolveLiveContainer(this.ctx, request),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Live container resolution timed out')),
              LIVE_START_TIMEOUT_MS,
            );
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!current()) return;
      if (request.operation === 'inspect') {
        started();
        await this.engine.start({ operation: 'inspect', sessionId: request.sessionId, container });
        return;
      }
      if (request.operation === 'exec')
        await this.engine.start({
          operation: 'exec',
          sessionId: request.sessionId,
          container,
          command: request.command,
          interactive: request.interactive,
          tty: request.tty,
          columns: request.columns,
          rows: request.rows,
        });
      else
        await this.engine.start({
          operation: 'logs',
          sessionId: request.sessionId,
          container,
          tail: request.tail,
        });
      if (current()) started();
      else this.engine.cancel(request.sessionId);
    } catch (error) {
      this.fail(request.sessionId, entry, error);
    }
  }
}

/** The container's address on the project network, which health checks dial. */
export async function containerIp(
  ctx: AgentContext,
  project: string,
  container: string,
): Promise<string> {
  const networks = (await ctx.docker.inspectContainer(container)).NetworkSettings?.Networks || {};
  const net = networks[networkName(project)] ?? Object.values(networks)[0];
  return net?.IPAddress || net?.GlobalIPv6Address || '127.0.0.1';
}

function tcpCheck(host: string, port: number | string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port: Number(port), timeout: timeoutMs }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      reject(new Error(`tcp timeout ${host}:${port}`));
    });
    s.on('error', reject);
  });
}

export async function waitForHealth(
  ctx: AgentContext,
  project: string,
  container: string,
  service: string,
  health: HealthCheck | null | undefined,
): Promise<void> {
  if (!ctx.apply || !health) return;
  const retries = Number(health.retries || 10);
  const intervalMs = parseDuration(health.interval || '2s');
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      if (health.type === 'docker') {
        const state = (await ctx.docker.inspectContainer(container)).State;
        if (!state?.Running) throw new Error(`${service}: not running`);
        if (state.Health && state.Health.Status !== 'healthy')
          throw new Error(`${service}: docker health ${state.Health.Status}`);
      } else if (health.type === 'tcp') {
        await tcpCheck(
          await containerIp(ctx, project, container),
          health.port as number | string,
          parseDuration(health.timeout || '2s'),
        );
      } else if (health.type === 'http') {
        const ip = await containerIp(ctx, project, container);
        const res = await ctx.http(`http://${ip}:${health.port || 80}${health.path || '/'}`, {
          signal: AbortSignal.timeout(parseDuration(health.timeout || '2s')),
        });
        if (!res.ok) throw new Error(`${service}: http ${res.status}`);
      }
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `${service}: ${describeHealthCheck(health)} failed after ${retries} attempt${retries === 1 ? '' : 's'}: ${describeError(last)}`,
  );
}

/** Node's fetch reports every network failure as "fetch failed"; the system error that explains it is on `cause`. */
function describeError(error: unknown): string {
  const e = error as { message?: string; cause?: { code?: string; message?: string } } | undefined;
  const cause = e?.cause?.code || e?.cause?.message;
  return cause ? `${e?.message ?? 'error'} (${cause})` : (e?.message ?? 'no response');
}
function describeHealthCheck(health: HealthCheck): string {
  if (health.type === 'http')
    return `http health check on port ${health.port || 80}${health.path || '/'}`;
  if (health.type === 'tcp') return `tcp health check on port ${health.port}`;
  return 'docker health check';
}

export { parseDuration };

export interface PublicListener {
  project: string;
  container: string;
  listen: string;
}

/** Containers of Tug projects (`projects`) that publish a port on all interfaces or on a public IP. */
export function publicListeners(
  containers: ContainerSummary[],
  projects: readonly string[],
): PublicListener[] {
  const out: PublicListener[] = [];
  for (const c of containers) {
    const project = c.Labels?.['tug.project'];
    if (!project || !projects.includes(project)) continue;
    for (const p of c.Ports || []) {
      if (!p.PublicPort || !p.IP || !isPublicAddress(p.IP)) continue;
      const host = p.IP.includes(':') ? `[${p.IP}]` : p.IP;
      out.push({
        project,
        container: (c.Names?.[0] || c.Id).replace(/^\//, ''),
        listen: `${host}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`,
      });
    }
  }
  return out;
}

/** `ports.public` diagnostic: a warning, not a failure, since an operator may publish on purpose with an explicit host IP. */
async function publicPortsCheck(ctx: AgentContext): Promise<DiagnosticCheck> {
  try {
    const projects = await fs
      .readdir(path.join(ctx.stateDir, 'projects'))
      .catch(() => [] as string[]);
    const containers = await ctx.docker.listContainers({ label: ['tug.project'] }, false);
    const listeners = publicListeners(containers, projects);
    const stdout = listeners.map((l) => `${l.project}\t${l.container}\t${l.listen}`).join('\n');
    return listeners.length
      ? {
          name: 'ports.public',
          ok: true,
          stdout: stdout.slice(-4000),
          warning: `${listeners.length} published port${listeners.length === 1 ? ' of Tug projects listens' : 's of Tug projects listen'} on a public address; bind them to 127.0.0.1, the overlay IP or a private address unless that is intended`,
        }
      : {
          name: 'ports.public',
          ok: true,
          stdout: 'no Tug project container listens on a public address',
        };
  } catch (e) {
    return { name: 'ports.public', ok: false, error: errMessage(e).slice(-4000) };
  }
}

const MIN_API_VERSION = API_VERSION.replace(/^v/, '');
/** The minor number of an Engine API version such as `1.41`; 0 when unparseable. */
const apiMinor = (version: string | undefined): number => Number(version?.split('.')[1]) || 0;

export async function executeCommand(
  command: Command,
  ctx: AgentContext = defaultContext(),
): Promise<CommandResult> {
  const payload: { project: string; service: string; tail?: number | string; volume: string } =
    typeof command.payload_json === 'string'
      ? JSON.parse(command.payload_json || '{}')
      : command.payload || {};
  if (command.type === 'diagnostics.run') {
    const checks: DiagnosticCheck[] = [];
    const daemon: [string, () => Promise<string>][] = [
      ['docker.info', async () => JSON.stringify(await ctx.docker.info(), null, 2)],
      [
        'docker.version',
        async () => {
          const version = await ctx.docker.version();
          if (apiMinor(version.ApiVersion) < apiMinor(MIN_API_VERSION))
            throw new Error(
              `Docker Engine API ${version.ApiVersion} is older than the ${MIN_API_VERSION} the agent needs (Docker 20.10+)`,
            );
          return JSON.stringify(version, null, 2);
        },
      ],
    ];
    for (const [name, fn] of daemon) {
      try {
        checks.push({ name, ok: true, stdout: (await fn()).slice(-4000), stderr: '' });
      } catch (e) {
        checks.push({ name, ok: false, error: errMessage(e).slice(-4000) });
      }
    }
    const extra: [string, () => Promise<{ out: string; err: string }>][] = [];
    if (ctx.mesh && ctx.host) {
      const host = ctx.host;
      extra.push(
        ['wireguard.version', () => host('wg', ['--version'])],
        ['wireguard.interface', () => host('wg', ['show', WG_INTERFACE])],
      );
    }
    if (
      await fs.stat(path.join(ctx.stateDir, 'ingress')).then(
        () => true,
        () => false,
      )
    ) {
      extra.push([
        'ingress.caddy',
        async () => ({
          out: String((await ctx.docker.inspectContainer(CADDY_CONTAINER)).State?.Status),
          err: '',
        }),
      ]);
    }
    for (const [name, fn] of extra) {
      try {
        const result = await fn();
        checks.push({
          name,
          ok: true,
          stdout: result.out.slice(-4000),
          stderr: result.err.slice(-4000),
        });
      } catch (e) {
        checks.push({ name, ok: false, error: errMessage(e).slice(-4000) });
      }
    }
    checks.push(await publicPortsCheck(ctx));
    return {
      commandId: command.id,
      state: checks.every((c) => c.ok) ? 'succeeded' : 'failed',
      result: { checks, node: ctx.nodeName },
    };
  }
  if (command.type === 'service.restart') {
    const { project, service } = payload;
    await ctx.docker.restartContainer(await resolveLiveContainer(ctx, { project, service }));
    return {
      commandId: command.id,
      state: 'succeeded',
      result: { project, service, restarted: true },
    };
  }
  if (command.type === 'logs.fetch') {
    const { project, service } = payload;
    const id = await resolveLiveContainer(ctx, { project, service });
    const logs = await ctx.docker.logs(id, { follow: false, tail: Number(payload.tail || 200) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    logs.stdout.on('data', (d: Buffer) => out.push(d));
    logs.stderr.on('data', (d: Buffer) => err.push(d));
    await new Promise<void>((resolve, reject) => {
      logs.on('error', reject);
      logs.on('close', () => resolve());
    });
    return {
      commandId: command.id,
      state: 'succeeded',
      result: {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      },
    };
  }
  if (command.type === 'volume.delete') {
    const { project, volume } = payload;
    // Volumes are never removed by reconciliation; this explicit command is the only way one goes away.
    await ctx.docker.removeVolume(volumeName(project, volume)).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
    return {
      commandId: command.id,
      state: 'succeeded',
      result: { project, volume, deleted: true },
    };
  }
  if (command.type === 'wg.rotate-key') {
    if (!ctx.mesh)
      throw new Error('the WireGuard mesh is not enabled on this agent (TUG_MESH=true)');
    const { publicKey } = await rotateWgKeys(ctx.stateDir);
    await api(ctx, '/agent/v1/wireguard/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey }),
    });
    await writeReportedKey(ctx.stateDir, publicKey);
    return { commandId: command.id, state: 'succeeded', result: { publicKey } };
  }
  return {
    commandId: command.id,
    state: 'failed',
    result: { error: `unsupported command ${command.type}` },
  };
}

async function managedImageFile(ctx: AgentContext): Promise<string> {
  await ensureDir(ctx.stateDir);
  return path.join(ctx.stateDir, 'managed-images.json');
}
async function managedImages(ctx: AgentContext): Promise<string[]> {
  try {
    const refs = JSON.parse(await fs.readFile(await managedImageFile(ctx), 'utf8'));
    return Array.isArray(refs)
      ? refs.filter((ref: unknown) => typeof ref === 'string' && ref.startsWith('tug-build/'))
      : [];
  } catch {
    return [];
  }
}
export async function ensureArtifact(ctx: AgentContext, artifact: ImageArtifact): Promise<void> {
  const identityFile = path.join(ctx.stateDir, 'image-identities.json');
  let identities: Record<string, { daemonId: string; artifactId: string; sha256: string }> = {};
  try {
    identities = JSON.parse(await fs.readFile(identityFile, 'utf8'));
  } catch {}
  const remember = async (daemonId: string) => {
    identities[artifact.imageRef] = {
      daemonId,
      artifactId: artifact.imageId,
      sha256: artifact.sha256,
    };
    await fs.writeFile(identityFile, JSON.stringify(identities), { mode: 0o600 });
    const refs = await managedImages(ctx);
    if (!refs.includes(artifact.imageRef))
      await fs.writeFile(
        await managedImageFile(ctx),
        JSON.stringify([...refs, artifact.imageRef]),
        { mode: 0o600 },
      );
  };
  const inspect = () => ctx.docker.inspectImage(artifact.imageRef);
  try {
    const image = await inspect();
    if (
      image &&
      (image?.Id === artifact.imageId ||
        (identities[artifact.imageRef]?.daemonId === image?.Id &&
          identities[artifact.imageRef]?.artifactId === artifact.imageId &&
          identities[artifact.imageRef]?.sha256 === artifact.sha256)) &&
      `${image.Os}/${image.Architecture}` === artifact.platform
    ) {
      await remember(image.Id);
      return;
    }
  } catch {}
  const host = await ctx.docker.info();
  const arch = host.Architecture
    ? ({ x86_64: 'amd64', aarch64: 'arm64' } as Record<string, string>)[host.Architecture] ||
      host.Architecture
    : undefined;
  if (host.OSType && arch && `${host.OSType}/${arch}` !== artifact.platform)
    throw new Error(
      `image platform ${artifact.platform} does not match node ${host.OSType}/${arch}; build for the target platform`,
    );
  const downloadDir = await fs.mkdtemp(path.join(ctx.stateDir, 'image-download-'));
  const file = path.join(downloadDir, 'image.tar.gz');
  try {
    const response = await ctx.http(
      `${ctx.controlUrl}/agent/v1/images/${encodeURIComponent(artifact.buildId)}`,
      { headers: authHeaders(ctx), redirect: 'error', signal: AbortSignal.timeout(10 * 60 * 1000) },
    );
    if (!response.ok || !response.body)
      throw new Error(`image download failed: HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      verifyDownload(artifact),
      createWriteStream(file, { mode: 0o600 }),
    );
    const archive = await validateImageArchive(file, artifact.imageRef);
    if (archive.imageId !== artifact.imageId || archive.platform !== artifact.platform)
      throw new Error('downloaded archive image metadata differs from desired artifact');
    await ctx.docker.loadImage(createReadStream(file));
    const image = await inspect();
    if (!image?.Id || `${image.Os}/${image.Architecture}` !== artifact.platform)
      throw new Error('loaded image identity or platform does not match desired artifact');
    await remember(image.Id);
  } finally {
    await fs.rm(downloadDir, { recursive: true, force: true });
  }
}
export async function pruneManagedImages(ctx: AgentContext, retained: string[]): Promise<void> {
  if (!ctx.apply) return;
  const keep = new Set(retained);
  const remaining: string[] = [];
  for (const ref of await managedImages(ctx)) {
    if (keep.has(ref)) {
      remaining.push(ref);
      continue;
    }
    try {
      if ((await ctx.docker.listContainers({ ancestor: ref })).length) {
        remaining.push(ref);
        continue;
      }
      await ctx.docker.removeImage(ref);
    } catch {
      remaining.push(ref);
    }
  }
  await fs.writeFile(await managedImageFile(ctx), JSON.stringify(remaining), { mode: 0o600 });
}

/**
 * The IP that published ports without a host IP listen on: `127.0.0.1` when the node has no
 * address, the address itself when it is an IP, otherwise what it resolves to on this node.
 */
export async function resolveBindAddress(
  address: string | null,
  lookup: (host: string) => Promise<{ address: string }> = (host) => dns.lookup(host),
): Promise<string> {
  if (!address) return '127.0.0.1';
  const bare = address.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return bare;
  try {
    return (await lookup(bare)).address;
  } catch (e) {
    throw new Error(
      `cannot resolve node address ${address} to bind published ports: ${errMessage(e)}`,
      { cause: e },
    );
  }
}

// Last public-port warning per project, so the event is sent when it changes rather than on every poll.
const publicPortWarnings = new Map<string, string>();

export async function reconcile(
  desiredState: DesiredState,
  ctx: AgentContext = defaultContext(),
  endpoints: Record<string, ServiceEndpoint[]> = {},
  ports: PortBinding = { address: null, loopback: {} },
): Promise<ProjectStatus> {
  const dir = path.join(ctx.stateDir, 'projects', desiredState.project);
  await ensureDir(dir);
  const serviceNames = Object.keys(containerSpecs(desiredState, ctx.nodeName).specs);
  if (!serviceNames.length) {
    if (ctx.apply) {
      await sweepOrphans(ctx.docker, desiredState.project, new Set()).catch(() => {});
      await clearRolloutState(dir).catch(() => {});
    }
    return {
      project: desiredState.project,
      observedVersion: desiredState.version,
      ...(desiredState.revision ? { observedRevision: desiredState.revision } : {}),
      health: 'skipped',
      services: [],
      serviceStates: {},
    };
  }
  const serviceStates: Record<string, ServiceState> = Object.fromEntries(
    serviceNames.map((service) => [
      service,
      { rolloutState: 'pending', image: desiredState.services[service]?.image },
    ]),
  );
  const emit = (service: string, rolloutState: string, message = rolloutState, level = 'info') =>
    api(ctx, '/agent/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: desiredState.project,
        level,
        type: `service.${rolloutState}`,
        message,
        metadata: { service, version: desiredState.version, node: ctx.nodeName },
      }),
    }).catch(() => {});
  const sec = await api<SecretsResponse>(
    ctx,
    `/agent/v1/secrets?project=${encodeURIComponent(desiredState.project)}&services=${encodeURIComponent(serviceNames.join(','))}`,
  );
  const currentSecretVersions = serviceSecretVersions(
    desiredState.compose,
    serviceNames,
    sec.versions || {},
  );
  const db = await agentDb(ctx.stateDir);
  const previousRow = await db.get<AppliedStateRow>(
    'SELECT version, revision FROM applied_state WHERE project = ?',
    desiredState.project,
  );
  const rolling = serviceNames.filter((service) =>
    isRolling(desiredState.compose.services[service]),
  );
  const rollingSet = new Set(rolling);
  const mainServices = serviceNames.filter((service) => !rollingSet.has(service));
  // Published images are pulled only for a new desired revision. Pulling on every poll would let a tag that moved
  // upstream (`mariadb:11`) recreate the container without a deploy.
  const sameDesiredVersion = previousRow
    ? desiredState.revision
      ? previousRow.revision === desiredState.revision
      : previousRow.version === desiredState.version
    : false;
  const loopback = new Set(ports.loopback[desiredState.project] || []);
  // Resolve only when some port actually binds to the node address; a hostname nobody needs must not fail the apply.
  const needsAddress =
    addressBoundServices(desiredState.compose, serviceNames, loopback).length > 0;
  const bind: PortBind = {
    address: needsAddress ? await resolveBindAddress(ports.address) : '127.0.0.1',
    loopback,
  };
  const plan = containerSpecs(desiredState, ctx.nodeName, {
    secrets: sec.secrets || {},
    secretVersions: sec.versions || {},
    endpoints,
    bind,
  });
  await warnPublicPorts(ctx, desiredState, serviceNames, bind);
  const failedStatus = (error: string): ProjectStatus => ({
    project: desiredState.project,
    observedVersion: desiredState.version,
    ...(desiredState.revision ? { observedRevision: desiredState.revision } : {}),
    health: 'failed',
    services: serviceNames,
    serviceStates,
    error,
  });
  // Lifecycle events say what changed, not that the agent is still polling. They are sent when the desired revision
  // or any container definition (which includes the secret versions it uses) changes, when an apply fails (once)
  // and when it recovers (once).
  const eventFingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        desiredState.revision || desiredState.version,
        mainServices.map((service) => plan.specs[service].hash),
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  const knownEvents = mainServices.length
    ? await db.get<EventStateRow>(
        'SELECT fingerprint, phase FROM event_state WHERE project = ?',
        desiredState.project,
      )
    : undefined;
  const announce = knownEvents?.fingerprint !== eventFingerprint;
  const wasFailed = !announce && knownEvents?.phase === 'failed';
  const markEvents = (phase: 'serving' | 'failed') =>
    db.run(
      'INSERT INTO event_state(project, fingerprint, phase) VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET fingerprint=excluded.fingerprint, phase=excluded.phase',
      desiredState.project,
      eventFingerprint,
      phase,
    );
  const deps = {
    waitForHealth: (container: string, service: string, dependency?: boolean) =>
      waitForHealth(
        ctx,
        desiredState.project,
        container,
        service,
        desiredState.services[service]?.health ?? (dependency ? { type: 'docker' } : null),
      ),
    ensureArtifact: async (service: string) => {
      const artifact = desiredState.services[service].artifact;
      if (artifact) await ensureArtifact(ctx, artifact);
    },
    pullImage: (service: string) => ctx.docker.pullImage(plan.specs[service].body.Image),
    emit,
  };
  let failing: string | undefined;
  if (ctx.apply) {
    try {
      await ensureProjectResources(ctx.docker, desiredState.project, plan);
      await sweepOrphans(ctx.docker, desiredState.project, new Set(serviceNames));
      if (mainServices.length)
        await reconcileRecreate(
          ctx.docker,
          {
            desired: desiredState,
            dir,
            plan,
            nodeName: ctx.nodeName,
            deps,
            services: mainServices,
            pull: !sameDesiredVersion,
          },
          {
            pulling: async (service) => {
              serviceStates[service].rolloutState = 'pulling';
              if (announce) await emit(service, 'pulling');
            },
            starting: async (service) => {
              serviceStates[service].rolloutState = 'starting';
              if (announce) await emit(service, 'starting');
            },
            checking: async (service) => {
              serviceStates[service].rolloutState = 'health_checking';
              if (announce) await emit(service, 'health_checking');
            },
            serving: async (service) => {
              serviceStates[service].rolloutState = 'serving';
              serviceStates[service].healthyAt = now();
              if (announce || wasFailed)
                await emit(
                  service,
                  'serving',
                  wasFailed ? 'serving again after a failure' : 'serving',
                );
            },
            failing: (service) => {
              failing = service;
            },
          },
        );
      if (mainServices.length && (announce || wasFailed)) await markEvents('serving');
    } catch (e) {
      if (mainServices.length && !wasFailed) {
        // Announce a failure once; retries of the same failure stay quiet until it recovers or the inputs change.
        await emit(failing ?? mainServices.join(', '), 'failed', errMessage(e), 'error');
        await markEvents('failed');
      }
      // Rolling services are untouched by a failure here, so keep reporting their current revision as serving.
      if (!rolling.length) throw e;
      Object.assign(serviceStates, await activeRollingStates(dir, rolling));
      return failedStatus(errMessage(e));
    }
    if (rolling.length) {
      const rolled = await reconcileRolling(ctx.docker, {
        desired: desiredState,
        dir,
        services: rolling,
        plan,
        nodeName: ctx.nodeName,
        rolloutPorts: ctx.rolloutPorts,
        deps,
      });
      Object.assign(serviceStates, rolled.serviceStates);
      const errors = Object.entries(rolled.errors);
      if (errors.length)
        return failedStatus(errors.map(([service, error]) => `${service}: ${error}`).join('; '));
    } else await clearRolloutState(dir);
  } else {
    for (const service of serviceNames) serviceStates[service].rolloutState = 'serving';
  }
  await db.run(
    `INSERT INTO applied_state(project, version, revision, applied_at, service_states_json, secret_versions_json)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(project) DO UPDATE SET version=excluded.version, revision=excluded.revision, applied_at=excluded.applied_at,
       service_states_json=excluded.service_states_json, secret_versions_json=excluded.secret_versions_json`,
    desiredState.project,
    desiredState.version,
    desiredState.revision || null,
    now(),
    JSON.stringify(serviceStates),
    JSON.stringify(currentSecretVersions),
  );
  return {
    project: desiredState.project,
    observedVersion: desiredState.version,
    ...(desiredState.revision ? { observedRevision: desiredState.revision } : {}),
    health: 'serving',
    services: serviceNames,
    serviceStates,
  };
}

/** Emits a `ports.public` warning when published ports of this project are bound to a public node address. */
async function warnPublicPorts(
  ctx: AgentContext,
  desiredState: DesiredState,
  serviceNames: string[],
  bind: PortBind,
): Promise<void> {
  const key = `${ctx.stateDir}\0${desiredState.project}`;
  const exposed = isPublicAddress(bind.address)
    ? addressBoundServices(desiredState.compose, serviceNames, bind.loopback)
    : [];
  const message = exposed.length
    ? `published ports of ${exposed.join(', ')} listen on public address ${bind.address}; enable the mesh, give the node a private address, or write the host IP in ports to make the exposure explicit`
    : '';
  if ((publicPortWarnings.get(key) ?? '') === message) return;
  publicPortWarnings.set(key, message);
  if (!message) return;
  await api(ctx, '/agent/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: desiredState.project,
      level: 'warn',
      type: 'ports.public',
      message,
      metadata: { services: exposed, address: bind.address, node: ctx.nodeName },
    }),
  }).catch(() => {});
}

/** Reports this node's WireGuard public key when control has not seen the current one yet. */
export async function reportWgKey(ctx: AgentContext): Promise<void> {
  const { publicKey } = await ensureWgKeys(ctx.stateDir);
  if ((await readReportedKey(ctx.stateDir)) === publicKey) return;
  await api(ctx, '/agent/v1/wireguard/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  await writeReportedKey(ctx.stateDir, publicKey);
}

let lastNetworkError = '';
async function networkStep(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    lastNetworkError = '';
  } catch (e) {
    const message = `${label}: ${errMessage(e)}`;
    if (message !== lastNetworkError) console.error(message);
    lastNetworkError = message;
  }
}

export async function pollOnce(ctx: AgentContext = defaultContext()): Promise<ProjectStatus[]> {
  if (ctx.mesh) await networkStep('wireguard key report failed', () => reportWgKey(ctx));
  const work = await api<WorkResponse & { desiredState?: DesiredState }>(ctx, '/agent/v1/work');
  // The mesh comes up first so cross-node service endpoints are routable when containers start.
  if (ctx.mesh && work.network) {
    const network = work.network;
    await networkStep('wireguard reconcile failed', () =>
      reconcileMesh(ctx.host ?? createHostRunner(), ctx.stateDir, network),
    );
  }
  const projects: ProjectStatus[] = [];
  for (const desired of work.desiredStates || (work.desiredState ? [work.desiredState] : [])) {
    try {
      projects.push(
        await reconcile(desired, ctx, work.serviceEndpoints?.[desired.project], work.ports),
      );
    } catch (e) {
      projects.push({
        project: desired.project,
        observedVersion: desired.version,
        ...(desired.revision ? { observedRevision: desired.revision } : {}),
        health: 'failed',
        error: errMessage(e),
      });
    }
  }
  let ingress: IngressStatus | undefined;
  if (ctx.apply) {
    const ingressCtx = { docker: ctx.docker, stateDir: ctx.stateDir, caddyImage: ctx.caddyImage };
    if (work.ingress) ingress = await reconcileIngress(ingressCtx, work.ingress);
    else await removeIngress(ingressCtx).catch(() => false);
  }
  const commandResults: CommandResult[] = [];
  for (const command of work.commands || []) {
    try {
      commandResults.push(await executeCommand(command, ctx));
    } catch (e) {
      commandResults.push({
        commandId: command.id,
        state: 'failed',
        result: { error: errMessage(e) },
      });
    }
  }
  const report: StatusReport = { node: ctx.nodeName, projects, commandResults };
  if (ingress) report.ingress = ingress;
  if (work.retainedImages && projects.every((project) => project.health !== 'failed'))
    await pruneManagedImages(ctx, work.retainedImages);
  await api(ctx, '/agent/v1/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  return projects;
}

interface Creds {
  agentToken: string;
  nodeName?: string;
  controlUrl?: string;
  registry?: string | null;
  registryToken?: string | null;
}

const CREDS_FILE = () => path.join(STATE_DIR, 'agent.json');
async function loadCreds(): Promise<Creds | null> {
  try {
    return JSON.parse(await fs.readFile(CREDS_FILE(), 'utf8'));
  } catch {
    return null;
  }
}
async function saveCreds(creds: Creds): Promise<void> {
  await ensureDir(STATE_DIR);
  await fs.writeFile(CREDS_FILE(), JSON.stringify(creds), { mode: 0o600 });
}
async function readJoinKey(): Promise<string | null> {
  if (process.env.TUG_JOIN_KEY) return process.env.TUG_JOIN_KEY.trim();
  const file = process.env.TUG_JOIN_KEY_FILE;
  if (file) {
    try {
      return (await fs.readFile(file, 'utf8')).trim();
    } catch (e) {
      throw new Error(`cannot read TUG_JOIN_KEY_FILE ${file}: ${errMessage(e)}`, { cause: e });
    }
  }
  return null;
}
function dockerLogin(registry: string, user: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['login', registry, '-u', user, '--password-stdin'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`)),
    );
    p.stdin!.write(password);
    p.stdin!.end();
  });
}
async function enroll(joinKey: string): Promise<Creds> {
  let decoded: JoinKey;
  try {
    decoded = JSON.parse(Buffer.from(joinKey, 'base64url').toString('utf8'));
  } catch (e) {
    throw new Error('invalid TUG_JOIN_KEY (expected base64url-encoded JSON)', { cause: e });
  }
  if (!decoded.enrollToken) throw new Error('join key is missing enrollToken');
  const controlUrl = !CONTROL_URL_FROM_ENV && decoded.controlUrl ? decoded.controlUrl : CONTROL_URL;
  // node's fetch reads NODE_EXTRA_CA_CERTS only at startup, so apply an embedded CA by
  // persisting it and re-execing ourselves once with the env var set.
  if (decoded.ca && !process.env.NODE_EXTRA_CA_CERTS) {
    await ensureDir(STATE_DIR);
    const caPath = path.join(STATE_DIR, 'control-ca.pem');
    await fs.writeFile(caPath, decoded.ca);
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath },
    });
    process.exit(r.status ?? 1);
  }
  console.log(`enrolling with ${controlUrl} as ${NODE_NAME}`);
  const wgPublicKey = MESH ? (await ensureWgKeys(STATE_DIR)).publicKey : undefined;
  const res = await fetch(`${controlUrl}/agent/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollToken: decoded.enrollToken,
      name: NODE_NAME,
      address: process.env.TUG_NODE_ADDRESS,
      publicAddress: process.env.TUG_NODE_PUBLIC_ADDRESS,
      wgPublicKey,
      labels:
        decoded.labels ||
        (process.env.TUG_LABELS
          ? process.env.TUG_LABELS.split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined),
    }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const out = (await res.json()) as EnrollResponse;
  const creds: Creds = {
    agentToken: out.agentToken,
    nodeName: out.node?.name || NODE_NAME,
    controlUrl,
    registry: out.registry || null,
    registryToken: out.registryToken || null,
  };
  await saveCreds(creds);
  if (wgPublicKey) await writeReportedKey(STATE_DIR, wgPublicKey);
  console.log(`enrolled as node ${creds.nodeName}`);
  return creds;
}
// Establish durable credentials before polling: explicit env token (SSH/push install) wins,
// then credentials persisted on the state volume, then a one-time enroll via the join key.
export async function loadOrEnroll(): Promise<Creds> {
  let creds: Creds | null = TOKEN
    ? { agentToken: TOKEN, nodeName: NODE_NAME, controlUrl: CONTROL_URL }
    : await loadCreds();
  if (!creds) {
    const joinKey = await readJoinKey();
    if (!joinKey)
      throw new Error(
        'no TUG_AGENT_TOKEN, no persisted credentials, and no TUG_JOIN_KEY to enroll with',
      );
    creds = await enroll(joinKey);
  }
  TOKEN = creds.agentToken;
  NODE_NAME = creds.nodeName || NODE_NAME;
  if (!CONTROL_URL_FROM_ENV && creds.controlUrl) CONTROL_URL = creds.controlUrl;
  if (APPLY && creds.registry && creds.registryToken) {
    try {
      await dockerLogin(creds.registry, NODE_NAME, creds.registryToken);
    } catch (e) {
      console.error(
        `registry login failed (pulls from ${creds.registry} may fail): ${errMessage(e)}`,
      );
    }
  }
  return creds;
}

export async function main(): Promise<void> {
  await loadOrEnroll();
  console.log(`tug-agent node=${NODE_NAME} control=${CONTROL_URL} apply=${APPLY}`);
  const ctx = defaultContext();
  const wake = new AgentWakeChannel(ctx, undefined, {
    onLive: (frame) => live.handle(frame),
    onDisconnect: () => live.dispose(),
  });
  const live = new AgentLiveOperations(ctx, (frame) => {
    wake.send(frame);
  });
  for (;;) {
    try {
      await pollOnce(ctx);
    } catch (e) {
      console.error(errMessage(e));
    }
    try {
      await wake.wait(INTERVAL);
    } catch (e) {
      console.error(`agent wake wait failed: ${errMessage(e)}`);
      await new Promise((r) => setTimeout(r, INTERVAL));
    }
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
