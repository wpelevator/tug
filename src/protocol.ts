// Single source of truth for everything that crosses the control <-> agent boundary and for the
// desired-state shape persisted in `desired_states.state_json`. Types plus a few shared constants;
// control.ts, agent.ts, compose.ts and cli.ts all import from here.

// ---- Compose input (what the operator deploys) -------------------------------------------------

export interface Placement {
  nodes?: string[];
  labels?: string[];
}

export interface HealthCheck {
  type: 'docker' | 'tcp' | 'http';
  port?: number | string;
  path?: string;
  /** Duration: number (ms) or "2s" / "500ms" / "1m". */
  interval?: string | number;
  timeout?: string | number;
  retries?: number | string;
}

export type IngressTls = 'auto' | 'custom' | 'off';

/** `x-tug.ingress`: publish a service on a hostname through the managed Caddy edge. */
export interface IngressSpec {
  host: string;
  /** Container port (or the host port) of the service; must be published in the service's `ports`. */
  port: number;
  /** `auto` (ACME, default), `custom` (cert/key from project secrets) or `off` (plain HTTP). */
  tls?: IngressTls;
  /** Names of project secrets holding the PEM certificate chain and private key; required for `tls: custom`. */
  cert?: string;
  key?: string;
}

/** What a backup captures: the output of a command run in a service, or the files of a volume. */
export type BackupType = 'command' | 'volume';

/** A restic keep policy; at least one key is required. */
export interface BackupRetention {
  last?: number;
  hourly?: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  yearly?: number;
}

/** `x-tug.backup` on a service or top-level volume, as an object. */
export interface BackupSpec {
  /** Five-field cron in UTC, or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. */
  schedule?: string;
  retention?: BackupRetention;
  /** Seconds of deterministic per-target delay after the scheduled minute. */
  jitter?: number;
  /** Hard limit for one run, such as `30m` or `2h`. */
  timeout?: string | number;
  /** Memory limit of the restic helper container, such as `256m` (default `512m`). */
  memory?: string;
  /** Services only: run in the service's container; its standard output is the backup. A string runs through `sh -c`. */
  command?: string | string[];
  /** Services only: run in the service container to restore; the stored file arrives on its standard input. */
  restore?: string | string[];
  /** Services only: name of the file inside the snapshot (default `<service>.out`). */
  filename?: string;
  /** Services only: text that must appear in the last 4 KiB of output, so a command cut short is not kept as a good backup. */
  verify?: string;
  /** Volumes only: restic exclude patterns. */
  exclude?: string[];
  /** Services to hold during a restore. */
  writers?: string[];
}

export type BackupConfig = boolean | string | BackupSpec;

export type RolloutStrategy = 'recreate' | 'rolling';

/** `x-tug.rollout`: how a service is replaced on a new deployment. `recreate` (default) is `docker compose up -d`. */
export interface RolloutSpec {
  strategy?: RolloutStrategy;
  /** How long the previous revision keeps running after the new one takes over (default `30s`); covers the ingress switch. */
  drain?: string | number;
}

/** The `x-tug` extension on a Compose service. */
export interface ServiceExtension {
  placement?: Placement;
  replicas?: number;
  global?: boolean;
  health?: HealthCheck;
  ingress?: IngressSpec;
  rollout?: RolloutSpec;
  backup?: BackupConfig;
}

/** The top-level `x-tug` extension of a Compose file. */
export interface ProjectExtension {
  /** `auto` creates a rollback deployment when a deployment fails on health; `manual` (default) only reports it. */
  rollback?: 'auto' | 'manual';
  /** Defaults for every `x-tug.backup` target; they enable nothing by themselves. */
  backup?: Pick<BackupSpec, 'schedule' | 'retention'>;
}

/** The `x-tug` extension on a top-level Compose volume. */
export interface VolumeExtension {
  type?: string;
  driver?: string;
  persistent?: boolean;
  placement?: Placement;
  backup?: BackupConfig;
}

export type BuildConfig =
  string | { context?: string; dockerfile?: string; [key: string]: unknown };
