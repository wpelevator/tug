// Single source of truth for everything that crosses the control <-> agent boundary and for the
// desired-state shape persisted in `desired_states.state_json`. Types plus a few shared constants;
// control.ts, agent.ts, compose.ts and cli.ts all import from here.

// ---- Compose input (what the operator deploys) -------------------------------------------------

export interface Placement { nodes?: string[] }

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

export type RolloutStrategy = 'recreate' | 'rolling';

/** `x-tug.rollout`: how a service is replaced on a new deployment. `recreate` (default) is `docker compose up -d`. */
export interface RolloutSpec {
  strategy?: RolloutStrategy;
  /** How long the previous revision keeps running after the new one takes over (default `30s`); covers the ingress switch. */
  drain?: string | number;
}

/** The `x-tug` extension on a Compose service. */
export interface ServiceExtension { placement?: Placement; replicas?: number; health?: HealthCheck; ingress?: IngressSpec; rollout?: RolloutSpec }

/** The top-level `x-tug` extension of a Compose file. */
export interface ProjectExtension {
  /** `auto` creates a rollback deployment when a deployment fails on health; `manual` (default) only reports it. */
  rollback?: 'auto' | 'manual';
}

/** The `x-tug` extension on a top-level Compose volume. */
export interface VolumeExtension {
  type?: string;
  driver?: string;
  persistent?: boolean;
  placement?: Placement;
}

export type BuildConfig = string | { context?: string; dockerfile?: string; [key: string]: unknown };
export type ComposeVolumeMount = string | { source?: string; [key: string]: unknown };

export interface ComposeService {
  image?: string;
  build?: BuildConfig;
  environment?: Record<string, unknown> | string[];
  volumes?: ComposeVolumeMount[];
  env_file?: string | string[];
  container_name?: string;
  deploy?: unknown;
  ports?: (string | number | { target?: number; published?: number | string; [key: string]: unknown })[];
  extra_hosts?: string[] | Record<string, string>;
  depends_on?: string[] | Record<string, unknown>;
  'x-tug'?: ServiceExtension;
  [key: string]: unknown;
}

export interface ComposeVolume { 'x-tug'?: VolumeExtension; [key: string]: unknown }

export interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, ComposeVolume>;
  'x-tug'?: ProjectExtension;
  [key: string]: unknown;
}

// ---- Desired state -----------------------------------------------------------------------------

export interface ImageArtifact { buildId: string; imageRef: string; imageId: string; platform: string; sha256: string; sizeBytes: number }
export interface LocalImageUpload { service: string; imageRef: string; imageId: string; platform: string; sha256: string; sizeBytes: number; field: string }

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
export const ACTIVE_DEPLOYMENT_STATES = ['uploading', 'building', 'pending_dependencies', 'rolling_out'] as const;
/** Deployment states a CLI wait loop stops on. */
export const TERMINAL_DEPLOYMENT_STATES = ['succeeded', 'failed', 'build_failed', 'cancelled'] as const;
export type DeploymentState = (typeof ACTIVE_DEPLOYMENT_STATES)[number] | (typeof TERMINAL_DEPLOYMENT_STATES)[number];

// ---- Commands (control -> agent) ---------------------------------------------------------------

export type CommandType = 'diagnostics.run' | 'service.restart' | 'logs.fetch' | 'volume.delete' | 'wg.rotate-key';

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

export interface DiagnosticCheck { name: string; ok: boolean; stdout?: string; stderr?: string; error?: string }

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
export interface WgKeyRequest { publicKey: string }

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
  status: string;
  created_at: string;
  updated_at: string;
}

/** Response of `POST /api/v1/nodes/register`. */
export interface RegisterResponse { node: NodeInfo; agentToken: string; registryToken: string }

/** Body of `POST /agent/v1/enroll`. */
export interface EnrollRequest {
  enrollToken?: string;
  name?: string;
  address?: string;
  publicAddress?: string;
  /** Base64 WireGuard public key; the private key never leaves the node. */
  wgPublicKey?: string;
}

/** Response of `POST /agent/v1/enroll`. */
export interface EnrollResponse extends RegisterResponse { registry: string }

/** Response of `POST /api/v1/nodes/enroll-token`. */
export interface EnrollTokenResponse {
  enrollToken: string;
  name: string | null;
  usesRemaining: number;
  expiresAt: string;
  registry: string;
}

/** The base64url-encoded JSON payload of TUG_JOIN_KEY. */
export interface JoinKey {
  v: number;
  controlUrl?: string;
  enrollToken: string;
  /** PEM CA certificate to trust for a private/self-signed control plane. */
  ca?: string;
}
