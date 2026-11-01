// In-memory Docker Engine for unit tests: containers, networks, volumes and images behave like the
// real thing closely enough for the reconciler (labels, filters, start/stop, published-port
// conflicts), and every call is recorded so tests can assert on order.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DockerError } from '../src/docker-api.ts';
import type {
  AttachedProcess,
  ContainerFilter,
  ContainerInspect,
  ContainerSummary,
  CreateContainerBody,
  DaemonInfo,
  DaemonVersion,
  DockerApi,
  ExecOptions,
  ImageInspect,
  LogsOptions,
  NetworkInspect,
  VolumeInspect,
} from '../src/docker-api.ts';
import type { Readable } from 'node:stream';

export interface FakeContainer {
  id: string;
  name: string;
  body: CreateContainerBody;
  state: 'created' | 'running' | 'exited';
  ip: string;
  /** Overrides `State.Health.Status`; unset means the image has no HEALTHCHECK. */
  health?: string;
  tty: boolean;
}

export class FakeDocker implements DockerApi {
  containers = new Map<string, FakeContainer>();
  networks = new Map<string, NetworkInspect>();
  volumes = new Map<string, VolumeInspect>();
  images = new Map<string, ImageInspect>();
  /** Every mutating call as `verb subject`, in order; reads are not recorded. */
  calls: string[] = [];
  archives: { container: string; dir: string; bytes: number }[] = [];
  execLog: { container: string; cmd: string[] }[] = [];
  /** Throws from `startContainer` when set and it returns an error for the container name. */
  failStart?: (name: string) => Error | undefined;
  failCreate?: (name: string) => Error | undefined;
  failPull?: (ref: string) => Error | undefined;
  failExec?: (cmd: string[]) => { code: number; out?: string; err?: string } | undefined;
  /** Images `pullImage` makes available; any other pulled ref is added with a generated ID. */
  info_: DaemonInfo = { OSType: 'linux', Architecture: 'x86_64', ServerVersion: '27.0.0' };
  version_: DaemonVersion = { Version: '27.0.0', ApiVersion: '1.46', MinAPIVersion: '1.24' };
  /** State a container is in after `startContainer`; `exited` simulates a crash on start. */
  startsAs: 'running' | 'exited' = 'running';
  logOutput = new Map<string, string>();
  private seq = 0;

  /** Pre-seeds a local image. */
  addImage(ref: string, id = `sha256:${ref.replace(/\W/g, '').padEnd(16, '0')}`): void {
    this.images.set(ref, { Id: id, Os: 'linux', Architecture: 'amd64', RepoTags: [ref] });
  }
  names(): string[] {
    return [...this.containers.values()].map((c) => c.name).sort();
  }
  byName(name: string): FakeContainer | undefined {
    return [...this.containers.values()].find((c) => c.name === name);
  }
  running(): string[] {
    return [...this.containers.values()]
      .filter((c) => c.state === 'running')
      .map((c) => c.name)
      .sort();
  }
  service(project: string, service: string): FakeContainer[] {
    return [...this.containers.values()].filter(
      (c) =>
        c.body.Labels?.['tug.project'] === project && c.body.Labels?.['tug.service'] === service,
    );
  }
  verbs(prefix?: string): string[] {
    return prefix ? this.calls.filter((c) => c.startsWith(prefix)) : this.calls;
  }

  private resolve(idOrName: string): FakeContainer {
    const found =
      this.containers.get(idOrName) ??
      [...this.containers.values()].find((c) => c.name === idOrName || c.id.startsWith(idOrName));
    if (!found) throw new DockerError(404, `No such container: ${idOrName}`);
    return found;
  }

  async version() {
    return this.version_;
  }
  async info() {
    return this.info_;
  }

  private summary(c: FakeContainer): ContainerSummary {
    const bindings = (c.body.HostConfig?.PortBindings || {}) as Record<
      string,
      { HostIp: string; HostPort: string }[]
    >;
    const Ports =
      c.state === 'running'
        ? Object.entries(bindings).flatMap(([key, list]) =>
            list.map((b) => ({
              IP: b.HostIp || '0.0.0.0',
              PrivatePort: Number(key.split('/')[0]),
              ...(b.HostPort ? { PublicPort: Number(b.HostPort) } : {}),
              Type: key.split('/')[1] || 'tcp',
            })),
          )
        : [];
    return {
      Id: c.id,
      Names: [`/${c.name}`],
      Image: c.body.Image,
      State: c.state,
      Status: c.state,
      Labels: c.body.Labels || {},
      Ports,
    };
  }