export type ComposeVolumeMount = string | { source?: string; [key: string]: unknown };

export interface ComposeService {
  image?: string;
  build?: BuildConfig;
  environment?: Record<string, unknown> | string[];
  volumes?: ComposeVolumeMount[];
  env_file?: string | string[];
  container_name?: string;
  deploy?: unknown;
  ports?: (
    string | number | { target?: number; published?: number | string; [key: string]: unknown }
  )[];
  extra_hosts?: string[] | Record<string, string>;
  depends_on?: string[] | Record<string, unknown>;
  'x-tug'?: ServiceExtension;
  [key: string]: unknown;
}

export interface ComposeVolume {
  'x-tug'?: VolumeExtension;
  [key: string]: unknown;
}

export interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, ComposeVolume>;
  'x-tug'?: ProjectExtension;
  [key: string]: unknown;
}

// ---- Desired state -----------------------------------------------------------------------------

export interface ImageArtifact {
  buildId: string;
  imageRef: string;
  imageId: string;
  platform: string;
  sha256: string;
  sizeBytes: number;
}
export interface LocalImageUpload {
  service: string;
  imageRef: string;
  imageId: string;
  platform: string;
  sha256: string;
  sizeBytes: number;
  field: string;
}

export interface ServiceSpec {
  artifact?: ImageArtifact;
  image?: string;
  build: BuildConfig | null;
  placement: Placement;
  replicas: number;
  health: HealthCheck | null;
}

export interface DesiredState {
  revision?: string;
  project: string;
  version: string;
  services: Record<string, ServiceSpec>;
  compose: ComposeFile;
}

// ---- Deployments -------------------------------------------------------------------------------

/** Deployment states during which a project is considered busy. */
export const ACTIVE_DEPLOYMENT_STATES = [
  'uploading',
  'building',
  'pending_dependencies',
  'rolling_out',
] as const;
/** Deployment states a CLI wait loop stops on. */
export const TERMINAL_DEPLOYMENT_STATES = [
  'succeeded',
  'failed',
  'build_failed',
  'cancelled',
] as const;
export type DeploymentState =
  (typeof ACTIVE_DEPLOYMENT_STATES)[number] | (typeof TERMINAL_DEPLOYMENT_STATES)[number];

// ---- Commands (control -> agent) ---------------------------------------------------------------

export type CommandType =
  | 'diagnostics.run'
  | 'service.restart'
  | 'logs.fetch'
  | 'volume.delete'
  | 'wg.rotate-key'
  | 'backup.check'
  | 'backup.run'
  | 'backup.restore'
  | 'backup.list';

/** Commands whose helper containers need the backup destination's credentials. */
export const BACKUP_COMMAND_TYPES: readonly CommandType[] = [
  'backup.check',
  'backup.run',
  'backup.restore',
  'backup.list',
];

/** `GET /agent/v1/backup/credentials`: environment for the restic helper of one running backup command. */
export interface BackupCredentialsResponse {
  env: Record<string, string>;
}

/** Why a command may be refused or a run marked missed; recorded on the run. */
export type BackupMissReason = 'node_offline' | 'control_down' | 'deadline';

export type JobPhase =
  'queued' | 'pulling' | 'checking' | 'dumping' | 'uploading' | 'forgetting' | 'restoring';

/** Payload of `backup.check`, `backup.run` and `backup.restore`. Restic credentials are never in a payload. */
export interface BackupJobPayload {
  runId: string;
  project: string;
  /** `service:db` or `volume:uploads`; empty for `backup.check`. */
  target: string;
  type: BackupType;
  /** The project's restic repository, `<destination>/<project>`. */
  repository: string;
  resticImage: string;
  /** Used as restic's `--host`, so each node keeps its own snapshot chain. */
  node: string;
  tags: string[];
  retention?: BackupRetention;
  /** Command targets: what to run in the service's container, and how to name and check its output. */
  command?: {
    service: string;
    argv: string[];
    filename: string;
    verify?: string;
    /** Run in the service container with the snapshot's file on stdin when restoring. */
    restoreArgv?: string[];
  };
  /** Volume targets: the Docker volume to mount read-only; it must already exist on the node. */
  volume?: {
    name: string;
    dockerVolume: string;
    exclude?: string[];
  };
  limits: { memory: string; timeoutSec: number };
  restore?: { snapshotId: string; mode: 'in-place' | 'scratch'; scratchVolume?: string };
}

