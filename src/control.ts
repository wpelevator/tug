#!/usr/bin/env node
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import * as tar from 'tar';
import { openDb } from './db.ts';
import type { CommandRow, DeploymentRow, DesiredStateRow, EnrollTokenRow, LockRow, NodeRow, ProjectRow, SecretRow, WgPeerRow } from './db.ts';
import { encrypt, decrypt, loadOrCreateMasterKey } from './secrets.ts';
import { buildDesiredState, serviceSecretNames, validateCompose } from './compose.ts';
import { buildAndPush, unpackContext, run as runCommand } from './build.ts';
import { ensureDir, errMessage, hashToken, id, now, token } from './util.ts';
import { DEFAULT_MESH_CIDR, DEFAULT_WG_PORT, WG_INTERFACE, WG_KEEPALIVE, allocateOverlayIp, isWgKey, parseCidr, wgEndpoint } from './mesh.ts';
import { buildIngressWork, resolveServiceEndpoints } from './ingress.ts';
import type { NodeView } from './ingress.ts';
import { ACTIVE_DEPLOYMENT_STATES } from './protocol.ts';
import type {
  AgentEvent, CommandResult, CommandType, ComposeFile, DesiredState, EnrollRequest, EnrollResponse, NetworkConfig, NodeInfo,
  RegisterResponse, SecretsResponse, ServiceEndpoints, StatusReport, WgKeyRequest, WorkResponse
} from './protocol.ts';

declare module 'express-serve-static-core' {
  interface Request { node?: NodeRow }
}

interface HttpError extends Error { status?: number; lock?: LockRow }
const httpError = (status: number, message: string): HttpError => Object.assign(new Error(message), { status });

const ACTIVE_STATES_SQL = ACTIVE_DEPLOYMENT_STATES.map(s => `'${s}'`).join(',');

const PORT = Number(process.env.PORT || 8080);

