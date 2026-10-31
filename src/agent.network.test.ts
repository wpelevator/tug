import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommand, pollOnce } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState } from './compose.ts';
import { ensureWgKeys, generateWgKeyPair, readReportedKey } from './mesh.ts';
import type { ComposeFile, WorkResponse } from './protocol.ts';
import type { DockerRunner, HostRunner, HttpClient } from './runners.ts';

/** One ordered log across docker, wg/ip and control calls so tests can assert ordering between them. */
function harness(work: () => Partial<WorkResponse>) {
  const log: string[] = [];
  const posts: { route: string; body: any }[] = [];
  const docker: DockerRunner = async args => {
    log.push(`docker ${args.join(' ')}`);
    if (args[0] === 'container' && args[1] === 'inspect') throw new Error('No such container');
    return { out: '', err: '' };
  };
  const host: HostRunner = async (cmd, args) => {
    log.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'ip' && args[0] === 'link' && args[1] === 'show') throw new Error('does not exist');
    return { out: '', err: '' };
  };
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname;
    if (init?.method === 'POST') { posts.push({ route, body: JSON.parse(String(init.body)) }); log.push(`POST ${route}`); return Response.json({ ok: true }); }
    if (route === '/agent/v1/work') return Response.json({ serverTime: 't', nodeId: 'n1', desiredStates: [], commands: [], ...work() });
    return Response.json({ secrets: {}, versions: {} });
  }) as HttpClient;
  return { log, posts, docker, host, http };
}
const makeCtx = async (h: ReturnType<typeof harness>, overrides: Partial<AgentContext> = {}): Promise<AgentContext> => ({
  docker: h.docker, host: h.host, http: h.http, nodeName: 'n1', stateDir: await fs.mkdtemp(path.join(os.tmpdir(), 'lp-agent-net-')),
  apply: true, controlUrl: 'http://control.test', token: 'tok', mesh: true, ...overrides
});

const compose: ComposeFile = { services: {
  web: { image: 'nginx', 'x-launchpad': { placement: { nodes: ['n1'] } } },
  db: { image: 'mariadb', 'x-launchpad': { placement: { nodes: ['n2'] } } }
} };
const desired = buildDesiredState({ project: 'blog', version: 'v1', compose, registry: 'reg.test' });
const peer = generateWgKeyPair().publicKey;
const network = { interface: 'wg0', overlayIp: '10.210.0.1', cidr: '10.210.0.0/16', listenPort: 51820, peers: [{ node: 'n2', publicKey: peer, endpoint: '192.0.2.2:51820', allowedIps: ['10.210.0.2/32'], persistentKeepalive: 25 }] };

test('mesh-enabled poll reports the public key once, brings up wg0 before containers and injects cross-node hosts', async () => {
  const h = harness(() => ({ desiredStates: [desired], network, serviceEndpoints: { blog: { db: [{ node: 'n2', address: '10.210.0.2' }] } } }));
  const ctx = await makeCtx(h);
  await pollOnce(ctx);

  const { publicKey } = await ensureWgKeys(ctx.stateDir);
  assert.deepEqual(h.posts.find(p => p.route === '/agent/v1/wireguard/key')?.body, { publicKey }, 'only the public key is sent to control');
  assert.equal(await readReportedKey(ctx.stateDir), publicKey, 'reported key is remembered');
  assert.ok(!JSON.stringify(h.posts).includes((await fs.readFile(path.join(ctx.stateDir, 'wireguard', 'private.key'), 'utf8')).trim()), 'the private key never appears in any request');

  const syncAt = h.log.findIndex(l => l.startsWith('wg syncconf wg0'));
  const pullAt = h.log.findIndex(l => l.startsWith('docker compose -p blog pull'));
  assert.ok(syncAt >= 0 && syncAt < pullAt, 'mesh is reconciled before the project rolls out');
  assert.ok(h.log.includes('ip address replace 10.210.0.1/16 dev wg0'), 'overlay address assigned to wg0');

  const written = await fs.readFile(path.join(ctx.stateDir, 'projects', 'blog', 'docker-compose.yml'), 'utf8');
  assert.match(written, /- db:10\.210\.0\.2/, 'db on another node resolves via extra_hosts');
  assert.match(written, /- db\.blog\.launchpad:10\.210\.0\.2/, 'project-qualified name is injected as well');

  h.posts.length = 0;
  await pollOnce(ctx);
  assert.ok(!h.posts.some(p => p.route === '/agent/v1/wireguard/key'), 'the key is not re-reported on later polls');
});