export interface BackupJobResult {
  runId: string;
  snapshotId?: string;
  addedBytes?: number;
  totalBytes?: number;
  durationMs: number;
  resticVersion?: string;
  /** Repository state for `backup.check`. */
  repository?: 'ok' | 'initialized';
  warnings?: string[];
}

/** Live jobs in `StatusReport.jobs`, so control can tell "running" from "lost". */
export interface JobStatus {
  commandId: string;
  runId: string;
  phase: JobPhase;
  startedAt: string;
  bytes?: number;
}

/** A `commands` table row as delivered in `GET /agent/v1/work`. */
export interface Command {
  id: string;
  node_id?: string;
  project_id?: string | null;
  type: CommandType | (string & {});
  state?: string;
  payload_json?: string | null;
  /** Already-parsed payload; takes effect only when `payload_json` is not a string. */
  payload?: Record<string, unknown>;
  result_json?: string | null;
  attempts?: number;
  run_after?: string | null;
  deadline?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** One diagnostic result; `warning` flags something to look at that does not fail the check. */
export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  warning?: string;
}

export type CommandResultPayload =
  | { checks: DiagnosticCheck[]; node: string }
  | { project: string; service: string; restarted: true }
  | { stdout: string; stderr: string }
  | { project: string; volume: string; deleted: true }
  | { publicKey: string }
  | BackupJobResult
  | { error: string };

export interface CommandResult {
  commandId: string;
  state: 'succeeded' | 'failed';
  result: CommandResultPayload;
}

// ---- Agent streaming channel (M5) --------------------------------------------------------------

/**
 * Messages sent by control over the agent-initiated WebSocket. The stream is authenticated during the HTTP
 * upgrade, so credentials never appear in the URL or a message. A wake is only a hint: the agent fetches the
 * authoritative state from `/agent/v1/work` and continues periodic polling if notifications are lost.
 */
export type StreamMessage =
  | { type: 'ready'; nodeId: string; cursor: number }
  | { type: 'work-available'; cursor: number; project?: string };

/** Live operations always resolve their project/service placement on control before reaching an agent. */
export type LiveRequest =
  | {
      operation: 'exec';
      project: string;
      service: string;
      node?: string;
      command: string[];
      interactive: boolean;
      tty: boolean;
      columns?: number;
      rows?: number;
      /** Run the command in a new container cloned from the service's, instead of in the running one. */
      oneOff?: boolean;
    }
  | {
      operation: 'logs';
      project: string;
      service: string;
      node?: string;
      follow: true;
      tail: number;
    }
  | { operation: 'ps'; project: string; node?: string }
  | { operation: 'inspect'; project: string; service: string; node?: string };
export const LIVE_MAX_FRAME_BYTES = 256 * 1024;
export const LIVE_MAX_BUFFERED_BYTES = 1024 * 1024;
export const LIVE_MAX_SESSIONS = 64;
export const LIVE_START_TIMEOUT_MS = 10_000;
export type LiveInput =
  | { v: 1; type: 'live.stdin'; data: string }
  | { v: 1; type: 'live.stdin-end' }
  | { v: 1; type: 'live.resize'; columns: number; rows: number }
  | { v: 1; type: 'live.cancel' };
export type OperatorLiveFrame = { v: 1; type: 'live.open'; request: LiveRequest } | LiveInput;
export type AgentLiveCommand =
  | { v: 1; type: 'live.open'; sessionId: string; request: LiveRequest }
  | (LiveInput & { sessionId: string });
export type AgentLiveFrame =
  | { v: 1; type: 'live.started'; sessionId: string }
  | { v: 1; type: 'live.output'; sessionId: string; stream: 'stdout' | 'stderr'; data: string }
  | { v: 1; type: 'live.result'; sessionId: string; result: unknown }
  | {
      v: 1;
      type: 'live.exit';
      sessionId: string;
      code: number | null;
      signal: string | null;
      cancelled: boolean;
      error?: string;
    };
