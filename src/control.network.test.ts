import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { generateWgKeyPair } from './mesh.ts';
import { json } from '../test/helpers.ts';

const NETWORK_ENV = ['LAUNCHPAD_MESH', 'LAUNCHPAD_MESH_CIDR', 'LAUNCHPAD_SERVICE_DNS', 'LAUNCHPAD_WG_PORT', 'LAUNCHPAD_ACME_EMAIL'];

async function server(env: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-net-'));
  for (const key of NETWORK_ENV) delete process.env[key];
  Object.assign(process.env, { LAUNCHPAD_DATA_DIR: dir, LAUNCHPAD_OPERATOR_TOKEN: 'op-net-token', LAUNCHPAD_REGISTRY: 'registry.test', LAUNCHPAD_PUSH: 'false' }, env);
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const op = { Authorization: 'Bearer op-net-token', 'content-type': 'application/json' };
  const post = (route: string, body: unknown, headers: Record<string, string> = op) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const agent = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const work = async (token: string) => json(await fetch(`${base}/agent/v1/work`, { headers: agent(token) }));
  const register = async (name: string, body: Record<string, unknown> = {}) => json(await post('/api/v1/nodes/register', { name, ...body }));
  const report = (token: string, node: string, project: string, services: string[]) => post('/agent/v1/status', {
    node, commandResults: [],
    projects: [{ project, observedVersion: 'v1', health: 'serving', services, serviceStates: Object.fromEntries(services.map(s => [s, { rolloutState: 'serving' }])) }]
  }, agent(token));
  return { base, post, agent, work, register, report, close: () => new Promise(resolve => srv.close(resolve)) };
}

test('with every networking layer off, the work response and node info are unchanged', async () => {
  const s = await server();
  try {
    const reg = await s.register('n1', { wgPublicKey: undefined });
    assert.equal(reg.node.overlay_ip, null, 'no overlay address is allocated');
    const w = await s.work(reg.agentToken);
    assert.deepEqual(Object.keys(w).sort(), ['commands', 'desiredStates', 'nodeId', 'serverTime'], 'no network, serviceEndpoints or ingress keys');
    assert.equal((await s.post('/agent/v1/wireguard/key', { publicKey: generateWgKeyPair().publicKey }, s.agent(reg.agentToken))).status, 409, 'key endpoint refuses when the mesh is off');
    assert.equal((await s.post('/api/v1/nodes/n1/rotate-wg-key', {})).status, 409, 'rotation refuses when the mesh is off');
  } finally { await s.close(); }
});

test('mesh allocates stable overlay IPs and each node receives every other node as a peer', async () => {
  const s = await server({ LAUNCHPAD_MESH: 'true', LAUNCHPAD_WG_PORT: '51999' });
  try {
    const a = generateWgKeyPair(); const b = generateWgKeyPair(); const c = generateWgKeyPair();
    const regA = await s.register('a', { publicAddress: '203.0.113.1', wgPublicKey: a.publicKey });
    const regB = await s.register('b', { publicAddress: '203.0.113.2:4444' });
    const regC = await s.register('c');
    assert.deepEqual([regA.node.overlay_ip, regB.node.overlay_ip, regC.node.overlay_ip], ['10.210.0.1', '10.210.0.2', '10.210.0.3'], 'sequential allocation from the default CIDR');
    assert.equal((await s.post('/agent/v1/wireguard/key', { publicKey: b.publicKey }, s.agent(regB.agentToken))).status, 200, 'agent reports its public key');
    assert.equal((await s.post('/agent/v1/wireguard/key', { publicKey: c.publicKey }, s.agent(regC.agentToken))).status, 200);
    assert.equal((await s.post('/agent/v1/wireguard/key', { publicKey: 'junk' }, s.agent(regC.agentToken))).status, 400, 'malformed keys are rejected');
    assert.equal((await s.post('/agent/v1/wireguard/key', { publicKey: a.publicKey }, s.agent(regC.agentToken))).status, 409, 'a key cannot belong to two nodes');

    const wA = await s.work(regA.agentToken);
    assert.deepEqual(wA.network, {
      interface: 'wg0', overlayIp: '10.210.0.1', cidr: '10.210.0.0/16', listenPort: 51999,
      peers: [
        { node: 'b', publicKey: b.publicKey, endpoint: '203.0.113.2:4444', allowedIps: ['10.210.0.2/32'], persistentKeepalive: 25 },
        { node: 'c', publicKey: c.publicKey, allowedIps: ['10.210.0.3/32'], persistentKeepalive: 25 }
      ]
    }, 'peer list excludes the node itself, uses the configured port for bare addresses and omits endpoints for NAT-ed nodes');

    // re-registering keeps the overlay address and key
    const again = await s.register('a', { publicAddress: '203.0.113.50' });
    assert.equal(again.node.overlay_ip, '10.210.0.1', 're-registration keeps the overlay IP');
    const wB = await s.work(regB.agentToken);
    assert.equal(wB.network.peers.find((p: { node: string }) => p.node === 'a').endpoint, '203.0.113.50:51999', 'a changed public address updates the peer endpoint');
    assert.equal(wB.network.peers.find((p: { node: string }) => p.node === 'a').publicKey, a.publicKey, 'the stored public key survives re-registration');
  } finally { await s.close(); }
});

