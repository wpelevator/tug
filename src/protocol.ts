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

/** The `x-launchpad` extension on a Compose service. */
export interface ServiceExtension { placement?: Placement; replicas?: number; health?: HealthCheck }

/** The `x-launchpad` extension on a top-level Compose volume. */
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
  'x-launchpad'?: ServiceExtension;
  [key: string]: unknown;
}

export interface ComposeVolume { 'x-launchpad'?: VolumeExtension; [key: string]: unknown }

export interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, ComposeVolume>;
  [key: string]: unknown;
}

// ---- Desired state -----------------------------------------------------------------------------

export interface ServiceSpec {
  image?: string;
  build: BuildConfig | null;
  placement: Placement;
  replicas: number;
  health: HealthCheck | null;
}

export interface DesiredState {
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

export type CommandType = 'diagnostics.run' | 'service.restart' | 'logs.fetch' | 'volume.delete';

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
}

// ---- POST /agent/v1/status ---------------------------------------------------------------------

export type ProjectHealth = 'serving' | 'skipped' | 'failed';
export type RolloutState = 'pending' | 'pulling' | 'starting' | 'health_checking' | 'serving';

export interface ServiceState { rolloutState: RolloutState; image?: string; healthyAt?: string }

export interface ProjectStatus {
  project: string;
  observedVersion: string;
  health: ProjectHealth;
  services?: string[];
  serviceStates?: Record<string, ServiceState>;
  error?: string;
}

export interface StatusReport {
  node: string;
  projects: ProjectStatus[];
  commandResults: CommandResult[];
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

/** The base64url-encoded JSON payload of LAUNCHPAD_JOIN_KEY. */
export interface JoinKey {
  v: number;
  controlUrl?: string;
  enrollToken: string;
  /** PEM CA certificate to trust for a private/self-signed control plane. */
  ca?: string;
}
