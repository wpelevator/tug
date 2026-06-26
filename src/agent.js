#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { composeForNode, dumpYaml, serviceSecretVersions } from './compose.js';
import { ensureDir, now } from './util.js';
import { openAgentDb } from './db.js';

const CONTROL_URL_FROM_ENV = Boolean(process.env.LAUNCHPAD_CONTROL_URL);
let CONTROL_URL = process.env.LAUNCHPAD_CONTROL_URL || 'http://localhost:8080';
let TOKEN = process.env.LAUNCHPAD_AGENT_TOKEN;
let NODE_NAME = process.env.LAUNCHPAD_NODE_NAME || process.env.HOSTNAME || 'node1';
const STATE_DIR = process.env.LAUNCHPAD_STATE_DIR || '/var/lib/launchpad';
const APPLY = process.env.LAUNCHPAD_APPLY !== 'false';
const INTERVAL = Number(process.env.LAUNCHPAD_POLL_INTERVAL_MS || 5000);

const dbsByStateDir = new Map();
async function agentDb(stateDir) {
  if (!dbsByStateDir.has(stateDir)) {
    await ensureDir(stateDir);
    dbsByStateDir.set(stateDir, await openAgentDb(path.join(stateDir, 'agent.db')));
  }
  return dbsByStateDir.get(stateDir);
}

function authHeaders() { if (!TOKEN) throw new Error('LAUNCHPAD_AGENT_TOKEN required'); return { Authorization: `Bearer ${TOKEN}` }; }
async function api(path, opts = {}) {
  const res = await fetch(`${CONTROL_URL}${path}`, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out='', err=''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${out}\n${err}`)));
  });
}
async function writeEnv(file, secrets) {
  const body = Object.entries(secrets).map(([k,v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`).join('\n') + '\n';
  await fs.writeFile(file, body, { mode: 0o600 });
}

async function containerIp(project, service, cwd) {
  const ids = (await run('docker', ['compose', '-p', project, 'ps', '-q', service], cwd)).out.trim().split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error(`${service}: no container found`);
  const inspected = JSON.parse((await run('docker', ['inspect', ids[0]], cwd)).out)[0];
  const networks = inspected?.NetworkSettings?.Networks || {};
  return Object.values(networks)[0]?.IPAddress || '127.0.0.1';
}

function tcpCheck(host, port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port: Number(port), timeout: timeoutMs }, () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); reject(new Error(`tcp timeout ${host}:${port}`)); });
    s.on('error', reject);
  });
}

async function waitForHealth(project, service, health, cwd) {
  if (!APPLY || !health) return;
  const retries = Number(health.retries || 10);
  const intervalMs = parseDuration(health.interval || '2s');
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      if (health.type === 'docker') {
        const id = (await run('docker', ['compose', '-p', project, 'ps', '-q', service], cwd)).out.trim().split(/\s+/)[0];
        const state = JSON.parse((await run('docker', ['inspect', id], cwd)).out)[0]?.State;
        if (!state?.Running) throw new Error(`${service}: not running`);
        if (state.Health && state.Health.Status !== 'healthy') throw new Error(`${service}: docker health ${state.Health.Status}`);
      } else if (health.type === 'tcp') {
        await tcpCheck(await containerIp(project, service, cwd), health.port, parseDuration(health.timeout || '2s'));
      } else if (health.type === 'http') {
        const ip = await containerIp(project, service, cwd);
        const res = await fetch(`http://${ip}:${health.port || 80}${health.path || '/'}`, { signal: AbortSignal.timeout(parseDuration(health.timeout || '2s')) });
        if (!res.ok) throw new Error(`${service}: http ${res.status}`);
      }
      return;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, intervalMs)); }
  }
  throw last || new Error(`${service}: health check failed`);
}

function parseDuration(value) {
  if (typeof value === 'number') return value;
  const m = String(value).match(/^(\d+)(ms|s|m)?$/);
  if (!m) return 2000;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60000 : m[2] === 'ms' ? n : n * 1000;
}

