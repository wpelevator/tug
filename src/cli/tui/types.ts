import type { Role } from '../../roles.ts';
import type { StatusResponse } from '../status.ts';

/** The views `tug tui` can show. A view plus its optional filters is a `ViewRef`; the stack of them is the breadcrumb. */
export const VIEW_NAMES = [
  'overview',
  'projects',
  'nodes',
  'services',
  'deployments',
  'events',
  'backups',
  'restores',
  'domains',
  'volumes',
  'secrets',
  'credentials',
  'project',
  'node',
  'placement',
] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export interface ViewRef {
  name: ViewName;
  project?: string;
  service?: string;
  node?: string;
}

export interface EventRow {
  id: string;
  project_id: string | null;
  node_id: string | null;
  level: string;
  type: string;
  message: string;
  created_at: string;
  actor: string | null;
}
export interface BackupTarget {
  target: string;
  node: string | null;
  schedule: string;
  enabled: boolean;
  nextRunAt: string;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  problem: string | null;
}
export interface BackupRun {
  id: string;
  target: string;
  state: string;
  trigger: string;
  snapshot_id: string | null;
  size_bytes: number | null;
  finished_at: string | null;
  queued_at: string | null;
  error: string | null;
}
export interface BackupListing {
  destinationConfigured: boolean;
  targets: BackupTarget[];
  runs: BackupRun[];
}
export interface RestoreRow {
  id: string;
  target: string;
  state: string;
  mode?: string;
  node_id?: string | null;
  started_at?: string | null;
  state_changed_at?: string | null;
  error?: string | null;
}
export interface NodeRow {
  id: string;
  name: string;
  status: string;
  address: string | null;
  ingress: number | boolean;
  labels: string[];
  last_seen_at: string | null;
  disabled_at?: string | null;
  cert_not_after?: string | null;
  connected?: boolean;
}
export interface Diagnostics {
  ok: boolean;
  checks?: { name: string; ok: boolean; error?: string; warnings?: string[] }[];
}
export interface Who {
  name: string;
  role: Role;
  projects: string[] | null;
}

/** The last answer for one resource, how fresh it is, and the last failure to fetch it. */
export interface Feed<T> {
  data?: T;
  fetchedAt?: number;
  error?: string;
}
/** Everything the screen knows about the control plane. Fed by the poller, read by pure functions. */
export interface Snapshot {
  status: Feed<StatusResponse>;
  events: Feed<EventRow[]>;
  nodes: Feed<NodeRow[]>;
  backups: Feed<Record<string, BackupListing>>;
  restores: Feed<Record<string, RestoreRow[]>>;
  diagnostics: Feed<Diagnostics>;
  version: Feed<string>;
  whoami: Feed<Who>;
  /** Whether the push channel from control is open; when it is, polling only backs it up. */
  watch: { connected: boolean };
  /** On-demand lists keyed by `<view>:<project>`: domains, volumes, secrets and credentials. */
  lists: Record<string, Feed<Record<string, unknown>[]>>;
}
export const emptySnapshot = (): Snapshot => ({
  status: {},
  events: {},
  nodes: {},
  backups: {},
  restores: {},
  diagnostics: {},
  version: {},
  whoami: {},
  watch: { connected: false },
  lists: {},
});

export type Tone = 'ok' | 'warn' | 'error' | 'dim' | 'plain';
/** What an action needs from the selected row. */
export interface RowContext {
  project?: string;
  service?: string;
  node?: string;
  deployment?: string;
  deploymentState?: string;
  backupTarget?: string;
}
export interface Row {
  /** Stable identity, so the selection survives a refresh that reorders rows. */
  key: string;
  cells: string[];
  tone?: Tone;
  /** Where Enter goes. */
  open?: ViewRef;
  context?: RowContext;
  /** The row as structured data, for `d`escribe. */
  record?: unknown;
}
export interface Table {
  columns: string[];
  /** The column that matters most (the reason or message): it is the last to shrink on a narrow terminal. Negative counts from the end. */
  primary?: number;
  rows: Row[];
  empty: string;
}

export type AttentionRank = 1 | 2 | 3 | 4;
export interface Attention {
  rank: AttentionRank;
  /** Stable identity of the problem, for selection. */
  key: string;
  subject: string;
  reason: string;
  /** When the problem began, when known. */
  since?: string;
  target: ViewRef;
  context?: RowContext;
}
export interface Counters {
  nodesOnline: number;
  nodesTotal: number;
  projects: number;
  servicesServing: number;
  servicesTotal: number;
  backupProblems: number;
  eventErrors: number;
  eventWarnings: number;
  attention: number;
}
