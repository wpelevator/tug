#!/usr/bin/env node
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import * as tar from 'tar';
import { openDb } from './db.js';
import { encrypt, decrypt, loadOrCreateMasterKey } from './secrets.js';
import { buildDesiredState, validateCompose } from './compose.js';
import { buildAndPush, unpackContext, run as runCommand } from './build.js';
import { ensureDir, hashToken, id, now, token } from './util.js';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.LAUNCHPAD_DATA_DIR || './data';
const upload = multer({ dest: process.env.LAUNCHPAD_UPLOAD_DIR || path.join(DATA_DIR, 'uploads') });

export async function createApp() {
  const dbFile = process.env.LAUNCHPAD_DB || path.join(DATA_DIR, 'launchpad.db');
  const masterKeyFile = process.env.LAUNCHPAD_MASTER_KEY_FILE || path.join(DATA_DIR, 'master.key');
  const REGISTRY = process.env.LAUNCHPAD_REGISTRY || 'localhost:5000';
  const REGISTRY_AUTH_PATH = process.env.LAUNCHPAD_REGISTRY_AUTH_PATH || null;
  const REGISTRY_CONTAINER = process.env.LAUNCHPAD_REGISTRY_CONTAINER || null;

  let htpasswdQueue = Promise.resolve();
  function withHtpasswdLock(fn) {
    const next = htpasswdQueue.catch(() => {}).then(fn);
    htpasswdQueue = next.catch(() => {});
    return next;
  }
  async function reloadRegistry() {
    if (!REGISTRY_CONTAINER) return;
    await runCommand('docker', ['restart', REGISTRY_CONTAINER]).catch(e => console.error(`registry reload failed: ${e.message}`));
  }
  async function upsertRegistryCredential(name, password) {
    if (!REGISTRY_AUTH_PATH) return;
    await withHtpasswdLock(async () => {
      const { out } = await runCommand('htpasswd', ['-nbB', name, password]);
      const line = out.trim();
      let existing = '';
      try { existing = await fs.readFile(REGISTRY_AUTH_PATH, 'utf8'); } catch {}
      const lines = existing.split('\n').filter(Boolean).filter(l => !l.startsWith(`${name}:`));
      lines.push(line);
      await ensureDir(path.dirname(REGISTRY_AUTH_PATH));
      await fs.writeFile(REGISTRY_AUTH_PATH, `${lines.join('\n')}\n`);
    });
    await reloadRegistry();
  }
  async function removeRegistryCredential(name) {
    if (!REGISTRY_AUTH_PATH) return;
    await withHtpasswdLock(async () => {
      let existing = '';
      try { existing = await fs.readFile(REGISTRY_AUTH_PATH, 'utf8'); } catch {}
      const lines = existing.split('\n').filter(Boolean).filter(l => !l.startsWith(`${name}:`));
      await ensureDir(path.dirname(REGISTRY_AUTH_PATH));
      await fs.writeFile(REGISTRY_AUTH_PATH, lines.length ? `${lines.join('\n')}\n` : '');
    });
    await reloadRegistry();
  }

  const db = await openDb(dbFile);
  const masterKey = await loadOrCreateMasterKey(masterKeyFile);
  let operator = await db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash');
  if (!operator) {
    const t = process.env.LAUNCHPAD_OPERATOR_TOKEN || token('lpo');
    await db.run('INSERT INTO meta(key,value) VALUES(?,?)', 'operator_token_hash', hashToken(t));
    await fs.writeFile(path.join(DATA_DIR, 'operator.token'), `${t}\n`, { mode: 0o600 }).catch(()=>{});
    console.log(`operator token: ${t}`);
  }

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const authOperator = async (req, res, next) => {
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const row = await db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash');
    if (!raw || hashToken(raw) !== row?.value) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  const authAgent = async (req, res, next) => {
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const node = raw && await db.get('SELECT * FROM nodes WHERE agent_token_hash=?', hashToken(raw));
    if (!node) return res.status(401).json({ error: 'unauthorized' });
    req.node = node; next();
  };

  async function updateDeploymentConvergence(projectId) {
    const project = await db.get('SELECT * FROM projects WHERE id=?', projectId);
    if (!project?.current_deployment_id) return;
    const ds = await db.get('SELECT * FROM desired_states WHERE deployment_id=?', project.current_deployment_id);
    if (!ds) return;
    const state = JSON.parse(ds.state_json);
    const required = new Set();
    for (const svc of Object.values(state.services || {})) for (const node of svc.placement?.nodes || []) required.add(node);
    if (!required.size) return;
    const statuses = await db.all('SELECT node_id,observed_version,health FROM node_statuses WHERE project_id=?', projectId);
    const byNode = new Map(statuses.map(s => [s.node_id, s]));
    const failed = [...required].some(node => byNode.get(node)?.observed_version === state.version && byNode.get(node)?.health === 'failed');
    if (failed) await db.run('UPDATE deployments SET state=?,error_message=?,updated_at=? WHERE id=? AND state=?', 'failed', 'one or more assigned nodes reported failed health', now(), project.current_deployment_id, 'rolling_out');
    const ok = [...required].every(node => byNode.get(node)?.observed_version === state.version && ['serving', 'skipped'].includes(byNode.get(node)?.health));
    if (ok) await db.run('UPDATE deployments SET state=?,updated_at=? WHERE id=? AND state=?', 'succeeded', now(), project.current_deployment_id, 'rolling_out');
  }

  async function currentDesired(projectId) {
    return db.get('SELECT ds.* FROM desired_states ds JOIN projects p ON p.current_deployment_id=ds.deployment_id WHERE p.id=?', projectId);
  }

  async function acquireProjectLock(project, operation, ttlMs = Number(process.env.LAUNCHPAD_LOCK_TTL_MS || 10 * 60 * 1000)) {
    const name = `project:${project}`;
    const ts = now();
    await db.run('DELETE FROM locks WHERE expires_at < ?', ts);
    const owner = `${operation}:${id('lock')}`;
    try {
      await db.run('INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)', name, owner, new Date(Date.now() + ttlMs).toISOString(), ts);
    } catch (e) {
      if (!/UNIQUE constraint/.test(e.message)) throw e;
      const existing = await db.get('SELECT * FROM locks WHERE name=?', name);
      const err = new Error(`project ${project} is locked by ${existing?.owner} until ${existing?.expires_at}`);
      err.status = 409; err.lock = existing; throw err;
    }
    return { name, owner };
  }
  async function releaseLock(lock) {
    if (lock) await db.run('DELETE FROM locks WHERE name=? AND owner=?', lock.name, lock.owner).catch(()=>{});
  }
  function sendError(res, e) { res.status(e.status || 500).json({ error: e.message, lock: e.lock || undefined }); }

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.post('/api/v1/projects', authOperator, async (req, res) => {
    const name = req.body.name || 'site'; const ts = now();
    await db.run('INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', name, name, ts, ts);
    res.json(await db.get('SELECT * FROM projects WHERE id=?', name));
  });
  app.get('/api/v1/projects/:project', authOperator, async (req, res) => res.json(await db.get('SELECT * FROM projects WHERE id=?', req.params.project)));

  app.post('/api/v1/nodes/register', authOperator, async (req, res) => {
    const name = req.body.name; if (!name) return res.status(400).json({ error: 'name required' });
    const agentToken = token('lpa'); const registryToken = token('lpr'); const ts = now();
    await db.run(`INSERT INTO nodes(id,name,address,public_address,status,agent_token_hash,registry_token_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,public_address=excluded.public_address,agent_token_hash=excluded.agent_token_hash,registry_token_hash=excluded.registry_token_hash,updated_at=excluded.updated_at`,
      name, name, req.body.address || null, req.body.publicAddress || null, 'registered', hashToken(agentToken), hashToken(registryToken), ts, ts);
    await upsertRegistryCredential(name, registryToken);
    res.json({ node: await db.get('SELECT id,name,address,public_address,status,created_at,updated_at FROM nodes WHERE id=?', name), agentToken, registryToken });
  });
  app.get('/api/v1/nodes', authOperator, async (req, res) => res.json({ nodes: await db.all('SELECT id,name,address,public_address,status,last_seen_at,created_at,updated_at FROM nodes ORDER BY name') }));
  app.post('/api/v1/nodes/:name/rotate-registry-token', authOperator, async (req, res) => {
    const node = await db.get('SELECT id,name FROM nodes WHERE name=? OR id=?', req.params.name, req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    const registryToken = token('lpr');
    await db.run('UPDATE nodes SET registry_token_hash=?,updated_at=? WHERE id=?', hashToken(registryToken), now(), node.id);
    await upsertRegistryCredential(node.name, registryToken);
    res.json({ ok: true, node: node.name, registryToken });
  });
  app.post('/api/v1/nodes/:name/revoke-registry-token', authOperator, async (req, res) => {
    const node = await db.get('SELECT id,name FROM nodes WHERE name=? OR id=?', req.params.name, req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    await db.run('UPDATE nodes SET registry_token_hash=NULL,updated_at=? WHERE id=?', now(), node.id);
    await removeRegistryCredential(node.name);
    res.json({ ok: true, node: node.name, revoked: true });
  });
  app.post('/api/v1/registry/auth', async (req, res) => {
    const username = req.body.username;
    const password = req.body.password;
    const node = username && password ? await db.get('SELECT id,name FROM nodes WHERE (name=? OR id=?) AND registry_token_hash IS NOT NULL AND registry_token_hash=?', username, username, hashToken(password)) : null;
    if (!node) return res.status(401).json({ ok: false, error: 'invalid registry credentials' });
    res.json({ ok: true, node: node.name });
  });

  app.post('/api/v1/secrets', authOperator, async (req, res) => {
    const { project='site', name, value } = req.body; if (!name || value == null) return res.status(400).json({ error: 'name and value required' });
    let lock;
    try {
      lock = await acquireProjectLock(project, 'secret.set');
      const old = await db.get('SELECT version FROM secrets WHERE project_id=? AND name=?', project, name); const ts = now();
      await db.run(`INSERT INTO secrets(id,project_id,name,encrypted_value,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(project_id,name) DO UPDATE SET encrypted_value=excluded.encrypted_value,version=excluded.version,updated_at=excluded.updated_at`,
        id('sec'), project, name, encrypt(value, masterKey), (old?.version || 0) + 1, ts, ts);
      res.json({ ok: true, name, version: (old?.version || 0) + 1 });
    } catch (e) { sendError(res, e); }
    finally { await releaseLock(lock); }
  });
  app.get('/api/v1/secrets', authOperator, async (req, res) => res.json({ secrets: await db.all('SELECT project_id,name,version,updated_at FROM secrets WHERE project_id=? ORDER BY name', req.query.project || 'site') }));
  app.delete('/api/v1/secrets/:name', authOperator, async (req, res) => { await db.run('DELETE FROM secrets WHERE project_id=? AND name=?', req.query.project || 'site', req.params.name); res.json({ ok: true }); });

  app.post('/api/v1/deployments', authOperator, upload.single('context'), async (req, res) => {
    const body = req.file ? JSON.parse(req.body.payload) : req.body;
    const project = body.project || 'site'; const compose = body.compose; const version = body.version || `git-${Date.now()}`;
    const nodes = await db.all('SELECT name FROM nodes'); validateCompose(compose, nodes.map(n => n.name));
    const active = await db.get('SELECT id,state FROM deployments WHERE project_id=? AND state IN (\'uploading\',\'building\',\'pending_dependencies\',\'rolling_out\') ORDER BY created_at DESC LIMIT 1', project);
    if (active) return res.status(409).json({ error: `deployment ${active.id} is already ${active.state}` });
    const depId = id('dep'); const ts = now();
    let lock;
    try {
      lock = await acquireProjectLock(project, 'deploy');
      await db.run('INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', project, project, ts, ts);
      await db.run('INSERT INTO deployments(id,project_id,version,state,created_at,updated_at) VALUES(?,?,?,?,?,?)', depId, project, version, 'building', ts, ts);
      const desired = buildDesiredState({ project, version, compose, registry: REGISTRY, defaultNode: nodes[0]?.name || null });
      if (req.file) {
        const contextDir = path.resolve(DATA_DIR, 'build-contexts', depId); await unpackContext(req.file.path, contextDir);
        for (const [svc, spec] of Object.entries(compose.services)) if (spec.build) await buildAndPush({ contextDir, service: svc, buildSpec: spec.build, imageRef: desired.services[svc].image, push: process.env.LAUNCHPAD_PUSH !== 'false' });
      }
      await db.run('INSERT INTO desired_states(id,project_id,deployment_id,version,state_json,created_at) VALUES(?,?,?,?,?,?)', id('ds'), project, depId, version, JSON.stringify(desired), ts);
      for (const [volumeName, volumeSpec] of Object.entries(compose.volumes || {})) {
        const lp = volumeSpec?.['x-launchpad'] || {};
        const nodeName = lp.placement?.nodes?.[0] || null;
        const node = nodeName ? await db.get('SELECT id FROM nodes WHERE name=? OR id=?', nodeName, nodeName) : null;
        await db.run(`INSERT INTO volumes(id,project_id,name,type,driver,node_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project_id,name) DO UPDATE SET type=excluded.type,driver=excluded.driver,node_id=excluded.node_id,config_json=excluded.config_json,updated_at=excluded.updated_at`,
          id('vol'), project, volumeName, lp.type || 'local', lp.driver || null, node?.id || null, JSON.stringify(lp), ts, ts);
      }
      await db.run('UPDATE projects SET current_deployment_id=?,updated_at=? WHERE id=?', depId, now(), project);
      await db.run('UPDATE deployments SET state=?,updated_at=? WHERE id=?', 'rolling_out', now(), depId);
      res.json({ deployment: { id: depId, project, version, state: 'rolling_out' }, desiredState: desired });
    } catch (e) {
      await db.run('UPDATE deployments SET state=?,error_message=?,updated_at=? WHERE id=?', 'build_failed', e.message, now(), depId).catch(()=>{});
      sendError(res, e);
    } finally { await releaseLock(lock); if (req.file) await fs.rm(req.file.path, { force: true }).catch(()=>{}); }
  });

  app.get('/api/v1/deployments/:id', authOperator, async (req, res) => res.json(await db.get('SELECT * FROM deployments WHERE id=?', req.params.id)));
  app.post('/api/v1/deployments/:id/cancel', authOperator, async (req, res) => {
    const row = await db.get('SELECT * FROM deployments WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'deployment not found' });
    if (!['uploading', 'building', 'pending_dependencies', 'rolling_out'].includes(row.state)) return res.status(409).json({ error: `deployment is ${row.state}` });
    await db.run('UPDATE deployments SET state=?,updated_at=? WHERE id=?', 'cancelled', now(), req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/v1/rollback', authOperator, async (req, res) => {
    const project = req.body.project || 'site';
    let lock;
    try {
      lock = await acquireProjectLock(project, 'rollback');
      const active = await db.get('SELECT id,state FROM deployments WHERE project_id=? AND state IN (\'uploading\',\'building\',\'pending_dependencies\',\'rolling_out\') ORDER BY created_at DESC LIMIT 1', project);
      if (active && !req.body.force) return res.status(409).json({ error: `deployment ${active.id} is already ${active.state}; retry with force to rollback anyway` });
      const current = await db.get('SELECT current_deployment_id FROM projects WHERE id=?', project);
      const previousDs = await db.get(`SELECT ds.*, d.version AS deployment_version FROM desired_states ds JOIN deployments d ON d.id=ds.deployment_id
        WHERE ds.project_id=? AND ds.deployment_id != ? AND d.state IN ('succeeded','rolling_out') ORDER BY ds.created_at DESC LIMIT 1`, project, current?.current_deployment_id || '');
      if (!previousDs) return res.status(404).json({ error: 'no previous deployment found' });
      const ts = now(); const depId = id('dep');
      const previousState = JSON.parse(previousDs.state_json);
      await db.run('INSERT INTO deployments(id,project_id,version,state,created_at,updated_at) VALUES(?,?,?,?,?,?)', depId, project, `rollback-${previousState.version}-${Date.now()}`, 'rolling_out', ts, ts);
      await db.run('INSERT INTO desired_states(id,project_id,deployment_id,version,state_json,created_at) VALUES(?,?,?,?,?,?)', id('ds'), project, depId, previousState.version, JSON.stringify(previousState), ts);
      await db.run('UPDATE projects SET current_deployment_id=?,updated_at=? WHERE id=?', depId, now(), project);
      res.json({ deployment: await db.get('SELECT * FROM deployments WHERE id=?', depId), desiredState: previousState });
    } catch (e) { sendError(res, e); }
    finally { await releaseLock(lock); }
  });
  app.post('/api/v1/backups/run', authOperator, async (req, res) => {
    const project = req.body.project || 'site'; const target = req.body.target;
    if (!target) return res.status(400).json({ error: 'target required' });
    const ds = await currentDesired(project); if (!ds) return res.status(404).json({ error: 'project has no desired state' });
    const state = JSON.parse(ds.state_json);
    const ts = now(); const backupId = id('bak'); const cmdId = id('cmd');
    const volume = state.compose?.volumes?.[target];
    if (volume) {
      const nodeName = volume['x-launchpad']?.placement?.nodes?.[0];
      if (!nodeName) return res.status(400).json({ error: 'volume backup requires x-launchpad.placement.nodes[0]' });
      const node = await db.get('SELECT id FROM nodes WHERE name=? OR id=?', nodeName, nodeName); if (!node) return res.status(404).json({ error: 'node not found' });
      await db.run('INSERT INTO backups(id,project_id,target,node_id,state,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', backupId, project, target, node.id, 'queued', JSON.stringify({ type: 'volume' }), ts);
      await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, node.id, project, 'backup.volume', 'pending', JSON.stringify({ project, volume: target, backupId }), 0, ts, null, ts, ts);
      return res.json({ backupId, commandId: cmdId, nodeId: node.id, state: 'queued', type: 'volume' });
    }
    const service = state.compose?.services?.[target];
    const backupType = service?.['x-launchpad']?.backup?.type;
    if (service && (backupType === 'mariadb' || String(service.image || '').startsWith('mariadb:'))) {
      const nodeName = service['x-launchpad']?.placement?.nodes?.[0];
      if (!nodeName) return res.status(400).json({ error: 'service backup requires x-launchpad.placement.nodes[0]' });
      const node = await db.get('SELECT id FROM nodes WHERE name=? OR id=?', nodeName, nodeName); if (!node) return res.status(404).json({ error: 'node not found' });
      await db.run('INSERT INTO backups(id,project_id,target,node_id,state,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', backupId, project, target, node.id, 'queued', JSON.stringify({ type: 'mariadb' }), ts);
      await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, node.id, project, 'backup.mariadb', 'pending', JSON.stringify({ project, service: target, backupId }), 0, ts, null, ts, ts);
      return res.json({ backupId, commandId: cmdId, nodeId: node.id, state: 'queued', type: 'mariadb' });
    }
    return res.status(404).json({ error: 'backup target must be a named volume or mariadb service' });
  });
  app.get('/api/v1/volumes', authOperator, async (req, res) => res.json({ volumes: await db.all('SELECT * FROM volumes WHERE project_id=? ORDER BY name', req.query.project || 'site') }));
  app.delete('/api/v1/volumes/:name', authOperator, async (req, res) => {
    const project = req.query.project || 'site'; const deleteData = String(req.query.deleteData || 'false') === 'true';
    let lock;
    try {
      lock = deleteData ? await acquireProjectLock(project, 'volume.delete') : null;
    const volume = await db.get('SELECT * FROM volumes WHERE project_id=? AND name=?', project, req.params.name);
    if (!volume) return res.status(404).json({ error: 'volume not found' });
    const config = JSON.parse(volume.config_json || '{}');
    if ((config.persistent || volume.type !== 'ephemeral') && !deleteData) return res.status(409).json({ error: 'refusing to delete persistent volume without deleteData=true' });
    const ds = await currentDesired(project);
    if (ds) {
      const state = JSON.parse(ds.state_json);
      const inUse = Object.entries(state.compose?.services || {}).filter(([, svc]) => (svc.volumes || []).some(v => (typeof v === 'string' ? v.split(':')[0] : v.source) === req.params.name)).map(([name]) => name);
      if (inUse.length) return res.status(409).json({ error: `volume is still referenced by services: ${inUse.join(', ')}` });
    }
    let commandId = null;
    if (deleteData && volume.node_id) {
      commandId = id('cmd'); const ts = now();
      await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', commandId, volume.node_id, project, 'volume.delete', 'pending', JSON.stringify({ project, volume: req.params.name }), 0, ts, null, ts, ts);
    }
    await db.run('DELETE FROM volumes WHERE project_id=? AND name=?', project, req.params.name);
    res.json({ ok: true, commandId, deletedMetadata: true, deleteData });
    } catch (e) { sendError(res, e); }
    finally { await releaseLock(lock); }
  });
  app.get('/api/v1/backups', authOperator, async (req, res) => res.json({ backups: await db.all('SELECT * FROM backups WHERE project_id=? ORDER BY created_at DESC', req.query.project || 'site') }));
  app.post('/api/v1/control/backups/run', authOperator, async (req, res) => {
    const backupDir = process.env.LAUNCHPAD_CONTROL_BACKUP_DIR || path.join(DATA_DIR, 'control-backups');
    await ensureDir(backupDir);
    const ts = now(); const backupId = id('cbak');
    const staging = path.join(backupDir, `${backupId}-staging`);
    await fs.rm(staging, { recursive: true, force: true });
    await ensureDir(staging);
    await db.exec('PRAGMA wal_checkpoint(FULL);');
    await fs.copyFile(dbFile, path.join(staging, 'launchpad.db'));
    await fs.copyFile(masterKeyFile, path.join(staging, 'master.key'));
    await fs.writeFile(path.join(staging, 'metadata.json'), JSON.stringify({ backupId, createdAt: ts, type: 'control' }, null, 2));
    const artifactRef = path.resolve(backupDir, `${backupId}.tar.gz`);
    await tar.c({ gzip: true, file: artifactRef, cwd: staging }, ['launchpad.db', 'master.key', 'metadata.json']);
    await fs.rm(staging, { recursive: true, force: true });
    await db.run('INSERT INTO backups(id,project_id,target,node_id,state,artifact_ref,metadata_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)', backupId, '_control', 'control-plane', null, 'completed', artifactRef, JSON.stringify({ type: 'control' }), ts, now());
    res.json({ backupId, artifactRef, state: 'completed' });
  });
  app.post('/api/v1/control/restore', authOperator, async (req, res) => {
    if (!req.body.confirm) return res.status(400).json({ error: 'confirm=true is required; restore overwrites control database and master key, then requires process restart' });
    const artifactRef = req.body.artifactRef;
    if (!artifactRef) return res.status(400).json({ error: 'artifactRef required' });
    const restoreDir = process.env.LAUNCHPAD_CONTROL_RESTORE_DIR || path.join(DATA_DIR, 'control-restore');
    await fs.rm(restoreDir, { recursive: true, force: true });
    await ensureDir(restoreDir);
    await tar.x({ file: artifactRef, cwd: restoreDir });
    await fs.copyFile(path.join(restoreDir, 'launchpad.db'), dbFile);
    await fs.copyFile(path.join(restoreDir, 'master.key'), masterKeyFile);
    res.json({ ok: true, restored: true, restartRequired: true });
  });
  app.post('/api/v1/restore', authOperator, async (req, res) => {
    const project = req.body.project || 'site'; const target = req.body.target; const from = req.body.from || 'latest';
    if (!target) return res.status(400).json({ error: 'target required' });
    let lock;
    try {
      lock = await acquireProjectLock(project, 'restore');
    const backup = from === 'latest'
      ? await db.get('SELECT * FROM backups WHERE project_id=? AND target=? AND state=? ORDER BY completed_at DESC LIMIT 1', project, target, 'completed')
      : await db.get('SELECT * FROM backups WHERE id=? AND project_id=? AND target=? AND state=?', from, project, target, 'completed');
    if (!backup?.artifact_ref) return res.status(404).json({ error: 'completed backup artifact not found' });
    const ts = now(); const cmdId = id('cmd');
    const metadata = JSON.parse(backup.metadata_json || '{}');
    const commandType = metadata.type === 'mariadb' ? 'restore.mariadb' : 'restore.volume';
    const payload = metadata.type === 'mariadb'
      ? { project, service: target, backupId: backup.id, artifactRef: backup.artifact_ref }
      : { project, volume: target, backupId: backup.id, artifactRef: backup.artifact_ref };
    await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, backup.node_id, project, commandType, 'pending', JSON.stringify(payload), 0, ts, null, ts, ts);
    res.json({ commandId: cmdId, nodeId: backup.node_id, backupId: backup.id, state: 'queued', type: metadata.type || 'volume' });
    } catch (e) { sendError(res, e); }
    finally { await releaseLock(lock); }
  });
  async function commandForService({ project, service, type, payload }) {
    if (!service) throw Object.assign(new Error('service required'), { status: 400 });
    const ds = await currentDesired(project); if (!ds) throw Object.assign(new Error('project has no desired state'), { status: 404 });
    const state = JSON.parse(ds.state_json); const svc = state.services?.[service]; if (!svc) throw Object.assign(new Error('service not found'), { status: 404 });
    const nodeName = svc.placement?.nodes?.[0]; if (!nodeName) throw Object.assign(new Error('service has no explicit node placement'), { status: 400 });
    const node = await db.get('SELECT id FROM nodes WHERE name=? OR id=?', nodeName, nodeName); if (!node) throw Object.assign(new Error('node not found'), { status: 404 });
    const cmdId = id('cmd'); const ts = now();
    await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, node.id, project, type, 'pending', JSON.stringify({ project, service, ...payload }), 0, ts, null, ts, ts);
    return { commandId: cmdId, nodeId: node.id };
  }
  app.post('/api/v1/restart', authOperator, async (req, res) => {
    try { res.json(await commandForService({ project: req.body.project || 'site', service: req.body.service, type: 'service.restart', payload: {} })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/api/v1/logs', authOperator, async (req, res) => {
    const project = req.body.project || 'site'; const service = req.body.service; const tail = Number(req.body.tail || 200);
    if (!service) return res.status(400).json({ error: 'service required' });
    const ds = await currentDesired(project); if (!ds) return res.status(404).json({ error: 'project has no desired state' });
    const state = JSON.parse(ds.state_json); const svc = state.services?.[service]; if (!svc) return res.status(404).json({ error: 'service not found' });
    const nodeName = svc.placement?.nodes?.[0]; if (!nodeName) return res.status(400).json({ error: 'service has no explicit node placement' });
    const node = await db.get('SELECT id FROM nodes WHERE name=? OR id=?', nodeName, nodeName); if (!node) return res.status(404).json({ error: 'node not found' });
    const cmdId = id('cmd'); const ts = now();
    await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, node.id, project, 'logs.fetch', 'pending', JSON.stringify({ project, service, tail }), 0, ts, null, ts, ts);
    res.json({ commandId: cmdId, nodeId: node.id });
  });
  app.get('/api/v1/commands/:id', authOperator, async (req, res) => res.json(await db.get('SELECT * FROM commands WHERE id=?', req.params.id)));
  app.get('/api/v1/status', authOperator, async (req, res) => {
    const staleSeconds = Number(process.env.LAUNCHPAD_STALE_SECONDS || 60);
    const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
    await db.run("UPDATE nodes SET status='stale',updated_at=? WHERE last_seen_at IS NOT NULL AND last_seen_at < ?", now(), cutoff);
    res.json({ projects: await db.all('SELECT * FROM projects'), deployments: await db.all('SELECT * FROM deployments ORDER BY created_at DESC LIMIT 20'), nodes: await db.all('SELECT id,name,status,last_seen_at FROM nodes'), statuses: await db.all('SELECT * FROM node_statuses') });
  });
  app.get('/api/v1/events', authOperator, async (req, res) => {
    const project = req.query.project || null;
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const events = project
      ? await db.all('SELECT * FROM events WHERE project_id=? ORDER BY created_at DESC LIMIT ?', project, limit)
      : await db.all('SELECT * FROM events ORDER BY created_at DESC LIMIT ?', limit);
    res.json({ events });
  });
  app.get('/api/v1/diagnostics', authOperator, async (req, res) => {
    const checks = [];
    async function check(name, fn) {
      try { checks.push({ name, ok: true, ...(await fn()) }); }
      catch (e) { checks.push({ name, ok: false, error: e.message }); }
    }
    await check('sqlite', async () => ({ value: (await db.get('SELECT COUNT(*) AS count FROM projects')).count }));
    await check('operator_token', async () => ({ configured: Boolean(await db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash')) }));
    await check('master_key', async () => ({ configured: Boolean(masterKey) }));
    await check('docker', async () => ({ output: (await runCommand('docker', ['version', '--format', '{{.Server.Version}}'])).out.trim() }));
    await check('docker_compose', async () => ({ output: (await runCommand('docker', ['compose', 'version'])).out.trim() }));
    res.json({ ok: checks.every(c => c.ok), registry: REGISTRY, checks });
  });
  app.post('/api/v1/diagnostics/nodes', authOperator, async (req, res) => {
    const nodes = req.body.node ? await db.all('SELECT id FROM nodes WHERE id=? OR name=?', req.body.node, req.body.node) : await db.all('SELECT id FROM nodes');
    const ts = now(); const commands = [];
    for (const node of nodes) {
      const cmdId = id('cmd');
      await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, node.id, null, 'diagnostics.run', 'pending', '{}', 0, ts, null, ts, ts);
      commands.push({ commandId: cmdId, nodeId: node.id });
    }
    res.json({ commands });
  });

  app.get('/agent/v1/work', authAgent, async (req, res) => {
    await db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', now(), 'online', req.node.id);
    const states = await db.all(`SELECT ds.* FROM desired_states ds JOIN projects p ON p.current_deployment_id=ds.deployment_id ORDER BY ds.created_at DESC`);
    const desiredStates = states.map(s => JSON.parse(s.state_json)).filter(st => Object.values(st.services).some(svc => (svc.placement?.nodes || []).includes(req.node.name) || !(svc.placement?.nodes?.length)));
    const commands = await db.all('SELECT * FROM commands WHERE node_id=? AND state=?', req.node.id, 'pending');
    if (commands.length) await db.run(`UPDATE commands SET state='running',attempts=attempts+1,updated_at=? WHERE node_id=? AND state='pending'`, now(), req.node.id);
    res.json({ serverTime: now(), nodeId: req.node.id, desiredStates, commands });
  });
  app.post('/agent/v1/status', authAgent, async (req, res) => {
    const ts = now();
    for (const st of req.body.projects || []) {
      await db.run(`INSERT INTO node_statuses(id,node_id,project_id,observed_version,status_json,health,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,project_id) DO UPDATE SET observed_version=excluded.observed_version,status_json=excluded.status_json,health=excluded.health,updated_at=excluded.updated_at`, id('ns'), req.node.id, st.project, st.observedVersion, JSON.stringify(st), st.health || 'unknown', ts);
      await updateDeploymentConvergence(st.project);
    }
    for (const cr of req.body.commandResults || []) {
      const result = cr.result || {};
      await db.run('UPDATE commands SET state=?,result_json=?,updated_at=? WHERE id=? AND node_id=?', cr.state || 'succeeded', JSON.stringify(result), ts, cr.commandId, req.node.id);
      if (result.backupId) {
        const backupState = cr.state === 'succeeded' ? 'completed' : 'failed';
        await db.run('UPDATE backups SET state=?,artifact_ref=?,metadata_json=?,completed_at=? WHERE id=? AND node_id=?', backupState, result.artifactRef || null, JSON.stringify(result), ts, result.backupId, req.node.id);
      }
    }
    await db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', ts, 'online', req.node.id);
    res.json({ ok: true });
  });
  app.post('/agent/v1/events', authAgent, async (req, res) => { const evs = req.body.events || [req.body]; for (const ev of evs) await db.run('INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id('evt'), ev.projectId || null, ev.deploymentId || null, req.node.id, ev.level || 'info', ev.type || 'event', ev.message || '', JSON.stringify(ev.metadata || {}), now()); res.json({ ok: true }); });
  function serviceSecretNames(compose, serviceNames) {
    const allowed = new Set();
    for (const serviceName of serviceNames) {
      const env = compose?.services?.[serviceName]?.environment || {};
      if (Array.isArray(env)) {
        for (const entry of env) {
          const [key, value = ''] = String(entry).split('=');
          if (key) allowed.add(key);
          for (const match of String(value).matchAll(/\$\{?([A-Z_][A-Z0-9_]*)[^}]*\}?/g)) allowed.add(match[1]);
        }
      } else {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === 'string' && value.match(/^\$\{?[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}?$/)) {
            const m = value.match(/^\$\{?([A-Z_][A-Z0-9_]*)/); if (m) allowed.add(m[1]);
          } else allowed.add(key);
        }
      }
    }
    return allowed;
  }
  app.get('/agent/v1/secrets', authAgent, async (req, res) => {
    const project = req.query.project || 'site';
    let rows = await db.all('SELECT name,encrypted_value,version FROM secrets WHERE project_id=?', project);
    if (req.query.services) {
      const ds = await currentDesired(project);
      const names = String(req.query.services).split(',').map(s => s.trim()).filter(Boolean);
      const allowed = ds ? serviceSecretNames(JSON.parse(ds.state_json).compose, names) : new Set();
      rows = rows.filter(r => allowed.has(r.name));
    }
    res.json({ secrets: Object.fromEntries(rows.map(r => [r.name, decrypt(r.encrypted_value, masterKey)])), versions: Object.fromEntries(rows.map(r => [r.name, r.version])) });
  });

  return app;
}

export async function listen(app, port = PORT) {
  const certFile = process.env.LAUNCHPAD_TLS_CERT_FILE;
  const keyFile = process.env.LAUNCHPAD_TLS_KEY_FILE;
  if (certFile && keyFile) {
    const [cert, key] = await Promise.all([fs.readFile(certFile), fs.readFile(keyFile)]);
    const server = https.createServer({ cert, key }, app);
    return new Promise(resolve => server.listen(port, () => { console.log(`launchpad-control listening on ${port} (tls)`); resolve(server); }));
  }
  console.warn('LAUNCHPAD_TLS_CERT_FILE/LAUNCHPAD_TLS_KEY_FILE not set; serving plain HTTP');
  return new Promise(resolve => { const server = app.listen(port, () => { console.log(`launchpad-control listening on ${port}`); resolve(server); }); });
}

if (import.meta.url === `file://${process.argv[1]}`) createApp().then(app => listen(app));