async function executeCommand(command) {
  const payload = typeof command.payload_json === 'string' ? JSON.parse(command.payload_json || '{}') : command.payload || {};
  if (command.type === 'diagnostics.run') {
    const checks = [];
    for (const [name, cmd, args] of [
      ['docker.info', 'docker', ['info']],
      ['docker.version', 'docker', ['version']],
      ['docker.compose.version', 'docker', ['compose', 'version']]
    ]) {
      try {
        const result = await run(cmd, args);
        checks.push({ name, ok: true, stdout: result.out.slice(-4000), stderr: result.err.slice(-4000) });
      } catch (e) {
        checks.push({ name, ok: false, error: e.message.slice(-4000) });
      }
    }
    return { commandId: command.id, state: checks.every(c => c.ok) ? 'succeeded' : 'failed', result: { checks, node: NODE_NAME } };
  }
  if (command.type === 'service.restart') {
    const project = payload.project;
    const service = payload.service;
    const dir = path.join(STATE_DIR, 'projects', project);
    await run('docker', ['compose', '-p', project, 'restart', service], dir);
    return { commandId: command.id, state: 'succeeded', result: { project, service, restarted: true } };
  }
  if (command.type === 'logs.fetch') {
    const project = payload.project;
    const service = payload.service;
    const tail = String(payload.tail || 200);
    const dir = path.join(STATE_DIR, 'projects', project);
    const result = await run('docker', ['compose', '-p', project, 'logs', '--no-color', '--tail', tail, service], dir);
    return { commandId: command.id, state: 'succeeded', result: { stdout: result.out, stderr: result.err } };
  }
  if (command.type === 'volume.delete') {
    const project = payload.project;
    const volume = payload.volume;
    const composeVolume = `${project}_${volume}`;
    try { await run('docker', ['volume', 'rm', composeVolume]); }
    catch (e) {
      if (!String(e.message).includes('No such volume')) throw e;
    }
    return { commandId: command.id, state: 'succeeded', result: { project, volume, deleted: true } };
  }
  return { commandId: command.id, state: 'failed', result: { error: `unsupported command ${command.type}` } };
}

export async function reconcile(desiredState) {
  const dir = path.join(STATE_DIR, 'projects', desiredState.project);
  await ensureDir(dir);
  const plannedCompose = composeForNode(desiredState, NODE_NAME, {});
  const serviceNames = Object.keys(plannedCompose.services || {});
  if (!serviceNames.length) return { project: desiredState.project, observedVersion: desiredState.version, health: 'skipped', services: [], serviceStates: {} };
  const serviceStates = Object.fromEntries(serviceNames.map(service => [service, { rolloutState: 'pending', image: desiredState.services[service]?.image }]));
  const emit = (service, rolloutState, message = rolloutState) => api('/agent/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: desiredState.project, level: 'info', type: `service.${rolloutState}`, message, metadata: { service, version: desiredState.version, node: NODE_NAME } }) }).catch(() => {});
  const sec = await api(`/agent/v1/secrets?project=${encodeURIComponent(desiredState.project)}&services=${encodeURIComponent(serviceNames.join(','))}`);
  const currentSecretVersions = serviceSecretVersions(desiredState.compose, serviceNames, sec.versions || {});
  const db = await agentDb(STATE_DIR);
  const previousRow = await db.get('SELECT version, secret_versions_json FROM applied_state WHERE project = ?', desiredState.project);
  const previous = previousRow ? { version: previousRow.version, secretVersions: JSON.parse(previousRow.secret_versions_json) } : {};
  const secretChangedServices = serviceNames.filter(service => JSON.stringify(previous.secretVersions?.[service] || {}) !== JSON.stringify(currentSecretVersions[service] || {}));
  const sameDesiredVersion = previous.version === desiredState.version;
  const nodeCompose = composeForNode(desiredState, NODE_NAME, sec.secrets || {});
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), dumpYaml(nodeCompose));
  await writeEnv(path.join(dir, '.env'), sec.secrets || {});
  if (APPLY) {
    for (const service of serviceNames) { serviceStates[service].rolloutState = 'pulling'; await emit(service, 'pulling'); }
    await run('docker', ['compose', '-p', desiredState.project, 'pull'], dir);
    for (const service of serviceNames) { serviceStates[service].rolloutState = 'starting'; await emit(service, 'starting'); }
    await run('docker', ['compose', '-p', desiredState.project, 'up', '-d', '--remove-orphans'], dir);
    if (sameDesiredVersion && secretChangedServices.length) {
      for (const service of secretChangedServices) await emit(service, 'secret_recreate', 'secret version changed; recreating service');
      await run('docker', ['compose', '-p', desiredState.project, 'up', '-d', '--no-deps', '--force-recreate', ...secretChangedServices], dir);
    }
    for (const service of serviceNames) {
      serviceStates[service].rolloutState = 'health_checking'; await emit(service, 'health_checking');
      await waitForHealth(desiredState.project, service, desiredState.services[service]?.health, dir);
      serviceStates[service].rolloutState = 'serving'; serviceStates[service].healthyAt = now(); await emit(service, 'serving');
    }
  } else {
    for (const service of serviceNames) serviceStates[service].rolloutState = 'serving';
  }
  await db.run(
    `INSERT INTO applied_state(project, version, applied_at, service_states_json, secret_versions_json)
     VALUES(?,?,?,?,?)
     ON CONFLICT(project) DO UPDATE SET version=excluded.version, applied_at=excluded.applied_at,
       service_states_json=excluded.service_states_json, secret_versions_json=excluded.secret_versions_json`,
    desiredState.project, desiredState.version, now(), JSON.stringify(serviceStates), JSON.stringify(currentSecretVersions)
  );
  return { project: desiredState.project, observedVersion: desiredState.version, health: 'serving', services: serviceNames, serviceStates };
}