export async function createApp() {
  const DATA_DIR = process.env.TUG_DATA_DIR || './data';
  const upload = multer({ dest: process.env.TUG_UPLOAD_DIR || path.join(DATA_DIR, 'uploads') });
  const dbFile = path.join(DATA_DIR, 'tug.db');
  const masterKeyFile = path.join(DATA_DIR, 'master.key');
  const REGISTRY = process.env.TUG_REGISTRY || 'localhost:5000';
  const REGISTRY_AUTH_PATH = process.env.TUG_REGISTRY_AUTH_PATH || null;
  const REGISTRY_CONTAINER = process.env.TUG_REGISTRY_CONTAINER || null;
  // Networking layers are opt-in; with all of them off the work response is unchanged.
  const MESH = process.env.TUG_MESH === 'true';
  const MESH_CIDR = process.env.TUG_MESH_CIDR || DEFAULT_MESH_CIDR;
  const WG_PORT = Number(process.env.TUG_WG_PORT || DEFAULT_WG_PORT);
  const SERVICE_DNS = (process.env.TUG_SERVICE_DNS ?? String(MESH)) === 'true';
  const ACME_EMAIL = process.env.TUG_ACME_EMAIL || undefined;
  if (MESH) parseCidr(MESH_CIDR);

  let htpasswdQueue = Promise.resolve();
  function withHtpasswdLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = htpasswdQueue.catch(() => {}).then(fn);
    htpasswdQueue = next.then(() => {}, () => {});
    return next;
  }
  async function reloadRegistry() {
    if (!REGISTRY_CONTAINER) return;
    await runCommand('docker', ['restart', REGISTRY_CONTAINER]).catch(e => console.error(`registry reload failed: ${e.message}`));
  }
  async function upsertRegistryCredential(name: string, password: string): Promise<void> {
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
  async function removeRegistryCredential(name: string): Promise<void> {
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
  const operator = await db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash');
  if (!operator) {
    const t = process.env.TUG_OPERATOR_TOKEN || token('tug_op');
    await db.run('INSERT INTO meta(key,value) VALUES(?,?)', 'operator_token_hash', hashToken(t));
    await fs.writeFile(path.join(DATA_DIR, 'operator.token'), `${t}\n`, { mode: 0o600 }).catch(()=>{});
    console.log(`operator token: ${t}`);
  }

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const authOperator = async (req: Request, res: Response, next: NextFunction) => {
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const row = await db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash');
    if (!raw || hashToken(raw) !== row?.value) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  const authAgent = async (req: Request, res: Response, next: NextFunction) => {
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const node = raw && await db.get<NodeRow>('SELECT * FROM nodes WHERE agent_token_hash=?', hashToken(raw));
    if (!node) return res.status(401).json({ error: 'unauthorized' });
    req.node = node; next();
  };

  async function updateDeploymentConvergence(projectId: string): Promise<void> {
    const project = await db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId);
    if (!project?.current_deployment_id) return;
    const ds = await db.get<DesiredStateRow>('SELECT * FROM desired_states WHERE deployment_id=?', project.current_deployment_id);
    if (!ds) return;
    const state: DesiredState = JSON.parse(ds.state_json);
    const required = new Set<string>();
    for (const svc of Object.values(state.services || {})) for (const node of svc.placement?.nodes || []) required.add(node);
    if (!required.size) return;
    const statuses = await db.all<{ node_id: string; observed_version: string; health: string }[]>('SELECT node_id,observed_version,health FROM node_statuses WHERE project_id=?', projectId);
    const byNode = new Map(statuses.map(s => [s.node_id, s]));
    const failed = [...required].some(node => byNode.get(node)?.observed_version === state.version && byNode.get(node)?.health === 'failed');
    if (failed) await db.run('UPDATE deployments SET state=?,error_message=?,updated_at=? WHERE id=? AND state=?', 'failed', 'one or more assigned nodes reported failed health', now(), project.current_deployment_id, 'rolling_out');
    const ok = [...required].every(node => byNode.get(node)?.observed_version === state.version && ['serving', 'skipped'].includes(byNode.get(node)?.health ?? ''));
    if (ok) await db.run('UPDATE deployments SET state=?,updated_at=? WHERE id=? AND state=?', 'succeeded', now(), project.current_deployment_id, 'rolling_out');
  }

  async function currentDesired(projectId: string): Promise<DesiredStateRow | undefined> {
    return db.get<DesiredStateRow>('SELECT ds.* FROM desired_states ds JOIN projects p ON p.current_deployment_id=ds.deployment_id WHERE p.id=?', projectId);
  }

  async function acquireProjectLock(project: string, operation: string, ttlMs = Number(process.env.TUG_LOCK_TTL_MS || 10 * 60 * 1000)) {
    const name = `project:${project}`;
    const ts = now();
    await db.run('DELETE FROM locks WHERE expires_at < ?', ts);
    const owner = `${operation}:${id('lock')}`;
    try {
      await db.run('INSERT INTO locks(name,owner,expires_at,created_at) VALUES(?,?,?,?)', name, owner, new Date(Date.now() + ttlMs).toISOString(), ts);
    } catch (e) {
      if (!/UNIQUE constraint/.test(errMessage(e))) throw e;
      const existing = await db.get<LockRow>('SELECT * FROM locks WHERE name=?', name);
      const err: HttpError = new Error(`project ${project} is locked by ${existing?.owner} until ${existing?.expires_at}`);
      err.status = 409; err.lock = existing; throw err;
    }
    return { name, owner };
  }
  async function releaseLock(lock: { name: string; owner: string } | null | undefined): Promise<void> {
    if (lock) await db.run('DELETE FROM locks WHERE name=? AND owner=?', lock.name, lock.owner).catch(()=>{});
  }
  function sendError(res: Response, e: unknown): void { const err = e as HttpError; res.status(err.status || 500).json({ error: err.message, lock: err.lock || undefined }); }

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.post('/api/v1/projects', authOperator, async (req, res) => {
    const name = req.body.name || 'site'; const ts = now();
    await db.run('INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', name, name, ts, ts);
    res.json(await db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', name));
  });
  app.get('/api/v1/projects/:project', authOperator, async (req, res) => res.json(await db.get('SELECT * FROM projects WHERE id=?', req.params.project)));

  const NODE_INFO_SQL = 'SELECT id,name,address,public_address,overlay_ip,status,created_at,updated_at FROM nodes WHERE id=?';

  /** Allocates the node's stable overlay IP on first registration (retrying if a concurrent register took it). */
  async function ensureOverlayIp(nodeId: string): Promise<void> {
    if (!MESH) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await db.get<Pick<NodeRow, 'overlay_ip'>>('SELECT overlay_ip FROM nodes WHERE id=?', nodeId);
      if (row?.overlay_ip) return;
      const used = (await db.all<{ overlay_ip: string }[]>('SELECT overlay_ip FROM nodes WHERE overlay_ip IS NOT NULL')).map(r => r.overlay_ip);
      try { await db.run('UPDATE nodes SET overlay_ip=? WHERE id=? AND overlay_ip IS NULL', allocateOverlayIp(MESH_CIDR, used), nodeId); return; }
      catch (e) { if (!/UNIQUE constraint/.test(errMessage(e))) throw e; }
    }
    throw new Error('could not allocate an overlay address');
  }
  /** Stores (or refreshes) the node's WireGuard peer entry; the private key never reaches control. */
  async function syncWgPeer(nodeId: string, publicKey?: string): Promise<void> {
    if (!MESH) return;
    const node = await db.get<NodeRow>('SELECT * FROM nodes WHERE id=?', nodeId);
    const existing = await db.get<WgPeerRow>('SELECT * FROM wg_peers WHERE node_id=?', nodeId);
    const key = publicKey ?? existing?.public_key;
    if (!node?.overlay_ip || !key) return;
    await db.run(`INSERT INTO wg_peers(node_id,public_key,overlay_ip,endpoint,allowed_ips,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET public_key=excluded.public_key,overlay_ip=excluded.overlay_ip,endpoint=excluded.endpoint,allowed_ips=excluded.allowed_ips,updated_at=excluded.updated_at`,
      nodeId, key, node.overlay_ip, wgEndpoint(node.public_address, WG_PORT) ?? null, `${node.overlay_ip}/32`, now());
  }

  async function registerNode({ name, address, publicAddress, wgPublicKey }: { name: string; address?: string; publicAddress?: string; wgPublicKey?: string }): Promise<RegisterResponse> {
    if (wgPublicKey !== undefined && !isWgKey(wgPublicKey)) throw httpError(400, 'wgPublicKey must be a base64 WireGuard public key');
    const agentToken = token('tug_agent'); const registryToken = token('tug_reg'); const ts = now();
    await db.run(`INSERT INTO nodes(id,name,address,public_address,status,agent_token_hash,registry_token_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,public_address=excluded.public_address,agent_token_hash=excluded.agent_token_hash,registry_token_hash=excluded.registry_token_hash,updated_at=excluded.updated_at`,
      name, name, address || null, publicAddress || null, 'registered', hashToken(agentToken), hashToken(registryToken), ts, ts);
    await ensureOverlayIp(name);
    await syncWgPeer(name, wgPublicKey);
    await upsertRegistryCredential(name, registryToken);
    const node = (await db.get<NodeInfo>(NODE_INFO_SQL, name))!;
    return { node, agentToken, registryToken };
  }
  app.post('/api/v1/nodes/register', authOperator, async (req, res) => {
    const name = req.body.name; if (!name) return res.status(400).json({ error: 'name required' });
    try { res.json(await registerNode({ name, address: req.body.address, publicAddress: req.body.publicAddress, wgPublicKey: req.body.wgPublicKey })); }
    catch (e) { sendError(res, e); }
  });

  // Self-service enrollment: operator mints a short-lived, limited-use key; the agent
  // exchanges it for durable credentials on first boot (Portainer Edge-style join).
  app.post('/api/v1/nodes/enroll-token', authOperator, async (req, res) => {
    const name = req.body.name || null;
    const ttlSeconds = Math.max(1, Number(req.body.ttlSeconds ?? 3600));
    const uses = Math.max(1, Number(req.body.uses ?? 1));
    const enrollToken = token('tug_enroll');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await db.run('INSERT INTO enroll_tokens(token_hash,name,uses_remaining,expires_at,created_at) VALUES(?,?,?,?,?)',
      hashToken(enrollToken), name, uses, expiresAt, now());
    res.json({ enrollToken, name, usesRemaining: uses, expiresAt, registry: REGISTRY });
  });
  app.post('/agent/v1/enroll', async (req, res) => {
    const body: EnrollRequest = req.body;
    const raw = String(body.enrollToken || (req.headers.authorization || '').replace(/^Bearer /, '')).trim();
    if (!raw) return res.status(400).json({ error: 'enrollToken required' });
    const row = await db.get<EnrollTokenRow>('SELECT * FROM enroll_tokens WHERE token_hash=?', hashToken(raw));
    if (!row || row.uses_remaining < 1 || row.expires_at < now()) {
      if (row) await db.run('DELETE FROM enroll_tokens WHERE token_hash=?', hashToken(raw));
      return res.status(401).json({ error: 'invalid or expired enroll token' });
    }
    const name = row.name || body.name;
    if (!name) return res.status(400).json({ error: 'node name required (bind one to the enroll token or send name)' });
    let result: RegisterResponse;
    try { result = await registerNode({ name, address: body.address, publicAddress: body.publicAddress, wgPublicKey: body.wgPublicKey }); }
    catch (e) { return sendError(res, e); }
    const remaining = row.uses_remaining - 1;
    if (remaining < 1) await db.run('DELETE FROM enroll_tokens WHERE token_hash=?', hashToken(raw));
    else await db.run('UPDATE enroll_tokens SET uses_remaining=? WHERE token_hash=?', remaining, hashToken(raw));
    const enrolled: EnrollResponse = { ...result, registry: REGISTRY };
    res.json(enrolled);
  });
  app.get('/api/v1/nodes', authOperator, async (req, res) => res.json({ nodes: await db.all('SELECT id,name,address,public_address,overlay_ip,ingress,ingress_status_json,status,last_seen_at,created_at,updated_at FROM nodes ORDER BY name') }));
  app.post('/api/v1/nodes/:name/rotate-registry-token', authOperator, async (req, res) => {
    const node = await db.get('SELECT id,name FROM nodes WHERE name=? OR id=?', req.params.name, req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    const registryToken = token('tug_reg');
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
  async function findNode(nameOrId: string) { return db.get<Pick<NodeRow, 'id' | 'name'>>('SELECT id,name FROM nodes WHERE name=? OR id=?', nameOrId, nameOrId); }
  function queueCommand(nodeId: string, projectId: string | null, type: CommandType, payload: Record<string, unknown> = {}): Promise<string> {
    const commandId = id('cmd'); const ts = now();
    return db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', commandId, nodeId, projectId, type, 'pending', JSON.stringify(payload), 0, ts, null, ts, ts).then(() => commandId);
  }
  // The private key lives only on the node, so rotation is a command the agent executes: it
  // generates a new keypair, reports the public key and peers pick it up from their next work response.
  app.post('/api/v1/nodes/:name/rotate-wg-key', authOperator, async (req, res) => {
    if (!MESH) return res.status(409).json({ error: 'the WireGuard mesh is not enabled (TUG_MESH=true)' });
    const node = await findNode(req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    res.json({ commandId: await queueCommand(node.id, null, 'wg.rotate-key'), nodeId: node.id });
  });
  app.post('/api/v1/nodes/:name/ingress', authOperator, async (req, res) => {
    const node = await findNode(req.params.name);
    if (!node) return res.status(404).json({ error: 'node not found' });
    const enabled = req.body.enabled !== false;
    await db.run('UPDATE nodes SET ingress=?,updated_at=? WHERE id=?', enabled ? 1 : 0, now(), node.id);
    res.json({ ok: true, node: node.name, ingress: enabled });
  });
  app.post('/agent/v1/wireguard/key', authAgent, async (req, res) => {
    if (!MESH) return res.status(409).json({ error: 'the WireGuard mesh is not enabled' });
    const { publicKey }: Partial<WgKeyRequest> = req.body;
    if (!isWgKey(publicKey)) return res.status(400).json({ error: 'publicKey must be a base64 WireGuard public key' });
    try { await syncWgPeer(req.node!.id, publicKey); res.json({ ok: true }); }
    catch (e) { sendError(res, /UNIQUE constraint/.test(errMessage(e)) ? httpError(409, 'public key already registered to another node') : e); }
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
      const old = await db.get<Pick<SecretRow, 'version'>>('SELECT version FROM secrets WHERE project_id=? AND name=?', project, name); const ts = now();
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
    const project: string = body.project || 'site'; const compose: ComposeFile = body.compose; const version = body.version || `git-${Date.now()}`;
    const nodes = await db.all<{ name: string }[]>('SELECT name FROM nodes');
    try { validateCompose(compose, nodes.map(n => n.name)); }
    catch (e) { return res.status(400).json({ error: errMessage(e) }); }
    for (const [svcName, svc] of Object.entries(compose.services)) {
      const ing = svc['x-tug']?.ingress;
      if (ing?.tls !== 'custom') continue;
      for (const secret of [ing.cert, ing.key]) {
        if (!await db.get('SELECT 1 FROM secrets WHERE project_id=? AND name=?', project, secret)) return res.status(400).json({ error: `${svcName}: custom TLS secret ${secret} not found in project ${project}; set it with secret:set first` });
      }
    }
    const active = await db.get<Pick<DeploymentRow, 'id' | 'state'>>(`SELECT id,state FROM deployments WHERE project_id=? AND state IN (${ACTIVE_STATES_SQL}) ORDER BY created_at DESC LIMIT 1`, project);
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
        for (const [svc, spec] of Object.entries(compose.services)) if (spec.build) await buildAndPush({ contextDir, service: svc, buildSpec: spec.build, imageRef: desired.services[svc].image!, push: process.env.TUG_PUSH !== 'false' });
      }
      await db.run('INSERT INTO desired_states(id,project_id,deployment_id,version,state_json,created_at) VALUES(?,?,?,?,?,?)', id('ds'), project, depId, version, JSON.stringify(desired), ts);
      for (const [volumeName, volumeSpec] of Object.entries(compose.volumes || {})) {
        const lp = volumeSpec?.['x-tug'] || {};
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
      await db.run('UPDATE deployments SET state=?,error_message=?,updated_at=? WHERE id=?', 'build_failed', errMessage(e), now(), depId).catch(()=>{});
      sendError(res, e);
    } finally { await releaseLock(lock); if (req.file) await fs.rm(req.file.path, { force: true }).catch(()=>{}); }
  });

  app.get('/api/v1/deployments/:id', authOperator, async (req, res) => res.json(await db.get('SELECT * FROM deployments WHERE id=?', req.params.id)));
  app.post('/api/v1/deployments/:id/cancel', authOperator, async (req, res) => {
    const row = await db.get<DeploymentRow>('SELECT * FROM deployments WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'deployment not found' });
    if (!(ACTIVE_DEPLOYMENT_STATES as readonly string[]).includes(row.state)) return res.status(409).json({ error: `deployment is ${row.state}` });
    await db.run('UPDATE deployments SET state=?,updated_at=? WHERE id=?', 'cancelled', now(), req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/v1/rollback', authOperator, async (req, res) => {
    const project = req.body.project || 'site';
    let lock;
    try {
      lock = await acquireProjectLock(project, 'rollback');
      const active = await db.get<Pick<DeploymentRow, 'id' | 'state'>>(`SELECT id,state FROM deployments WHERE project_id=? AND state IN (${ACTIVE_STATES_SQL}) ORDER BY created_at DESC LIMIT 1`, project);
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
  app.get('/api/v1/volumes', authOperator, async (req, res) => res.json({ volumes: await db.all('SELECT * FROM volumes WHERE project_id=? ORDER BY name', req.query.project || 'site') }));
  app.delete('/api/v1/volumes/:name', authOperator, async (req, res) => {
    const project = String(req.query.project || 'site'); const deleteData = String(req.query.deleteData || 'false') === 'true';
    let lock;
    try {
      lock = deleteData ? await acquireProjectLock(project, 'volume.delete') : null;
    const volume = await db.get('SELECT * FROM volumes WHERE project_id=? AND name=?', project, req.params.name);
    if (!volume) return res.status(404).json({ error: 'volume not found' });
    const config = JSON.parse(volume.config_json || '{}');
    if ((config.persistent || volume.type !== 'ephemeral') && !deleteData) return res.status(409).json({ error: 'refusing to delete persistent volume without deleteData=true' });
    const ds = await currentDesired(project);
    if (ds) {
      const state: DesiredState = JSON.parse(ds.state_json);
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
  app.post('/api/v1/control/backups/run', authOperator, async (req, res) => {
    const backupDir = process.env.TUG_CONTROL_BACKUP_DIR || path.join(DATA_DIR, 'control-backups');
    await ensureDir(backupDir);
    const ts = now(); const backupId = id('cbak');
    const staging = path.join(backupDir, `${backupId}-staging`);
    await fs.rm(staging, { recursive: true, force: true });
    await ensureDir(staging);
    await db.exec('PRAGMA wal_checkpoint(FULL);');
    await fs.copyFile(dbFile, path.join(staging, 'tug.db'));
    await fs.copyFile(masterKeyFile, path.join(staging, 'master.key'));
    await fs.writeFile(path.join(staging, 'metadata.json'), JSON.stringify({ backupId, createdAt: ts, type: 'control' }, null, 2));
    const artifactRef = path.resolve(backupDir, `${backupId}.tar.gz`);
    await tar.c({ gzip: true, file: artifactRef, cwd: staging }, ['tug.db', 'master.key', 'metadata.json']);
    await fs.rm(staging, { recursive: true, force: true });
    await db.run('INSERT INTO backups(id,project_id,target,node_id,state,artifact_ref,metadata_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)', backupId, '_control', 'control-plane', null, 'completed', artifactRef, JSON.stringify({ type: 'control' }), ts, now());
    res.json({ backupId, artifactRef, state: 'completed' });
  });
  app.post('/api/v1/control/restore', authOperator, async (req, res) => {
    if (!req.body.confirm) return res.status(400).json({ error: 'confirm=true is required; restore overwrites control database and master key, then requires process restart' });
    const artifactRef = req.body.artifactRef;
    if (!artifactRef) return res.status(400).json({ error: 'artifactRef required' });
    const restoreDir = process.env.TUG_CONTROL_RESTORE_DIR || path.join(DATA_DIR, 'control-restore');
    await fs.rm(restoreDir, { recursive: true, force: true });
    await ensureDir(restoreDir);
    await tar.x({ file: artifactRef, cwd: restoreDir });
    await fs.copyFile(path.join(restoreDir, 'tug.db'), dbFile);
    await fs.copyFile(path.join(restoreDir, 'master.key'), masterKeyFile);
    res.json({ ok: true, restored: true, restartRequired: true });
  });
  async function commandForService({ project, service, type, payload }: { project: string; service?: string; type: CommandType; payload: Record<string, unknown> }) {
    if (!service) throw httpError(400, 'service required');
    const ds = await currentDesired(project); if (!ds) throw httpError(404, 'project has no desired state');
    const state = JSON.parse(ds.state_json); const svc = state.services?.[service]; if (!svc) throw httpError(404, 'service not found');
    const nodeName = svc.placement?.nodes?.[0]; if (!nodeName) throw httpError(400, 'service has no explicit node placement');
    const node = await db.get('SELECT id FROM nodes WHERE name=? OR id=?', nodeName, nodeName); if (!node) throw httpError(404, 'node not found');
    const cmdId = id('cmd'); const ts = now();
    await db.run('INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,run_after,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', cmdId, node.id, project, type, 'pending', JSON.stringify({ project, service, ...payload }), 0, ts, null, ts, ts);
    return { commandId: cmdId, nodeId: node.id };
  }
  app.post('/api/v1/restart', authOperator, async (req, res) => {
    try { res.json(await commandForService({ project: req.body.project || 'site', service: req.body.service, type: 'service.restart', payload: {} })); }
    catch (e) { res.status((e as HttpError).status || 500).json({ error: errMessage(e) }); }
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
    const staleSeconds = Number(process.env.TUG_STALE_SECONDS || 60);
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
    const checks: { name: string; ok: boolean; [key: string]: unknown }[] = [];
    async function check(name: string, fn: () => Promise<Record<string, unknown>>) {
      try { checks.push({ name, ok: true, ...(await fn()) }); }
      catch (e) { checks.push({ name, ok: false, error: errMessage(e) }); }
    }
    await check('sqlite', async () => ({ value: (await db.get('SELECT COUNT(*) AS count FROM projects')).count }));
    await check('operator_token', async () => ({ configured: Boolean(await db.get('SELECT value FROM meta WHERE key=?', 'operator_token_hash')) }));
    await check('master_key', async () => ({ configured: Boolean(masterKey) }));
    await check('docker', async () => ({ output: (await runCommand('docker', ['version', '--format', '{{.Server.Version}}'])).out.trim() }));
    await check('docker_compose', async () => ({ output: (await runCommand('docker', ['compose', 'version'])).out.trim() }));
    if (MESH) {
      await check('mesh', async () => {
        const nodes = await db.all<{ name: string; overlay_ip: string | null; has_key: number }[]>('SELECT n.name, n.overlay_ip, EXISTS(SELECT 1 FROM wg_peers w WHERE w.node_id=n.id) AS has_key FROM nodes n');
        const missing = nodes.filter(n => !n.has_key).map(n => n.name);
        if (missing.length) throw new Error(`nodes without a reported WireGuard key (is TUG_MESH=true on their agents?): ${missing.join(', ')}`);
        return { cidr: MESH_CIDR, port: WG_PORT, nodes: nodes.length };
      });
    }
    const ingressNodes = await db.all<Pick<NodeRow, 'name' | 'ingress_status_json'>[]>('SELECT name,ingress_status_json FROM nodes WHERE ingress=1');
    if (ingressNodes.length) {
      await check('ingress', async () => {
        const bad = ingressNodes.filter(n => (n.ingress_status_json ? JSON.parse(n.ingress_status_json).state : 'unreported') !== 'serving').map(n => n.name);
        if (bad.length) throw new Error(`ingress nodes not serving: ${bad.join(', ')}`);
        return { nodes: ingressNodes.map(n => n.name) };
      });
    }
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

  async function currentDesiredStates(): Promise<DesiredState[]> {
    const rows = await db.all<DesiredStateRow[]>(`SELECT ds.* FROM desired_states ds JOIN projects p ON p.current_deployment_id=ds.deployment_id ORDER BY ds.created_at DESC`);
    return rows.map((s): DesiredState => JSON.parse(s.state_json));
  }
  async function endpointsFor(states: DesiredState[]): Promise<ServiceEndpoints> {
    const staleBefore = new Date(Date.now() - Number(process.env.TUG_STALE_SECONDS || 60) * 1000).toISOString();
    const nodes = await db.all<(NodeRow & { has_key: number })[]>('SELECT n.*, EXISTS(SELECT 1 FROM wg_peers w WHERE w.node_id=n.id) AS has_key FROM nodes n');
    const views: NodeView[] = nodes.map(n => ({ name: n.name, overlayIp: MESH && n.has_key ? n.overlay_ip : null, address: n.address, lastSeenAt: n.last_seen_at }));
    const statuses = (await db.all<{ node_id: string; project_id: string; status_json: string }[]>('SELECT node_id,project_id,status_json FROM node_statuses'))
      .map(r => ({ node: nodes.find(n => n.id === r.node_id)?.name ?? r.node_id, project: r.project_id, status: JSON.parse(r.status_json) }));
    return resolveServiceEndpoints(states, views, statuses, staleBefore);
  }
  async function networkFor(node: NodeRow): Promise<NetworkConfig | undefined> {
    if (!MESH || !node.overlay_ip) return undefined;
    const peers = await db.all<(WgPeerRow & { name: string })[]>('SELECT w.*, n.name FROM wg_peers w JOIN nodes n ON n.id=w.node_id WHERE w.node_id != ? ORDER BY n.name', node.id);
    return {
      interface: WG_INTERFACE, overlayIp: node.overlay_ip, cidr: MESH_CIDR, listenPort: WG_PORT,
      peers: peers.map(p => ({ node: p.name, publicKey: p.public_key, endpoint: p.endpoint ?? undefined, allowedIps: p.allowed_ips.split(','), persistentKeepalive: WG_KEEPALIVE }))
    };
  }
  async function ingressFor(node: NodeRow, states: DesiredState[]) {
    const secrets = new Map<string, string>();
    for (const state of states) {
      for (const svc of Object.values(state.compose.services || {})) {
        const ing = svc['x-tug']?.ingress;
        if (ing?.tls !== 'custom') continue;
        for (const name of [ing.cert, ing.key]) {
          const row = await db.get<Pick<SecretRow, 'encrypted_value'>>('SELECT encrypted_value FROM secrets WHERE project_id=? AND name=?', state.project, name);
          if (row) secrets.set(`${state.project}/${name}`, decrypt(row.encrypted_value, masterKey));
        }
      }
    }
    return buildIngressWork({ states, endpoints: await endpointsFor(states), node: node.name, secrets, acmeEmail: ACME_EMAIL });
  }

  app.get('/agent/v1/work', authAgent, async (req, res) => {
    await db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', now(), 'online', req.node!.id);
    const node = (await db.get<NodeRow>('SELECT * FROM nodes WHERE id=?', req.node!.id))!;
    const allStates = await currentDesiredStates();
    const desiredStates = allStates.filter(st => Object.values(st.services).some(svc => (svc.placement?.nodes || []).includes(node.name) || !(svc.placement?.nodes?.length)));
    const commands = await db.all<CommandRow[]>('SELECT * FROM commands WHERE node_id=? AND state=?', node.id, 'pending');
    if (commands.length) await db.run(`UPDATE commands SET state='running',attempts=attempts+1,updated_at=? WHERE node_id=? AND state='pending'`, now(), node.id);
    const work: WorkResponse = { serverTime: now(), nodeId: node.id, desiredStates, commands };
    const network = await networkFor(node);
    if (network) work.network = network;
    if (SERVICE_DNS) {
      const all = await endpointsFor(allStates);
      work.serviceEndpoints = Object.fromEntries(desiredStates.map(st => [st.project, all[st.project] || {}]));
    }
    if (node.ingress) work.ingress = await ingressFor(node, allStates);
    res.json(work);
  });
  app.post('/agent/v1/status', authAgent, async (req, res) => {
    const ts = now();
    const report: Partial<StatusReport> = req.body;
    for (const st of report.projects || []) {
      await db.run(`INSERT INTO node_statuses(id,node_id,project_id,observed_version,status_json,health,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,project_id) DO UPDATE SET observed_version=excluded.observed_version,status_json=excluded.status_json,health=excluded.health,updated_at=excluded.updated_at`, id('ns'), req.node!.id, st.project, st.observedVersion, JSON.stringify(st), st.health || 'unknown', ts);
      await updateDeploymentConvergence(st.project);
    }
    for (const cr of (report.commandResults || []) as Partial<CommandResult>[]) {
      const result = cr.result || {};
      await db.run('UPDATE commands SET state=?,result_json=?,updated_at=? WHERE id=? AND node_id=?', cr.state || 'succeeded', JSON.stringify(result), ts, cr.commandId, req.node!.id);
    }
    if (report.ingress) await db.run('UPDATE nodes SET ingress_status_json=? WHERE id=?', JSON.stringify({ ...report.ingress, reportedAt: ts }), req.node!.id);
    await db.run('UPDATE nodes SET last_seen_at=?,status=? WHERE id=?', ts, 'online', req.node!.id);
    res.json({ ok: true });
  });
  app.post('/agent/v1/events', authAgent, async (req, res) => { const evs: AgentEvent[] = req.body.events || [req.body]; for (const ev of evs) await db.run('INSERT INTO events(id,project_id,deployment_id,node_id,level,type,message,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id('evt'), ev.projectId || null, ev.deploymentId || null, req.node!.id, ev.level || 'info', ev.type || 'event', ev.message || '', JSON.stringify(ev.metadata || {}), now()); res.json({ ok: true }); });
  app.get('/agent/v1/secrets', authAgent, async (req, res) => {
    const project = String(req.query.project || 'site');
    let rows = await db.all<Pick<SecretRow, 'name' | 'encrypted_value' | 'version'>[]>('SELECT name,encrypted_value,version FROM secrets WHERE project_id=?', project);
    if (req.query.services) {
      const ds = await currentDesired(project);
      const names = String(req.query.services).split(',').map(s => s.trim()).filter(Boolean);
      const allowed = ds ? serviceSecretNames(JSON.parse(ds.state_json).compose, names) : new Set<string>();
      rows = rows.filter(r => allowed.has(r.name));
    }
    const secrets: SecretsResponse = { secrets: Object.fromEntries(rows.map(r => [r.name, decrypt(r.encrypted_value, masterKey)])), versions: Object.fromEntries(rows.map(r => [r.name, r.version])) };
    res.json(secrets);
  });

  return app;
}

export async function listen(app: express.Express, port = PORT): Promise<import('node:http').Server | https.Server> {
  const certFile = process.env.TUG_TLS_CERT_FILE;
  const keyFile = process.env.TUG_TLS_KEY_FILE;
  if (certFile && keyFile) {
    const [cert, key] = await Promise.all([fs.readFile(certFile), fs.readFile(keyFile)]);
    const server = https.createServer({ cert, key }, app);
    return new Promise(resolve => server.listen(port, () => { console.log(`tug-control listening on ${port} (tls)`); resolve(server); }));
  }
  console.warn('TUG_TLS_CERT_FILE/TUG_TLS_KEY_FILE not set; serving plain HTTP');
  return new Promise(resolve => { const server = app.listen(port, () => { console.log(`tug-control listening on ${port}`); resolve(server); }); });
}

if (import.meta.url === `file://${process.argv[1]}`) createApp().then(app => listen(app));
