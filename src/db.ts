import { connectNodeDb } from './db-node.ts';
import type { ConnectDb, Db } from './db-driver.ts';
export type { Db } from './db-driver.ts';
import path from 'node:path';
import { ensureDir, now } from './util.ts';

// One composition point for all writable and snapshot connections.
export const { openDb, openAgentDb, openSnapshotDb } = databaseAccess(connectNodeDb);

function configure(db: Db, writable: boolean, initialize?: (db: Db) => void): Db {
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');
    if (writable) db.exec('PRAGMA journal_mode = WAL;');
    initialize?.(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* Preserve the initialization failure. */
    }
    throw error;
  }
}

// Row shapes for the tables the control plane and agent read back (columns mirror the DDL below).
export interface ProjectRow {
  id: string;
  name: string;
  current_deployment_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface NodeRow {
  id: string;
  name: string;
  address: string | null;
  public_address: string | null;
  overlay_ip: string | null;
  ingress: number;
  ingress_status_json: string | null;
  status: string;
  labels_json: string | null;
  agent_token_hash: string | null;
  registry_token_hash: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface WgPeerRow {
  node_id: string;
  public_key: string;
  overlay_ip: string;
  endpoint: string | null;
  allowed_ips: string;
  updated_at: string;
}
export interface EnrollTokenRow {
  token_hash: string;
  name: string | null;
  uses_remaining: number;
  expires_at: string;
  created_at: string;
}
export interface DeploymentRow {
  id: string;
  project_id: string;
  version: string;
  state: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  actor: string | null;
}
export interface DesiredStateRow {
  id: string;
  project_id: string;
  deployment_id: string;
  version: string;
  state_json: string;
  created_at: string;
}
export interface NodeStatusRow {
  id: string;
  node_id: string;
  project_id: string;
  observed_version: string;
  status_json: string;
  health: string;
  updated_at: string;
}
export interface SecretRow {
  id: string;
  project_id: string;
  name: string;
  encrypted_value: string;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface VolumeRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  driver: string | null;
  node_id: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}
export interface CommandRow {
  id: string;
  node_id: string;
  project_id: string | null;
  type: string;
  state: string;
  payload_json: string | null;
  result_json: string | null;
  attempts: number;
  run_after: string | null;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}
export interface LockRow {
  name: string;
  owner: string;
  expires_at: string;
  created_at: string;
}
/** What the agent last announced for a project's recreated services, so unchanged polls stay silent. */
export interface EventStateRow {
  project: string;
  fingerprint: string;
  phase: 'serving' | 'failed';
}
export interface AppliedStateRow {
  project: string;
  version: string;
  revision: string | null;
  applied_at: string;
  service_states_json: string;
  secret_versions_json: string;
}

/** Shared policy for every driver, including read-only restore validation. */
export function databaseAccess(connect: ConnectDb) {
  function openSnapshotDb(filename: string): Db {
    return configure(connect(filename, { readOnly: true }), false);
  }

  async function openDb(filename: string): Promise<Db> {
    await ensureDir(path.dirname(filename));
    return configure(connect(filename, { readOnly: false }), true, initializeControl);
  }

  async function openAgentDb(filename: string): Promise<Db> {
    await ensureDir(path.dirname(filename));
    return configure(connect(filename, { readOnly: false }), true, (db) =>
      db.exec(`
CREATE TABLE IF NOT EXISTS applied_state(
  project TEXT PRIMARY KEY,
  version TEXT,
  revision TEXT,
  applied_at TEXT,
  service_states_json TEXT,
  secret_versions_json TEXT
);
CREATE TABLE IF NOT EXISTS event_state(
  project TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  phase TEXT NOT NULL
);
`),
    );
  }

  return { openDb, openAgentDb, openSnapshotDb };
}

function initializeControl(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, current_deployment_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, address TEXT, public_address TEXT, overlay_ip TEXT UNIQUE, ingress INTEGER NOT NULL DEFAULT 0, ingress_status_json TEXT, status TEXT, labels_json TEXT, agent_token_hash TEXT, registry_token_hash TEXT, last_seen_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS wg_peers(node_id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, overlay_ip TEXT NOT NULL, endpoint TEXT, allowed_ips TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS enroll_tokens(token_hash TEXT PRIMARY KEY, name TEXT, uses_remaining INTEGER, expires_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY, project_id TEXT, version TEXT, state TEXT, created_at TEXT, updated_at TEXT, error_message TEXT, actor TEXT);
CREATE TABLE IF NOT EXISTS desired_states(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, version TEXT, state_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS node_statuses(id TEXT PRIMARY KEY, node_id TEXT, project_id TEXT, observed_version TEXT, status_json TEXT, health TEXT, updated_at TEXT, UNIQUE(node_id, project_id));
CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, service TEXT, source_hash TEXT, image_ref TEXT, image_id TEXT, platform TEXT, sha256 TEXT, size_bytes INTEGER, artifact_path TEXT, state TEXT, logs_path TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, encrypted_value TEXT, version INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS volumes(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT, driver TEXT, node_id TEXT, config_json TEXT, created_at TEXT, updated_at TEXT, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, project_id TEXT, target TEXT, node_id TEXT, state TEXT, artifact_ref TEXT, metadata_json TEXT, created_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, node_id TEXT, project_id TEXT, type TEXT, state TEXT, payload_json TEXT, result_json TEXT, attempts INTEGER DEFAULT 0, run_after TEXT, deadline TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, node_id TEXT, level TEXT, type TEXT, message TEXT, metadata_json TEXT, created_at TEXT, actor TEXT);
CREATE INDEX IF NOT EXISTS events_project_created ON events(project_id, created_at);
CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL, projects_json TEXT, created_at TEXT, created_by TEXT, last_used_at TEXT, expires_at TEXT, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS events_by_time ON events(created_at);
CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, created_at TEXT);
`);
  const row = db.get('SELECT value FROM meta WHERE key = ?', 'schema_created_at');
  if (!row) db.run('INSERT INTO meta(key,value) VALUES(?,?)', 'schema_created_at', now());
}
