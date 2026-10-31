// Typed client for the Docker Engine API over the daemon's unix socket. The agent reconciles
// containers through this seam instead of running the `docker` CLI; tests inject a fake `DockerApi`.
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

/** Oldest Engine API the agent speaks (Docker 20.10+, which the nested daemons in the integration tests run). */
export const API_VERSION = 'v1.41';
export const DEFAULT_SOCKET = '/var/run/docker.sock';

/** An Engine API error; `status` is the HTTP status and `message` the daemon's own text. */
export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}
export const isNotFound = (error: unknown): boolean =>
  error instanceof DockerError && error.status === 404;

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID?: string;
  State: string;
  Status?: string;
  Created?: number;
  Labels: Record<string, string>;
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}
export interface ContainerInspect {
  Id: string;
  Name: string;
  Image?: string;
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    Health?: { Status?: string };
  };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
  };
  [key: string]: unknown;
}
export interface ContainerFilter {
  /** `key` or `key=value` label filters, all of which must match. */
  label?: string[];
  /** Containers created from this image reference or ID. */
  ancestor?: string;
  name?: string;
}
export interface ImageInspect {
  Id: string;
  Os?: string;
  Architecture?: string;
  RepoTags?: string[];
  RepoDigests?: string[];
}
export interface NetworkInspect {
  Name: string;
  Id: string;
  Labels?: Record<string, string>;
  Containers?: Record<string, unknown>;
}
export interface VolumeInspect {
  Name: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
}
export interface DaemonInfo {
  OSType?: string;
  Architecture?: string;
  ServerVersion?: string;
  [key: string]: unknown;
}
export interface DaemonVersion {
  Version?: string;
  ApiVersion?: string;
  MinAPIVersion?: string;
  [key: string]: unknown;
}

/** `POST /containers/create` body; the agent builds these in `containerSpecs`. */
export interface CreateContainerBody {
  Image: string;
  Env?: string[];
  Cmd?: string[] | null;
  Entrypoint?: string[] | null;
  User?: string;
  WorkingDir?: string;
  Hostname?: string;
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, object>;
  StopSignal?: string;
  StopTimeout?: number;
  Healthcheck?: Record<string, unknown>;
  HostConfig?: Record<string, unknown>;
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases?: string[]; [key: string]: unknown }>;
  };
}

/** A process attached to a container: exec or logs. Shaped like a child process so `live.ts` treats both alike. */
export interface AttachedProcess extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  resize?(columns: number, rows: number): void;
}

export interface ExecOptions {
  cmd: string[];
  stdin?: boolean;
  tty?: boolean;
  columns?: number;
  rows?: number;
}
export interface LogsOptions {
  follow?: boolean;
  tail?: number;
  timestamps?: boolean;
}

export interface DockerApi {
  version(): Promise<DaemonVersion>;
  info(): Promise<DaemonInfo>;
  listContainers(filter?: ContainerFilter, all?: boolean): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  createContainer(name: string, body: CreateContainerBody): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  restartContainer(id: string): Promise<void>;
  /** Removes a container even when running; a missing container is not an error. */
  removeContainer(id: string): Promise<void>;
  /** Connects a running container to a network, optionally under service aliases. */
  connectNetwork(network: string, container: string, aliases?: string[]): Promise<void>;
  /** Container output as demultiplexed, ended streams (a TTY container's output is all stdout). */
  logs(id: string, options?: LogsOptions): Promise<AttachedProcess>;
  /** Copies the tar stream into the container directory `dir`. */
  putArchive(id: string, dir: string, tar: Readable | Buffer): Promise<void>;
  /** Runs a command to completion and returns its output; a non-zero exit is reported in `code`. */
  execRun(id: string, cmd: string[]): Promise<{ code: number; out: string; err: string }>;
  /** Starts an interactive or streaming exec; `close` carries the exit code. */
  execStart(id: string, options: ExecOptions): Promise<AttachedProcess>;
  inspectNetwork(name: string): Promise<NetworkInspect | null>;
  createNetwork(name: string, labels: Record<string, string>): Promise<void>;
  inspectVolume(name: string): Promise<VolumeInspect | null>;
  createVolume(
    name: string,
    options: { driver?: string; opts?: Record<string, string>; labels?: Record<string, string> },
  ): Promise<void>;
  removeVolume(name: string): Promise<void>;
  inspectImage(ref: string): Promise<ImageInspect | null>;
  /** Pulls `ref`; `auth` becomes `X-Registry-Auth`. */
  pullImage(ref: string, auth?: Record<string, string>): Promise<void>;
  loadImage(archive: Readable | Buffer): Promise<void>;
  removeImage(ref: string): Promise<void>;
}