export type OperatorLiveMessage =
  | { v: 1; type: 'live.started'; sessionId: string; node: string }
  | { v: 1; type: 'live.output'; sessionId: string; stream: 'stdout' | 'stderr'; data: string }
  | { v: 1; type: 'live.result'; sessionId: string; value: unknown }
  | { v: 1; type: 'live.exit'; sessionId: string; code: number }
  | { v: 1; type: 'live.error'; sessionId?: string; message: string };

/** Response from the long-poll fallback used when a WebSocket cannot be established. */
export type WakeResponse = { type: 'work-available' | 'timeout'; cursor: number; project?: string };

// ---- GET /agent/v1/work ------------------------------------------------------------------------

export interface WorkResponse {
  serverTime: string;
  nodeId: string;
  desiredStates: DesiredState[];
  commands: Command[];
  retainedImages?: string[];
  /** WireGuard mesh config for this node; present only when the mesh is enabled on control. */
  network?: NetworkConfig;
  /** Healthy cross-node endpoints per project and service; present only when service DNS is enabled. */
  serviceEndpoints?: ServiceEndpoints;
  /** Edge proxy config; present only for nodes marked as ingress nodes. */
  ingress?: IngressWork;
  /** Host addresses for published ports that name no host IP. */
  ports?: PortBinding;
  /** Per project, services that must stay stopped because a restore is rewriting their data. */
  holds?: Record<string, string[]>;
}

/**
 * Where a node's published ports listen when a `ports` entry names no host IP. Entries with an
 * explicit host IP (including `0.0.0.0`) are never changed.
 */
export interface PortBinding {
  /** The node's overlay IP with the mesh, otherwise its `address` (an IP or a hostname the agent resolves); null binds to `127.0.0.1`. */
  address: string | null;
  /** Per project, services whose ingress port only the managed Caddy on this node dials; that port binds to `127.0.0.1`. */
  loopback: Record<string, string[]>;
}

// ---- Networking: WireGuard mesh, service DNS, ingress ------------------------------------------

export interface WgPeer {
  node: string;
  publicKey: string;
  /** `host:port` the peer can be dialed on; absent for nodes behind NAT (they dial out instead). */
  endpoint?: string;
  allowedIps: string[];
  persistentKeepalive: number;
}

/** The `network` block of `GET /agent/v1/work`: everything an agent needs to reconcile `wg0`. */
export interface NetworkConfig {
  interface: string;
  /** This node's overlay address, e.g. `10.210.0.2`. */
  overlayIp: string;
  /** Mesh CIDR, e.g. `10.210.0.0/16`; `overlayIp` is assigned to `wg0` with this prefix length. */
  cidr: string;
  listenPort: number;
  peers: WgPeer[];
}

/** Body of `POST /agent/v1/wireguard/key` (also accepted as `wgPublicKey` on register and enroll). */
export interface WgKeyRequest {
  publicKey: string;
}

export interface ServiceEndpoint {
  node: string;
  address: string;
  /** Host port of the serving revision; set only for rolling services, whose port changes per revision. */
  port?: number;
}
/** project -> service -> endpoints of nodes whose copy of the service reports `serving`. */
export type ServiceEndpoints = Record<string, Record<string, ServiceEndpoint[]>>;

export interface IngressRoute {
  project: string;
  service: string;
  host: string;
  tls: IngressTls;
  /** `host:port` upstreams, one per serving node (`127.0.0.1` for the ingress node itself). */
  upstreams: string[];
}

/** Edge config rendered by control for one ingress node. */
export interface IngressWork {
  caddyfile: string;
  /** Extra files for the Caddy container, keyed by path relative to `/etc/caddy` (custom TLS certs and keys). */
  files: Record<string, string>;
  routes: IngressRoute[];
  /** Routes control had to skip (no serving upstream, missing TLS secret), for operator visibility. */
  warnings: string[];
}