  async listContainers(filter: ContainerFilter = {}, all = true): Promise<ContainerSummary[]> {
    return [...this.containers.values()]
      .filter((c) => all || c.state === 'running')
      .filter((c) =>
        (filter.label || []).every((l) => {
          const [k, v] = l.split('=');
          return v === undefined ? k in (c.body.Labels || {}) : c.body.Labels?.[k] === v;
        }),
      )
      .filter((c) => !filter.ancestor || c.body.Image === filter.ancestor)
      .filter((c) => !filter.name || c.name.includes(filter.name))
      .map((c) => this.summary(c));
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const c = this.resolve(id);
    return {
      Id: c.id,
      Name: `/${c.name}`,
      Config: { Image: c.body.Image, Labels: c.body.Labels, Env: c.body.Env, Tty: c.tty } as never,
      State: {
        Status: c.state,
        Running: c.state === 'running',
        ...(c.health ? { Health: { Status: c.health } } : {}),
      },
      NetworkSettings: {
        Networks: Object.fromEntries(
          Object.keys(c.body.NetworkingConfig?.EndpointsConfig || {}).map((n) => [
            n,
            { IPAddress: c.ip },
          ]),
        ),
      },
    };
  }

  async createContainer(name: string, body: CreateContainerBody): Promise<string> {
    const failure = this.failCreate?.(name);
    if (failure) throw failure;
    if (this.byName(name))
      throw new DockerError(409, `Conflict. The container name "${name}" is already in use`);
    if (!this.images.has(body.Image)) throw new DockerError(404, `No such image: ${body.Image}`);
    const id = `c${(++this.seq).toString(16).padStart(12, '0')}${'0'.repeat(51)}`;
    this.calls.push(`create ${name}`);
    this.containers.set(id, {
      id,
      name,
      body,
      state: 'created',
      ip: `172.20.0.${this.seq + 1}`,
      tty: false,
    });
    return id;
  }

  async startContainer(id: string): Promise<void> {
    const c = this.resolve(id);
    const failure = this.failStart?.(c.name);
    if (failure) throw failure;
    const wanted = this.publishedPorts(c);
    for (const other of this.containers.values())
      if (other !== c && other.state === 'running')
        for (const port of this.publishedPorts(other))
          if (wanted.includes(port))
            throw new DockerError(
              500,
              `driver failed programming external connectivity: Bind for 0.0.0.0:${port} failed: port is already allocated`,
            );
    this.calls.push(`start ${c.name}`);
    c.state = this.startsAs;
  }
  private publishedPorts(c: FakeContainer): number[] {
    const bindings = (c.body.HostConfig?.PortBindings || {}) as Record<
      string,
      { HostPort: string }[]
    >;
    return Object.values(bindings).flatMap((list) =>
      list.filter((b) => b.HostPort).map((b) => Number(b.HostPort)),
    );
  }
  async stopContainer(id: string): Promise<void> {
    const c = this.resolve(id);
    this.calls.push(`stop ${c.name}`);
    c.state = 'exited';
  }
  async restartContainer(id: string): Promise<void> {
    const c = this.resolve(id);
    this.calls.push(`restart ${c.name}`);
    c.state = 'running';
  }
  async removeContainer(id: string): Promise<void> {
    let c: FakeContainer;
    try {
      c = this.resolve(id);
    } catch {
      return;
    }
    this.calls.push(`rm ${c.name}`);
    this.containers.delete(c.id);
  }
  async connectNetwork(): Promise<void> {}