test('enroll accepts the agent public key and rejects malformed ones', async () => {
  const s = await server({ LAUNCHPAD_MESH: 'true' });
  try {
    const minted = await json(await s.post('/api/v1/nodes/enroll-token', { uses: 2 }));
    const bad = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enrollToken: minted.enrollToken, name: 'x', wgPublicKey: 'nope' }) });
    assert.equal(bad.status, 400, 'bad key is a 400');
    const pair = generateWgKeyPair();
    const ok = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enrollToken: minted.enrollToken, name: 'x', wgPublicKey: pair.publicKey }) });
    const enrolled = await json(ok);
    assert.equal(enrolled.node.overlay_ip, '10.210.0.1');
    const other = await s.register('y', { wgPublicKey: generateWgKeyPair().publicKey });
    const w = await s.work(other.agentToken);
    assert.deepEqual(w.network.peers.map((p: { publicKey: string }) => p.publicKey), [pair.publicKey], 'enrolled node shows up as a peer with the key it sent');
  } finally { await s.close(); }
});

test('rotate-wg-key queues a command for the node and a new key replaces the old one in peers', async () => {
  const s = await server({ LAUNCHPAD_MESH: 'true' });
  try {
    const k1 = generateWgKeyPair(); const k2 = generateWgKeyPair();
    const a = await s.register('a', { wgPublicKey: k1.publicKey });
    const b = await s.register('b', { wgPublicKey: generateWgKeyPair().publicKey });
    const queued = await json(await s.post('/api/v1/nodes/a/rotate-wg-key', {}));
    assert.equal(queued.nodeId, 'a');
    const w = await s.work(a.agentToken);
    assert.deepEqual(w.commands.map((c: { type: string }) => c.type), ['wg.rotate-key'], 'agent receives the rotation command');
    assert.equal((await s.post('/api/v1/nodes/ghost/rotate-wg-key', {})).status, 404);
    await s.post('/agent/v1/wireguard/key', { publicKey: k2.publicKey }, s.agent(a.agentToken));
    const peers = (await s.work(b.agentToken)).network.peers;
    assert.deepEqual(peers.map((p: { publicKey: string }) => p.publicKey), [k2.publicKey], 'other nodes see only the rotated key');
  } finally { await s.close(); }
});

const stack = {
  services: {
    web: { image: 'nginx', ports: ['8080:80'], 'x-launchpad': { placement: { nodes: ['app'] }, ingress: { host: 'app.example.com', port: 80 } } },
    db: { image: 'mariadb', ports: ['3306:3306'], 'x-launchpad': { placement: { nodes: ['dbn'] } } }
  }
};

test('service endpoints are published per project only once the node reports the service serving', async () => {
  const s = await server({ LAUNCHPAD_MESH: 'true' });
  try {
    const app = await s.register('app', { wgPublicKey: generateWgKeyPair().publicKey });
    const dbn = await s.register('dbn', { wgPublicKey: generateWgKeyPair().publicKey });
    const dep = await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: stack });
    assert.equal(dep.status, 200, 'ingress annotation passes deploy validation');
    assert.deepEqual((await s.work(app.agentToken)).serviceEndpoints, { blog: {} }, 'nothing is serving yet, so no records');

    await s.report(dbn.agentToken, 'dbn', 'blog', ['db']);
    assert.deepEqual((await s.work(app.agentToken)).serviceEndpoints, { blog: { db: [{ node: 'dbn', address: dbn.node.overlay_ip }] } }, 'db resolves to its node overlay IP once serving');

    await s.post('/agent/v1/status', { node: 'dbn', commandResults: [], projects: [{ project: 'blog', observedVersion: 'v1', health: 'failed', serviceStates: { db: { rolloutState: 'health_checking' } } }] }, s.agent(dbn.agentToken));
    assert.deepEqual((await s.work(app.agentToken)).serviceEndpoints, { blog: {} }, 'record withdrawn when the node stops serving');
  } finally { await s.close(); }
});