/** Splits a reference into `fromImage` and `tag` for `POST /images/create`. */
export function splitImageRef(ref: string): { fromImage: string; tag: string } {
  const digest = ref.indexOf('@');
  if (digest >= 0) {
    const name = ref.slice(0, digest);
    const colon = name.lastIndexOf(':');
    return {
      fromImage: colon > name.lastIndexOf('/') ? name.slice(0, colon) : name,
      tag: ref.slice(digest + 1),
    };
  }
  const colon = ref.lastIndexOf(':');
  if (colon > ref.lastIndexOf('/'))
    return { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { fromImage: ref, tag: 'latest' };
}

/**
 * Splits the 8-byte-header multiplexed stream (`[stream, 0, 0, 0, size(4, big endian)]` frames) that
 * non-TTY attach, exec and logs use into `stdout` and `stderr`. `end` fires once the source ends.
 */
export function demux(source: Readable, stdout: Writable, stderr: Writable): void {
  let buffer: Buffer = Buffer.alloc(0);
  source.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) break;
      const frame = buffer.subarray(8, 8 + size);
      (buffer[0] === 2 ? stderr : stdout).write(frame);
      buffer = buffer.subarray(8 + size);
    }
  });
  const end = () => {
    stdout.end();
    stderr.end();
  };
  source.on('end', end);
  source.on('close', end);
  source.on('error', (error) => {
    stdout.destroy(error);
    stderr.destroy();
  });
}

function filtersParam(filter: ContainerFilter): string {
  const filters: Record<string, string[]> = {};
  if (filter.label?.length) filters.label = filter.label;
  if (filter.ancestor) filters.ancestor = [filter.ancestor];
  if (filter.name) filters.name = [filter.name];
  return JSON.stringify(filters);
}

async function readBody(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** `unix:///path` or a bare path from `DOCKER_HOST`; the agent talks to the local daemon only. */
export function socketFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.DOCKER_HOST;
  if (!host) return DEFAULT_SOCKET;
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  throw new Error(`unsupported DOCKER_HOST ${host} (the agent uses the local unix socket)`);
}

export class DockerEngine implements DockerApi {
  private readonly socketPath: string;
  constructor(socketPath: string = socketFromEnv()) {
    this.socketPath = socketPath;
  }