export async function pollOnce() {
  const work = await api('/agent/v1/work');
  const projects = [];
  for (const desired of work.desiredStates || (work.desiredState ? [work.desiredState] : [])) {
    try { projects.push(await reconcile(desired)); }
    catch (e) { projects.push({ project: desired.project, observedVersion: desired.version, health: 'failed', error: e.message }); }
  }
  const commandResults = [];
  for (const command of work.commands || []) {
    try { commandResults.push(await executeCommand(command)); }
    catch (e) { commandResults.push({ commandId: command.id, state: 'failed', result: { error: e.message } }); }
  }
  await api('/agent/v1/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: NODE_NAME, projects, commandResults }) });
  return projects;
}

const CREDS_FILE = () => path.join(STATE_DIR, 'agent.json');
async function loadCreds() {
  try { return JSON.parse(await fs.readFile(CREDS_FILE(), 'utf8')); } catch { return null; }
}
async function saveCreds(creds) {
  await ensureDir(STATE_DIR);
  await fs.writeFile(CREDS_FILE(), JSON.stringify(creds), { mode: 0o600 });
}
async function readJoinKey() {
  if (process.env.LAUNCHPAD_JOIN_KEY) return process.env.LAUNCHPAD_JOIN_KEY.trim();
  const file = process.env.LAUNCHPAD_JOIN_KEY_FILE;
  if (file) {
    try { return (await fs.readFile(file, 'utf8')).trim(); }
    catch (e) { throw new Error(`cannot read LAUNCHPAD_JOIN_KEY_FILE ${file}: ${e.message}`, { cause: e }); }
  }
  return null;
}
function dockerLogin(registry, user, password) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['login', registry, '-u', user, '--password-stdin'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`)));
    p.stdin.write(password); p.stdin.end();
  });
}
async function enroll(joinKey) {
  let decoded;
  try { decoded = JSON.parse(Buffer.from(joinKey, 'base64url').toString('utf8')); }
  catch (e) { throw new Error('invalid LAUNCHPAD_JOIN_KEY (expected base64url-encoded JSON)', { cause: e }); }
  if (!decoded.enrollToken) throw new Error('join key is missing enrollToken');
  const controlUrl = (!CONTROL_URL_FROM_ENV && decoded.controlUrl) ? decoded.controlUrl : CONTROL_URL;
  // node's fetch reads NODE_EXTRA_CA_CERTS only at startup, so apply an embedded CA by
  // persisting it and re-execing ourselves once with the env var set.
  if (decoded.ca && !process.env.NODE_EXTRA_CA_CERTS) {
    await ensureDir(STATE_DIR);
    const caPath = path.join(STATE_DIR, 'control-ca.pem');
    await fs.writeFile(caPath, decoded.ca);
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath } });
    process.exit(r.status ?? 1);
  }
  console.log(`enrolling with ${controlUrl} as ${NODE_NAME}`);
  const res = await fetch(`${controlUrl}/agent/v1/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollToken: decoded.enrollToken, name: NODE_NAME, address: process.env.LAUNCHPAD_NODE_ADDRESS, publicAddress: process.env.LAUNCHPAD_NODE_PUBLIC_ADDRESS })
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const out = await res.json();
  const creds = { agentToken: out.agentToken, nodeName: out.node?.name || NODE_NAME, controlUrl, registry: out.registry || null, registryToken: out.registryToken || null };
  await saveCreds(creds);
  console.log(`enrolled as node ${creds.nodeName}`);
  return creds;
}
// Establish durable credentials before polling: explicit env token (SSH/push install) wins,
// then credentials persisted on the state volume, then a one-time enroll via the join key.
export async function loadOrEnroll() {
  let creds = TOKEN ? { agentToken: TOKEN, nodeName: NODE_NAME, controlUrl: CONTROL_URL } : await loadCreds();
  if (!creds) {
    const joinKey = await readJoinKey();
    if (!joinKey) throw new Error('no LAUNCHPAD_AGENT_TOKEN, no persisted credentials, and no LAUNCHPAD_JOIN_KEY to enroll with');
    creds = await enroll(joinKey);
  }
  TOKEN = creds.agentToken;
  NODE_NAME = creds.nodeName || NODE_NAME;
  if (!CONTROL_URL_FROM_ENV && creds.controlUrl) CONTROL_URL = creds.controlUrl;
  if (APPLY && creds.registry && creds.registryToken) {
    try { await dockerLogin(creds.registry, NODE_NAME, creds.registryToken); }
    catch (e) { console.error(`registry login failed (pulls from ${creds.registry} may fail): ${e.message}`); }
  }
  return creds;
}

export async function main() {
  await loadOrEnroll();
  console.log(`launchpad-agent node=${NODE_NAME} control=${CONTROL_URL} apply=${APPLY}`);
  for (;;) { try { await pollOnce(); } catch (e) { console.error(e.message); } await new Promise(r => setTimeout(r, INTERVAL)); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