test('only ingress nodes get an edge config, built from all projects and serving upstreams', async () => {
  const s = await server({ LAUNCHPAD_MESH: 'true', LAUNCHPAD_ACME_EMAIL: 'ops@example.com' });
  try {
    const edge = await s.register('edge', { wgPublicKey: generateWgKeyPair().publicKey });
    const app = await s.register('app', { wgPublicKey: generateWgKeyPair().publicKey });
    await s.register('dbn', { wgPublicKey: generateWgKeyPair().publicKey });
    await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: stack });
    assert.equal((await s.work(edge.agentToken)).ingress, undefined, 'a node is not an edge until marked');

    assert.equal((await s.post('/api/v1/nodes/edge/ingress', { enabled: true })).status, 200);
    let w = await s.work(edge.agentToken);
    assert.equal(w.ingress.routes.length, 0, 'no route until an upstream serves');
    assert.match(w.ingress.warnings[0], /no serving upstream/);

    await s.report(app.agentToken, 'app', 'blog', ['web']);
    w = await s.work(edge.agentToken);
    assert.match(w.ingress.caddyfile, new RegExp(`email ops@example\\.com[\\s\\S]*app\\.example\\.com \\{\\n\\treverse_proxy ${app.node.overlay_ip}:8080`), 'upstream is the app node overlay IP on the published port');

    const nodes = (await json(await fetch(`${s.base}/api/v1/nodes`, { headers: s.agent('op-net-token') }))).nodes;
    assert.equal(nodes.find((n: { name: string }) => n.name === 'edge').ingress, 1, 'node list shows the ingress role');

    await s.post('/api/v1/nodes/edge/ingress', { enabled: false });
    assert.equal((await s.work(edge.agentToken)).ingress, undefined, 'role can be removed');
  } finally { await s.close(); }
});

test('ingress works without the mesh using node addresses, and ingress status is stored and diagnosed', async () => {
  const s = await server();
  try {
    const edge = await s.register('edge');
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
    await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: { services: { web: stack.services.web } } });
    await s.report(app.agentToken, 'app', 'blog', ['web']);
    const w = await s.work(edge.agentToken);
    assert.deepEqual(w.ingress.routes[0].upstreams, ['192.168.1.5:8080'], 'plain node address is the upstream when no mesh exists');
    assert.equal(w.serviceEndpoints, undefined, 'service DNS stays off without the mesh');

    const diag = async () => (await json(await fetch(`${s.base}/api/v1/diagnostics`, { headers: s.agent('op-net-token') }))).checks.find((c: { name: string }) => c.name === 'ingress');
    assert.equal((await diag()).ok, false, 'doctor flags an ingress node that has not reported');
    await s.post('/agent/v1/status', { node: 'edge', projects: [], commandResults: [], ingress: { state: 'serving', configHash: 'h', routes: 1 } }, s.agent(edge.agentToken));
    assert.equal((await diag()).ok, true, 'doctor passes once the edge reports serving');
  } finally { await s.close(); }
});

test('deploy rejects invalid ingress annotations and custom TLS without its secrets', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    const bad = await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: { services: { web: { image: 'nginx', 'x-launchpad': { ingress: { host: 'nope', port: 80 } } } } } });
    assert.equal(bad.status, 400);
    assert.match((await json(bad)).error, /ingress\.host must be a fully qualified hostname/);
    const custom = { services: { web: { image: 'nginx', ports: ['8080:80'], 'x-launchpad': { ingress: { host: 'a.example.com', port: 80, tls: 'custom', cert: 'C', key: 'K' } } } } };
    const missing = await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: custom });
    assert.equal(missing.status, 400);
    assert.match((await json(missing)).error, /custom TLS secret C not found/);
    await s.post('/api/v1/secrets', { project: 'blog', name: 'C', value: 'CERT-PEM' });
    await s.post('/api/v1/secrets', { project: 'blog', name: 'K', value: 'KEY-PEM' });
    assert.equal((await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: custom })).status, 200, 'deploy succeeds once secrets exist');
    const edge = await s.register('edge');
    await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
    await s.report(app.agentToken, 'app', 'blog', ['web']);
    const w = await s.work(edge.agentToken);
    assert.deepEqual(w.ingress.files, { 'certs/a.example.com.crt': 'CERT-PEM\n', 'certs/a.example.com.key': 'KEY-PEM\n' }, 'the edge receives the decrypted project secrets as files');
    assert.match(w.ingress.caddyfile, /tls \/etc\/caddy\/certs\/a\.example\.com\.crt/);
    assert.equal((await s.work(app.agentToken)).ingress, undefined, 'app nodes never receive the TLS key material');
  } finally { await s.close(); }
});