  private request(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      stream?: Readable | Buffer;
      headers?: Record<string, string>;
    } = {},
  ): Promise<http.IncomingMessage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query || {}))
      if (value !== undefined) query.set(key, value);
    const qs = query.size ? `?${query}` : '';
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...options.headers };
      let payload: Buffer | undefined;
      if (options.body !== undefined) {
        payload = Buffer.from(JSON.stringify(options.body));
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(payload.length);
      }
      const req = http.request(
        { socketPath: this.socketPath, method, path: `/${API_VERSION}${path}${qs}`, headers },
        resolve,
      );
      req.on('error', reject);
      if (payload) req.end(payload);
      else if (Buffer.isBuffer(options.stream)) req.end(options.stream);
      else if (options.stream) {
        options.stream.on('error', (error) => req.destroy(error));
        options.stream.pipe(req);
      } else req.end();
    });
  }

  /** Reads the response; non-2xx becomes a `DockerError` carrying the daemon's message. */
  private async call(
    method: string,
    path: string,
    options?: Parameters<DockerEngine['request']>[2],
  ) {
    const res = await this.request(method, path, options);
    const text = await readBody(res);
    const status = res.statusCode || 0;
    if (status >= 200 && status < 300) return text;
    let message = text.trim();
    try {
      message = (JSON.parse(text) as { message?: string }).message || message;
    } catch {
      /* not JSON */
    }
    throw new DockerError(status, message || `Docker API ${method} ${path}: HTTP ${status}`);
  }

  private async json<T>(
    method: string,
    path: string,
    options?: Parameters<DockerEngine['request']>[2],
  ): Promise<T> {
    const text = await this.call(method, path, options);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Consumes the JSON-lines progress stream of pull and load; a line with `error` fails the call. */
  private async progress(res: http.IncomingMessage, what: string): Promise<void> {
    const status = res.statusCode || 0;
    const text = await readBody(res);
    if (status < 200 || status >= 300) {
      let message = text.trim();
      try {
        message = (JSON.parse(text) as { message?: string }).message || message;
      } catch {
        /* not JSON */
      }
      throw new DockerError(status, message || `${what}: HTTP ${status}`);
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: { error?: string };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.error) throw new Error(`${what}: ${event.error}`);
    }
  }

  version = () => this.json<DaemonVersion>('GET', '/version');
  info = () => this.json<DaemonInfo>('GET', '/info');

  listContainers(filter: ContainerFilter = {}, all = true): Promise<ContainerSummary[]> {
    return this.json('GET', '/containers/json', {
      query: { all: all ? '1' : '0', filters: filtersParam(filter) },
    });
  }
  inspectContainer = (id: string) =>
    this.json<ContainerInspect>('GET', `/containers/${encodeURIComponent(id)}/json`);
  async createContainer(name: string, body: CreateContainerBody): Promise<string> {
    const created = await this.json<{ Id: string }>('POST', '/containers/create', {
      query: { name },
      body,
    });
    return created.Id;
  }
  async startContainer(id: string): Promise<void> {
    try {
      await this.call('POST', `/containers/${encodeURIComponent(id)}/start`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 304) return;
      throw error;
    }
  }
  async stopContainer(id: string, timeoutSeconds?: number): Promise<void> {
    try {
      await this.call('POST', `/containers/${encodeURIComponent(id)}/stop`, {
        query: { t: timeoutSeconds === undefined ? undefined : String(timeoutSeconds) },
      });
    } catch (error) {
      if (error instanceof DockerError && error.status === 304) return;
      throw error;
    }
  }
  async restartContainer(id: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/restart`);
  }
  async removeContainer(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/containers/${encodeURIComponent(id)}`, {
        query: { force: '1' },
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  async connectNetwork(network: string, container: string, aliases: string[] = []): Promise<void> {
    await this.call('POST', `/networks/${encodeURIComponent(network)}/connect`, {
      body: { Container: container, EndpointConfig: { Aliases: aliases } },
    });
  }

  async logs(id: string, options: LogsOptions = {}): Promise<AttachedProcess> {
    const tty = await this.isTty(id);
    const res = await this.request('GET', `/containers/${encodeURIComponent(id)}/logs`, {
      query: {
        stdout: '1',
        stderr: '1',
        follow: options.follow === false ? '0' : '1',
        tail: String(options.tail ?? 100),
        timestamps: options.timestamps ? '1' : '0',
      },
    });
    if ((res.statusCode || 0) >= 300) {
      const text = await readBody(res);
      throw new DockerError(res.statusCode || 0, text.trim() || 'cannot read container logs');
    }
    return this.attachedFromStream(
      res,
      tty,
      () => res.destroy(),
      null,
      async () => 0,
    );
  }

  private async isTty(id: string): Promise<boolean> {
    const inspected = (await this.inspectContainer(id)) as { Config?: { Tty?: boolean } };
    return Boolean(inspected.Config?.Tty);
  }

  /**
   * Wraps a response or hijacked socket as a process whose output is demultiplexed unless a TTY.
   * `close` fires with `exitCode()` once the source and both output streams have ended.
   */
  private attachedFromStream(
    source: Readable,
    tty: boolean,
    destroy: () => void,
    stdin: Writable | null,
    exitCode: () => Promise<number | null>,
  ): AttachedProcess {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => {
        destroy();
        return true;
      },
    }) as AttachedProcess;
    if (tty) {
      source.pipe(stdout);
      source.on('end', () => stderr.end());
      source.on('close', () => stderr.end());
    } else demux(source, stdout, stderr);
    source.on('error', (error) => proc.emit('error', error));
    const ended = (stream: Readable) =>
      new Promise<void>((resolve) => {
        stream.once('end', resolve);
        stream.once('close', resolve);
        stream.once('error', () => resolve());
      });
    void Promise.all([ended(source), ended(stdout), ended(stderr)]).then(async () =>
      proc.emit('close', await exitCode().catch(() => null), null),
    );
    return proc;
  }

  async putArchive(id: string, dir: string, tar: Readable | Buffer): Promise<void> {
    await this.call('PUT', `/containers/${encodeURIComponent(id)}/archive`, {
      query: { path: dir },
      stream: tar,
      headers: { 'content-type': 'application/x-tar' },
    });
  }

  async execRun(id: string, cmd: string[]) {
    const proc = await this.execStart(id, { cmd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    const code = await new Promise<number>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (c: number | null) => resolve(c ?? -1));
    });
    return {
      code,
      out: Buffer.concat(out).toString('utf8'),
      err: Buffer.concat(err).toString('utf8'),
    };
  }

  async execStart(id: string, options: ExecOptions): Promise<AttachedProcess> {
    const tty = Boolean(options.tty);
    const created = await this.json<{ Id: string }>(
      'POST',
      `/containers/${encodeURIComponent(id)}/exec`,
      {
        body: {
          AttachStdin: options.stdin === true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: tty,
          Cmd: options.cmd,
          ...(tty && options.rows && options.columns
            ? { ConsoleSize: [options.rows, options.columns] }
            : {}),
        },
      },
    );
    const execId = created.Id;
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: tty }));
    // Exec start hijacks the connection: the daemon answers `101 UPGRADE` and the socket becomes the stream.
    const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: 'POST',
          path: `/${API_VERSION}/exec/${execId}/start`,
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            connection: 'Upgrade',
            upgrade: 'tcp',
          },
        },
        async (res) => reject(new DockerError(res.statusCode || 0, (await readBody(res)).trim())),
      );
      req.on('upgrade', (_res, sock, head) => {
        if (head.length) sock.unshift(head);
        resolve(sock);
      });
      req.on('error', reject);
      req.end(payload);
    });
    const proc = this.attachedFromStream(
      socket,
      tty,
      () => socket.destroy(),
      options.stdin ? socket : null,
      async () =>
        (await this.json<{ ExitCode?: number | null }>('GET', `/exec/${execId}/json`)).ExitCode ??
        0,
    );
    if (tty) {
      proc.resize = (columns, rows) => void this.resizeExec(execId, columns, rows);
      // ConsoleSize at create needs API 1.42; resizing once started works on every supported daemon.
      if (options.columns && options.rows) proc.resize(options.columns, options.rows);
    }
    return proc;
  }

  private async resizeExec(execId: string, columns: number, rows: number): Promise<void> {
    await this.call('POST', `/exec/${execId}/resize`, {
      query: { h: String(rows), w: String(columns) },
    }).catch(() => {});
  }

  async inspectNetwork(name: string): Promise<NetworkInspect | null> {
    try {
      return await this.json<NetworkInspect>('GET', `/networks/${encodeURIComponent(name)}`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async createNetwork(name: string, labels: Record<string, string>): Promise<void> {
    await this.call('POST', '/networks/create', {
      body: { Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: labels },
    });
  }
  async inspectVolume(name: string): Promise<VolumeInspect | null> {
    try {
      return await this.json<VolumeInspect>('GET', `/volumes/${encodeURIComponent(name)}`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async createVolume(
    name: string,
    options: { driver?: string; opts?: Record<string, string>; labels?: Record<string, string> },
  ): Promise<void> {
    await this.call('POST', '/volumes/create', {
      body: {
        Name: name,
        Driver: options.driver || 'local',
        DriverOpts: options.opts || {},
        Labels: options.labels || {},
      },
    });
  }
  async removeVolume(name: string): Promise<void> {
    await this.call('DELETE', `/volumes/${encodeURIComponent(name)}`);
  }
  async inspectImage(ref: string): Promise<ImageInspect | null> {
    try {
      return await this.json<ImageInspect>('GET', `/images/${encodeURI(ref)}/json`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async pullImage(ref: string, auth?: Record<string, string>): Promise<void> {
    const { fromImage, tag } = splitImageRef(ref);
    const res = await this.request('POST', '/images/create', {
      query: { fromImage, tag },
      // Docker uses Go's padded base64.URLEncoding; Node's base64url encoding omits required '='.
      headers: auth
        ? {
            'x-registry-auth': Buffer.from(JSON.stringify(auth))
              .toString('base64')
              .replaceAll('+', '-')
              .replaceAll('/', '_'),
          }
        : {},
    });
    await this.progress(res, `pull ${ref}`);
  }
  async loadImage(archive: Readable | Buffer): Promise<void> {
    const res = await this.request('POST', '/images/load', {
      query: { quiet: '1' },
      stream: archive,
      headers: { 'content-type': 'application/x-tar' },
    });
    await this.progress(res, 'load image');
  }
  async removeImage(ref: string): Promise<void> {
    await this.call('DELETE', `/images/${encodeURI(ref)}`);
  }
}