export interface IngressStatus {
  state: 'serving' | 'failed';
  /** sha256 of the applied Caddyfile and files. */
  configHash: string;
  routes: number;
  error?: string;
}

// ---- POST /agent/v1/status ---------------------------------------------------------------------

export type ProjectHealth = 'serving' | 'skipped' | 'failed';
export type RolloutState =
  | 'pending'
  | 'pulling'
  | 'starting'
  | 'health_checking'
  | 'serving'
  /** Stopped on purpose while a restore rewrites its data. */
  | 'held';

export interface ServiceState {
  rolloutState: RolloutState;
  image?: string;
  healthyAt?: string;
  /** Rolling services: published host port of the revision that is serving. */
  port?: number;
  /** Rolling services: hash identifying the serving revision. */
  rolloutRevision?: string;
  /** Rolling services: why the newest revision was rejected while this (older) one keeps serving. */
  rolloutError?: string;
}

export interface ProjectStatus {
  project: string;
  observedVersion: string;
  observedRevision?: string;
  health: ProjectHealth;
  services?: string[];
  serviceStates?: Record<string, ServiceState>;
  error?: string;
}

export interface StatusReport {
  node: string;
  /** The agent clock when it sent the report (ISO 8601); control derives clock skew from it. */
  sentAt?: string;
  projects: ProjectStatus[];
  commandResults: CommandResult[];
  ingress?: IngressStatus;
  /** Backup jobs still running on this node; absent when none. */
  jobs?: JobStatus[];
}

// ---- GET /agent/v1/secrets ---------------------------------------------------------------------

export interface SecretsResponse {
  registryAuth?: Record<string, { username: string; password: string }>;
  secrets: Record<string, string>;
  versions: Record<string, number>;
}

// ---- POST /agent/v1/events ---------------------------------------------------------------------

export interface AgentEvent {
  projectId?: string | null;
  deploymentId?: string | null;
  level?: string;
  type?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

// ---- Node registration / enrollment ------------------------------------------------------------

export interface NodeInfo {
  id: string;
  name: string;
  address: string | null;
  public_address: string | null;
  overlay_ip?: string | null;
  labels?: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

/** Body of `POST /api/v1/nodes/:name/identity`, posted by an admin with a CSR the node generated for its own key. */
export interface IdentityRequest {
  csr: string;
  /** `create` makes a new node (idempotent for the identical key); `replace` installs a new key on an existing node. */
  mode: 'create' | 'replace';
  address?: string;
  publicAddress?: string;
  labels?: string[];
}

/** Response of `POST /api/v1/nodes/:name/identity` and `POST /agent/v1/enroll`. */
export interface IdentityResponse {
  node: NodeInfo;
  certificate: string;
  /** PEM CA certificate every client pins. */
  ca: string;
  /** Credential-free HTTPS origin the certificate is verified against. */
  url: string;
}

/** Body of `POST /agent/v1/enroll`, authenticated by the bootstrap certificate. Name and labels come from its row. */
export interface EnrollRequest {
  csr: string;
  address?: string;
  publicAddress?: string;
  /** Base64 WireGuard public key; the private key never leaves the node. */
  wgPublicKey?: string;
}

/** Response of `POST /agent/v1/enroll`. */
export type EnrollResponse = IdentityResponse;

/** Body of `POST /agent/v1/renew`: a CSR for the node's existing key. */
export interface RenewRequest {
  csr: string;
}
export interface RenewResponse {
  certificate: string;
}

/** Response of `POST /api/v1/nodes/enrollment-credential`: the bootstrap credential, usable once for `POST /agent/v1/enroll`. */
export interface EnrollmentCredentialResponse {
  credential: { v: 1; url: string; ca: string; cert: string; key: string };
  name: string;
  labels: string[];
  expiresAt: string;
}

/** The base64url-encoded JSON payload of TUG_JOIN_KEY. */
export interface JoinKey {
  v: 2;
  /** The bootstrap credential. */
  credential: { v: 1; url: string; ca: string; cert: string; key: string };
  name: string;
  /** Connect-only target (for example a tunnel); verification always uses the credential's public url. */
  connectUrl?: string;
}