  async logs(id: string, options: LogsOptions = {}): Promise<AttachedProcess> {
    const c = this.resolve(id);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin: null,
      stdout,
      stderr,
      kill: () => {
        stdout.end();
        stderr.end();
        return true;
      },
    }) as AttachedProcess;
    const text = this.logOutput.get(c.name) ?? '';
    this.calls.push(`logs ${c.name} tail=${options.tail ?? 100}`);
    queueMicrotask(() => {
      if (text) stdout.write(text);
      if (options.follow === false) {
        stdout.end();
        stderr.end();
        setImmediate(() => proc.emit('close', 0, null));
      }
    });
    return proc;
  }

  async putArchive(id: string, dir: string, tar: Readable | Buffer): Promise<void> {
    const c = this.resolve(id);
    const bytes = Buffer.isBuffer(tar) ? tar.length : 0;
    this.archives.push({ container: c.name, dir, bytes });
    this.calls.push(`archive ${c.name} ${dir}`);
  }
  async execRun(id: string, cmd: string[]) {
    const c = this.resolve(id);
    this.execLog.push({ container: c.name, cmd });
    this.calls.push(`exec ${c.name} ${cmd.join(' ')}`);
    const failure = this.failExec?.(cmd);
    return { code: failure?.code ?? 0, out: failure?.out ?? '', err: failure?.err ?? '' };
  }
  /** Scripts `execStart`: when it returns a result the process writes it and closes with that exit code. */
  execResponder?: (cmd: string[]) => { code: number; out?: string; err?: string } | undefined;
  execProcesses: AttachedProcess[] = [];
  execOptions: ExecOptions[] = [];
  async execStart(id: string, options: ExecOptions): Promise<AttachedProcess> {
    const c = this.resolve(id);
    this.calls.push(`exec-start ${c.name} ${options.cmd.join(' ')}`);
    this.execOptions.push(options);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = options.stdin ? new PassThrough() : null;
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      ...(options.tty ? { resize: () => {} } : {}),
    }) as AttachedProcess;
    this.execProcesses.push(proc);
    const scripted = this.execResponder?.(options.cmd);
    if (scripted)
      setImmediate(() => {
        if (scripted.out) stdout.write(scripted.out);
        if (scripted.err) stderr.write(scripted.err);
        stdout.end();
        stderr.end();
        setImmediate(() => proc.emit('close', scripted.code, null));
      });
    return proc;
  }

  async inspectNetwork(name: string) {
    return this.networks.get(name) ?? null;
  }
  async createNetwork(name: string, labels: Record<string, string>) {
    this.calls.push(`network ${name}`);
    this.networks.set(name, { Name: name, Id: `n-${name}`, Labels: labels });
  }
  async inspectVolume(name: string) {
    return this.volumes.get(name) ?? null;
  }
  async createVolume(
    name: string,
    options: { driver?: string; opts?: Record<string, string>; labels?: Record<string, string> },
  ) {
    this.calls.push(`volume ${name}`);
    this.volumes.set(name, {
      Name: name,
      Driver: options.driver,
      Options: options.opts,
      Labels: options.labels,
    });
  }
  async removeVolume(name: string) {
    if (!this.volumes.delete(name)) throw new DockerError(404, `No such volume: ${name}`);
    this.calls.push(`volume-rm ${name}`);
  }

  async inspectImage(ref: string) {
    return this.images.get(ref) ?? null;
  }
  async pullImage(ref: string) {
    const failure = this.failPull?.(ref);
    if (failure) throw failure;
    this.calls.push(`pull ${ref}`);
    if (!this.images.has(ref)) this.addImage(ref);
  }
  loaded: Buffer[] = [];
  async loadImage(archive: Readable | Buffer) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(archive)) chunks.push(archive);
    else for await (const chunk of archive) chunks.push(chunk as Buffer);
    this.loaded.push(Buffer.concat(chunks));
    this.calls.push('load');
    this.onLoad?.();
  }
  onLoad?: () => void;
  async removeImage(ref: string) {
    this.calls.push(`image-rm ${ref}`);
    this.images.delete(ref);
  }
}

/** Compose fixtures in the short syntax the tests are written in, as `docker compose config` would emit them. */
export function normalized<T extends { services: Record<string, Record<string, unknown>> }>(
  compose: T,
): T {
  const services = Object.fromEntries(
    Object.entries(compose.services).map(([name, svc]) => {
      const out: Record<string, unknown> = { ...svc };
      if (Array.isArray(svc.ports))
        out.ports = svc.ports.map((p: unknown) => {
          if (typeof p === 'object') return p;
          const [spec, protocol = 'tcp'] = String(p).split('/');
          const parts = spec.split(':');
          const target = Number(parts[parts.length - 1]);
          const published = parts.length > 1 ? parts[parts.length - 2] : undefined;
          const host_ip =
            parts.length > 2
              ? parts
                  .slice(0, -2)
                  .join(':')
                  .replace(/^\[|\]$/g, '')
              : undefined;
          return {
            mode: 'ingress',
            target,
            ...(published ? { published } : {}),
            ...(host_ip ? { host_ip } : {}),
            protocol,
          };
        });
      if (Array.isArray(svc.volumes))
        out.volumes = svc.volumes.map((v: unknown) => {
          if (typeof v === 'object') return v;
          const [source, target, mode] = String(v).split(':');
          return {
            type: source.startsWith('/') ? 'bind' : 'volume',
            source,
            target,
            ...(mode === 'ro' ? { read_only: true } : {}),
          };
        });
      if (Array.isArray(svc.environment))
        out.environment = Object.fromEntries(
          (svc.environment as string[]).map((e) => {
            const i = e.indexOf('=');
            return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)];
          }),
        );
      if (Array.isArray(svc.depends_on))
        out.depends_on = Object.fromEntries(
          (svc.depends_on as string[]).map((d) => [
            d,
            { condition: 'service_started', required: true },
          ]),
        );
      return [name, out];
    }),
  );
  return { ...compose, services };
}