test('with the mesh disabled the agent never touches wg/ip or reports a key', async () => {
  const h = harness(() => ({ desiredStates: [desired], network }));
  const ctx = await makeCtx(h, { mesh: false, host: (async () => { throw new Error('host runner must not be used'); }) as HostRunner });
  await pollOnce(ctx);
  assert.ok(!h.posts.some(p => p.route.includes('wireguard')), 'no key report');
  assert.ok(!h.log.some(l => l.startsWith('wg ') || l.startsWith('ip ')), 'no wg or ip invocation');
});

test('a failing mesh reconcile does not stop services from rolling out', async () => {
  const h = harness(() => ({ desiredStates: [desired], network }));
  const ctx = await makeCtx(h, { host: (async () => { throw new Error('wireguard: operation not permitted'); }) as HostRunner });
  const projects = await pollOnce(ctx);
  assert.equal(projects[0].health, 'serving', 'projects still reconcile; the mesh error is logged, not fatal');
});

test('an ingress node runs Caddy and reports its status; losing the role removes the container', async () => {
  const ingress = { caddyfile: 'app.example.com {\n}\n', files: {}, routes: [], warnings: [] };
  let current: Partial<WorkResponse> = { ingress };
  const h = harness(() => current);
  const ctx = await makeCtx(h, { mesh: false });
  await pollOnce(ctx);
  assert.ok(h.log.some(l => l.startsWith('docker create --name launchpad-caddy')), 'managed Caddy container created');
  const status = h.posts.find(p => p.route === '/agent/v1/status')!.body;
  assert.equal(status.ingress.state, 'serving', 'edge state is part of the status report');
  assert.equal(status.ingress.routes, 0);

  current = {};
  h.log.length = 0; h.posts.length = 0;
  await pollOnce(ctx);
  assert.ok(h.log.includes('docker rm -f launchpad-caddy'), 'the container is removed once control stops sending ingress');
  assert.equal(h.posts.find(p => p.route === '/agent/v1/status')!.body.ingress, undefined, 'no ingress status for non-ingress nodes');
});

test('wg.rotate-key generates a new keypair, reports the public key and succeeds', async () => {
  const h = harness(() => ({}));
  const ctx = await makeCtx(h);
  const before = await ensureWgKeys(ctx.stateDir);
  const result = await executeCommand({ id: 'c1', type: 'wg.rotate-key' }, ctx);
  const after = await ensureWgKeys(ctx.stateDir);
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.result, { publicKey: after.publicKey }, 'result carries the new public key only');
  assert.notEqual(after.publicKey, before.publicKey, 'a new keypair replaced the old one');
  assert.deepEqual(h.posts[0], { route: '/agent/v1/wireguard/key', body: { publicKey: after.publicKey } }, 'control is told the new key');
  assert.equal(await readReportedKey(ctx.stateDir), after.publicKey);

  await assert.rejects(executeCommand({ id: 'c2', type: 'wg.rotate-key' }, await makeCtx(h, { mesh: false })), /mesh is not enabled/, 'refuses on agents that do not run the mesh');
});

test('diagnostics include WireGuard checks only when the mesh is enabled', async () => {
  const h = harness(() => ({}));
  const names = async (ctx: AgentContext) => ((await executeCommand({ id: 'd', type: 'diagnostics.run' }, ctx)).result as { checks: { name: string }[] }).checks.map(c => c.name);
  assert.deepEqual(await names(await makeCtx(h)), ['docker.info', 'docker.version', 'docker.compose.version', 'wireguard.version', 'wireguard.interface']);
  assert.deepEqual(await names(await makeCtx(h, { mesh: false })), ['docker.info', 'docker.version', 'docker.compose.version']);
});
