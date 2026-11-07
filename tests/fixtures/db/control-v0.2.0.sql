-- Schema of the v0.2.0 release's control database (taken from that tag's source), with a few rows.
CREATE TABLE applied_state(
  project TEXT PRIMARY KEY,
  version TEXT,
  revision TEXT,
  applied_at TEXT,
  service_states_json TEXT,
  secret_versions_json TEXT
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, current_deployment_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE nodes(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, address TEXT, public_address TEXT, overlay_ip TEXT UNIQUE, ingress INTEGER NOT NULL DEFAULT 0, ingress_status_json TEXT, status TEXT, agent_token_hash TEXT, registry_token_hash TEXT, last_seen_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE wg_peers(node_id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, overlay_ip TEXT NOT NULL, endpoint TEXT, allowed_ips TEXT NOT NULL, updated_at TEXT);
CREATE TABLE enroll_tokens(token_hash TEXT PRIMARY KEY, name TEXT, uses_remaining INTEGER, expires_at TEXT, created_at TEXT);
CREATE TABLE deployments(id TEXT PRIMARY KEY, project_id TEXT, version TEXT, state TEXT, created_at TEXT, updated_at TEXT, error_message TEXT, actor TEXT);
CREATE TABLE desired_states(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, version TEXT, state_json TEXT, created_at TEXT);
CREATE TABLE node_statuses(id TEXT PRIMARY KEY, node_id TEXT, project_id TEXT, observed_version TEXT, status_json TEXT, health TEXT, updated_at TEXT, UNIQUE(node_id, project_id));
CREATE TABLE builds(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, service TEXT, source_hash TEXT, image_ref TEXT, image_id TEXT, platform TEXT, sha256 TEXT, size_bytes INTEGER, artifact_path TEXT, state TEXT, logs_path TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE secrets(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, encrypted_value TEXT, version INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(project_id, name));
CREATE TABLE volumes(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT, driver TEXT, node_id TEXT, config_json TEXT, created_at TEXT, updated_at TEXT, UNIQUE(project_id, name));
CREATE TABLE backups(id TEXT PRIMARY KEY, project_id TEXT, target TEXT, node_id TEXT, state TEXT, artifact_ref TEXT, metadata_json TEXT, created_at TEXT, completed_at TEXT);
CREATE TABLE commands(id TEXT PRIMARY KEY, node_id TEXT, project_id TEXT, type TEXT, state TEXT, payload_json TEXT, result_json TEXT, attempts INTEGER DEFAULT 0, run_after TEXT, deadline TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE events(id TEXT PRIMARY KEY, project_id TEXT, deployment_id TEXT, node_id TEXT, level TEXT, type TEXT, message TEXT, metadata_json TEXT, created_at TEXT, actor TEXT);
CREATE INDEX events_project_created ON events(project_id, created_at);
CREATE TABLE api_tokens(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL, projects_json TEXT, created_at TEXT, created_by TEXT, last_used_at TEXT, expires_at TEXT, revoked_at TEXT);
CREATE TABLE locks(name TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, created_at TEXT);
INSERT INTO projects(id,name,current_deployment_id,created_at,updated_at) VALUES('p1','site','d1','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
INSERT INTO nodes(id,name,address,status,created_at,updated_at) VALUES('node_a','app1','10.0.0.5','online','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
INSERT INTO deployments(id,project_id,version,state,created_at,updated_at) VALUES('d1','p1','v1','succeeded','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
INSERT INTO meta(key,value) VALUES('schema_created_at','2026-10-01T00:00:00Z');
