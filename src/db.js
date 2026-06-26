import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'node:path';
import { ensureDir, now } from './util.js';

export async function openDb(filename = process.env.LAUNCHPAD_DB || './data/launchpad.db') {
  await ensureDir(path.dirname(filename));
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await migrate(db);
  return db;
}

async function migrate(db) {
  await db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, current_deployment_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, address TEXT, public_address TEXT, status TEXT, agent_token_hash TEXT, registry_token_hash TEXT, last_seen_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY, project_id TEXT, version TEXT, state TEXT, created_at TEXT, updated_at TEXT, error_message TEXT);
CREATE TABLE IF NOT EXISTS desired_states(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, version TEXT, state_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS node_statuses(id TEXT PRIMARY KEY, node_id TEXT, project_id TEXT, observed_version TEXT, status_json TEXT, health TEXT, updated_at TEXT, UNIQUE(node_id, project_id));
CREATE TABLE IF NOT EXISTS builds(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, service TEXT, source_hash TEXT, image_ref TEXT, state TEXT, logs_path TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, encrypted_value TEXT, version INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS volumes(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT, driver TEXT, node_id TEXT, config_json TEXT, created_at TEXT, updated_at TEXT, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, project_id TEXT, target TEXT, node_id TEXT, state TEXT, artifact_ref TEXT, metadata_json TEXT, created_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, node_id TEXT, project_id TEXT, type TEXT, state TEXT, payload_json TEXT, result_json TEXT, attempts INTEGER DEFAULT 0, run_after TEXT, deadline TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, node_id TEXT, level TEXT, type TEXT, message TEXT, metadata_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, created_at TEXT);
`);
  const row = await db.get('SELECT value FROM meta WHERE key = ?', 'schema_created_at');
  if (!row) await db.run('INSERT INTO meta(key,value) VALUES(?,?)', 'schema_created_at', now());
}
