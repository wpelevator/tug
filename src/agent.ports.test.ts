import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { executeCommand, publicListeners, reconcile, resolveBindAddress } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState } from './compose.ts';
import type { ComposeFile, DiagnosticCheck } from './protocol.ts';
import type { DockerRunner, HttpClient } from './runners.ts';

interface Event { type: string; level?: string; message?: string; metadata: Record<string, unknown> }

async function makeCtx(docker: DockerRunner = async () => ({ out: '', err: '' })): Promise<{ ctx: AgentContext; events: Event[] }> {
  const events: Event[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/agent/v1/secrets')) return Response.json({ secrets: {}, versions: {} });
    if (u.includes('/agent/v1/events')) events.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as HttpClient;
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-ports-'));
  return { ctx: { docker, http, nodeName: 'n1', stateDir, apply: true, controlUrl: 'http://control.test', token: 'tok' }, events };
}

const compose: ComposeFile = {
  services: {
    web: { image: 'nginx', ports: ['8080:80'], 'x-tug': { placement: { nodes: ['n1'] }, ingress: { host: 'a.example.com', port: 80 } } },
    db: { image: 'mariadb', ports: ['3306:3306', '0.0.0.0:3307:3307'], 'x-tug': { placement: { nodes: ['n1'] } } }
  }
};
const desired = (version = 'v1') => buildDesiredState({ project: 'proj', version, compose, registry: '' });
const rendered = async (ctx: AgentContext) => yaml.load(await fs.readFile(path.join(ctx.stateDir, 'projects', 'proj', 'docker-compose.yml'), 'utf8')) as ComposeFile;

test('resolveBindAddress uses loopback without an address, IPs as given and resolves hostnames', async () => {
  assert.equal(await resolveBindAddress(null), '127.0.0.1', 'a node without an address binds published ports to loopback');
  assert.equal(await resolveBindAddress('10.210.0.4'), '10.210.0.4', 'an IPv4 address is used as is');
  assert.equal(await resolveBindAddress('[fd00::4]'), 'fd00::4', 'a bracketed IPv6 address is unwrapped');
  assert.equal(await resolveBindAddress('node1.internal', async host => ({ address: host === 'node1.internal' ? '192.168.1.9' : '' })), '192.168.1.9', 'a hostname address is resolved on the node');
  await assert.rejects(resolveBindAddress('missing.internal', async () => { throw new Error('ENOTFOUND'); }), /cannot resolve node address missing\.internal to bind published ports: ENOTFOUND/, 'an unresolvable hostname fails the reconcile with a clear reason instead of publishing on every interface');
});

test('reconcile renders ports on the bind address control sends, with the loopback ingress port on 127.0.0.1', async () => {
  const { ctx, events } = await makeCtx();
  await reconcile(desired(), ctx, {}, { address: '10.210.0.4', loopback: { proj: ['web'] } });
  const file = await rendered(ctx);
  assert.deepEqual(file.services.web.ports, ['127.0.0.1:8080:80'], 'the ingress port only the local Caddy dials listens on loopback');
  assert.deepEqual(file.services.db.ports, ['10.210.0.4:3306:3306', '0.0.0.0:3307:3307'], 'other ports listen on the overlay address and an explicit 0.0.0.0 is left as written');
  assert.equal(events.some(e => e.type === 'ports.public'), false, 'a private bind address raises no public-port warning');
});

test('reconcile without a port binding never publishes on every interface', async () => {
  const { ctx } = await makeCtx();
  await reconcile(desired(), ctx);
  assert.deepEqual((await rendered(ctx)).services.db.ports, ['127.0.0.1:3306:3306', '0.0.0.0:3307:3307'], 'with no binding from control, unbound ports fall back to loopback');
});

test('a public bind address raises one ports.public warning until it changes', async () => {
  const { ctx, events } = await makeCtx();
  const binding = { address: '203.0.113.7', loopback: {} };
  await reconcile(desired(), ctx, {}, binding);
  await reconcile(desired(), ctx, {}, binding);
  const warnings = events.filter(e => e.type === 'ports.public');
  assert.equal(warnings.length, 1, 'the warning is sent once, not on every poll');
  assert.equal(warnings[0].level, 'warn', 'the event is a warning');
  assert.deepEqual(warnings[0].metadata.services, ['db', 'web'], 'the warning names the services bound to the public address');
  assert.match(warnings[0].message || '', /listen on public address 203\.0\.113\.7/, 'the message names the public address');
  assert.deepEqual((await rendered(ctx)).services.db.ports, ['203.0.113.7:3306:3306', '0.0.0.0:3307:3307'], 'without the mesh ports bind to the node address even when it is public');

  await reconcile(desired(), ctx, {}, { address: '203.0.113.7', loopback: { proj: ['web'] } });
  assert.equal(events.filter(e => e.type === 'ports.public').length, 2, 'a changed set of exposed services is reported again');
});

test('publicListeners finds Tug project containers listening on all interfaces or a public IP', () => {
  const ps = [
    'proj\tproj-db-1\t0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp',
    'proj\tproj-cache-1\t10.210.0.4:6379->6379/tcp',
    'proj-web-1a2b3c4d\tproj-web-1a2b3c4d-web-1\t127.0.0.1:20001->80/tcp',
    'proj-api-9f8e7d6c\tproj-api-9f8e7d6c-api-1\t203.0.113.7:20002->8080/tcp',
    'other\tother-web-1\t0.0.0.0:80->80/tcp',
    'proj\tproj-dns-1\t0.0.0.0:5353-5354->53-54/udp',
    'proj\tproj-worker-1\t'
  ].join('\n');
  assert.deepEqual(publicListeners(ps, ['proj']), [
    { project: 'proj', container: 'proj-db-1', listen: '0.0.0.0:3306->3306/tcp' },
    { project: 'proj', container: 'proj-db-1', listen: '[::]:3306->3306/tcp' },
    { project: 'proj-api-9f8e7d6c', container: 'proj-api-9f8e7d6c-api-1', listen: '203.0.113.7:20002->8080/tcp' },
    { project: 'proj', container: 'proj-dns-1', listen: '0.0.0.0:5353-5354->53-54/udp' }
  ], 'all-interface and public listeners of Tug projects and their rolling revisions are reported; overlay, loopback and non-Tug containers are not');
});

test('diagnostics report public listeners as a warning that does not fail the check', async () => {
  const docker: DockerRunner = async args => ({ out: args[0] === 'ps' ? 'proj\tproj-db-1\t0.0.0.0:3306->3306/tcp\n' : 'ok', err: '' });
  const { ctx } = await makeCtx(docker);
  await fs.mkdir(path.join(ctx.stateDir, 'projects', 'proj'), { recursive: true });
  const result = await executeCommand({ id: 'd', type: 'diagnostics.run' }, ctx);
  const check = (result.result as { checks: DiagnosticCheck[] }).checks.find(c => c.name === 'ports.public');
  assert.equal(result.state, 'succeeded', 'an intended public port does not fail diagnostics');
  assert.equal(check?.ok, true, 'the check passes');
  assert.match(check?.warning || '', /1 published port of Tug projects listens on a public address/, 'the warning counts the public listeners');
  assert.match(check?.stdout || '', /proj-db-1\t0\.0\.0\.0:3306->3306\/tcp/, 'the output names the container and listen address');

  const quiet = await makeCtx(async () => ({ out: '', err: '' }));
  const clean = (await executeCommand({ id: 'd2', type: 'diagnostics.run' }, quiet.ctx)).result as { checks: DiagnosticCheck[] };
  assert.equal(clean.checks.find(c => c.name === 'ports.public')?.warning, undefined, 'no warning when nothing listens publicly');
});
