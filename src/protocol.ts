// Single source of truth for everything that crosses the control <-> agent boundary and for the
// desired-state shape persisted in `desired_states.state_json`. Types plus a few shared constants;
// control.ts, agent.ts, compose.ts and cli.ts all import from here.

// ---- Compose input (what the operator deploys) -------------------------------------------------

export interface Placement {
  nodes?: string[];
  labels?: string[];
  global?: boolean;
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

export type BackupType = 'mariadb' | 'mysql' | 'volume';

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
  type?: BackupType;
  /** Five-field cron in UTC, or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. */
  schedule?: string;
  retention?: BackupRetention;
  /** Seconds of deterministic per-target delay after the scheduled minute. */
  jitter?: number;
  /** Hard limit for one run, such as `30m` or `2h`. */
  timeout?: string | number;
  databases?: string[];
  user?: string;
  /** Name of the project secret holding the database user's password. */
  password?: string;
  exclude?: string[];
  writers?: string[];
}

/** `true`, `false`, a cron string, or the object form. */
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
  'diagnostics.run' | 'service.restart' | 'logs.fetch' | 'volume.delete' | 'wg.rotate-key';

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
export type RolloutState = 'pending' | 'pulling' | 'starting' | 'health_checking' | 'serving';

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
  projects: ProjectStatus[];
  commandResults: CommandResult[];
  ingress?: IngressStatus;
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

/** Response of `POST /api/v1/nodes/register`. */
export interface RegisterResponse {
  node: NodeInfo;
  agentToken: string;
}

/** Body of `POST /agent/v1/enroll`. */
export interface EnrollRequest {
  enrollToken?: string;
  name?: string;
  address?: string;
  publicAddress?: string;
  /** Base64 WireGuard public key; the private key never leaves the node. */
  wgPublicKey?: string;
  /** Node labels (tags) used for label-based placement. */
  labels?: string[];
}

/** Response of `POST /agent/v1/enroll`. */
export type EnrollResponse = RegisterResponse;

/** Response of `POST /api/v1/nodes/enroll-token`. */
export interface EnrollTokenResponse {
  enrollToken: string;
  name: string | null;
  usesRemaining: number;
  expiresAt: string;
}

/** The base64url-encoded JSON payload of TUG_JOIN_KEY. */
export interface JoinKey {
  v: number;
  controlUrl?: string;
  enrollToken: string;
  /** PEM CA certificate to trust for a private/self-signed control plane. */
  ca?: string;
  /** Node labels to register at enrollment. */
  labels?: string[];
}
