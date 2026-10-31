import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { containerIp, executeCommand, pollOnce, reconcile, waitForHealth } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState } from './compose.ts';
import type { ComposeFile, HealthCheck, SecretsResponse } from './protocol.ts';
import type { DockerRunner, HttpClient } from './runners.ts';

interface DockerCall { args: string[]; cwd?: string }

/** Records every docker invocation; `handler` may return canned stdout or throw. */
function fakeDocker(handler: (args: string[]) => string | void = () => '') {
  const calls: DockerCall[] = [];
  const docker: DockerRunner = async (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    return { out: handler(args) ?? '', err: '' };
  };
  return { docker, calls, commands: () => calls.map(c => c.args.join(' ')) };
}

interface FakeControl { http: HttpClient; events: { type: string; level?: string; message?: string; metadata: { service: string } }[]; requests: string[] }
function fakeControl(secrets: () => SecretsResponse): FakeControl {
  const events: FakeControl['events'] = [];
  const requests: string[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    requests.push(u);
    if (u.includes('/agent/v1/secrets')) return Response.json(secrets());
    if (u.includes('/agent/v1/events')) { events.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
    return Response.json({});
  }) as HttpClient;
  return { http, events, requests };
}

async function makeCtx(overrides: Partial<AgentContext> = {}): Promise<AgentContext> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-unit-'));
  return { docker: fakeDocker().docker, http: fakeControl(() => ({ secrets: {}, versions: {} })).http, nodeName: 'n1', stateDir, apply: true, controlUrl: 'http://control.test', token: 'tok', ...overrides };
}

const place = { 'x-tug': { placement: { nodes: ['n1'] } } };
function desired(compose: ComposeFile, version = 'v1', project = 'proj') {
  return buildDesiredState({ project, version, compose, registry: 'reg.test', defaultNode: 'n1' });
}
const twoServices: ComposeFile = {
  services: {
    web: { image: 'nginx', environment: { API_KEY: '${API_KEY}' }, ...place },
    worker: { image: 'busybox', environment: { STATIC: 'x' }, ...place },
  },
};

test('reconcile rolls out pull -> up -> health in order and reports serving', async () => {
  const d = fakeDocker();
  const control = fakeControl(() => ({ secrets: {}, versions: {} }));
  const ctx = await makeCtx({ docker: d.docker, http: control.http });
  const status = await reconcile(desired(twoServices), ctx);

  assert.deepEqual(d.commands(), ['compose -p proj pull', 'compose -p proj up -d --remove-orphans']);
  assert.ok(d.calls.every(c => c.cwd === path.join(ctx.stateDir, 'projects', 'proj')));
  assert.equal(status.health, 'serving');
  assert.deepEqual(status.services, ['web', 'worker']);
  assert.equal(status.serviceStates?.web.rolloutState, 'serving');
  assert.ok(status.serviceStates?.web.healthyAt);
  assert.deepEqual(control.events.map(e => `${e.type}:${e.metadata.service}`), [
    'service.pulling:web', 'service.pulling:worker',
    'service.starting:web', 'service.starting:worker',
    'service.health_checking:web', 'service.serving:web',
    'service.health_checking:worker', 'service.serving:worker',
  ]);
  const compose = await fs.readFile(path.join(ctx.stateDir, 'projects', 'proj', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /image: nginx/);
});

test('registry images are pulled once per desired version, not on every poll', async () => {
  const d = fakeDocker();
  const ctx = await makeCtx({ docker: d.docker });
  await reconcile(desired(twoServices), ctx);
  assert.ok(d.commands().includes('compose -p proj pull'), 'the first apply of a version pulls its images');

  d.calls.length = 0;
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual(d.commands(), ['compose -p proj up -d --remove-orphans'], 'reapplying the same version must not pull, so a tag that moved upstream is not deployed without a deploy');

  d.calls.length = 0;
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.ok(d.commands().includes('compose -p proj pull'), 'a new desired version pulls again');
});

test('a failed apply pulls again on the retry', async () => {
  let failUp = true;
  const d = fakeDocker(args => { if (args.includes('up') && failUp) throw new Error('up failed'); });
  const ctx = await makeCtx({ docker: d.docker });
  await assert.rejects(reconcile(desired(twoServices), ctx));

  d.calls.length = 0;
  failUp = false;
  await reconcile(desired(twoServices), ctx);
  assert.ok(d.commands().includes('compose -p proj pull'), 'a version that never applied successfully must be pulled again on retry');
});

test('reconcile skips projects with no services for this node', async () => {
  const d = fakeDocker();
  const ctx = await makeCtx({ docker: d.docker, nodeName: 'elsewhere' });
  const status = await reconcile(desired(twoServices), ctx);
  assert.equal(status.health, 'skipped');
  assert.deepEqual(d.calls, []);
});

test('reconcile with apply=false never touches docker', async () => {
  const d = fakeDocker();
  const ctx = await makeCtx({ docker: d.docker, apply: false });
  const status = await reconcile(desired(twoServices), ctx);
  assert.deepEqual(d.calls, []);
  assert.equal(status.serviceStates?.web.rolloutState, 'serving');
});

test('a changed secret force-recreates only the services that reference it, only on the same version', async () => {
  let versions: Record<string, number> = { API_KEY: 1 };
  const control = fakeControl(() => ({ secrets: { API_KEY: 'k' }, versions }));
  const d = fakeDocker();
  const ctx = await makeCtx({ docker: d.docker, http: control.http });

  await reconcile(desired(twoServices), ctx);
  assert.ok(!d.commands().some(c => c.includes('--force-recreate')), 'first apply has nothing to recreate');

  d.calls.length = 0;
  await reconcile(desired(twoServices), ctx);
  assert.ok(!d.commands().some(c => c.includes('--force-recreate')), 'unchanged secrets do not recreate');

  d.calls.length = 0;
  versions = { API_KEY: 2 };
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual(d.commands(), [
    'compose -p proj up -d --remove-orphans',
    'compose -p proj up -d --no-deps --force-recreate web',
  ], 'a secret change on the same version recreates the service without pulling');
  assert.ok(control.events.some(e => e.type === 'service.secret_recreate' && e.metadata.service === 'web'));

  d.calls.length = 0;
  versions = { API_KEY: 3 };
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.ok(!d.commands().some(c => c.includes('--force-recreate')), 'a new desired version already recreates via up -d');
});

test('secrets are written to .env with 0600 and referenced via env_file', async () => {
  const control = fakeControl(() => ({ secrets: { API_KEY: 'line1\nline2' }, versions: { API_KEY: 1 } }));
  const ctx = await makeCtx({ http: control.http, apply: false });
  await reconcile(desired(twoServices), ctx);
  const dir = path.join(ctx.stateDir, 'projects', 'proj');
  assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'API_KEY=line1\\nline2\n');
  assert.equal((await fs.stat(path.join(dir, '.env'))).mode & 0o777, 0o600);
  assert.match(await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8'), /env_file:\s+- \.env/);
});

test('reconcile sends the bearer token to control and fails without one', async () => {
  const seen: (string | null)[] = [];
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ secrets: {}, versions: {} });
  }) as HttpClient;
  const ctx = await makeCtx({ http, apply: false });
  await reconcile(desired(twoServices), ctx);
  assert.ok(seen.length > 0 && seen.every(h => h === 'Bearer tok'));
  await assert.rejects(reconcile(desired(twoServices, 'v2'), { ...ctx, token: undefined }), /TUG_AGENT_TOKEN required/);
});

const fastRetry = { interval: '1ms', retries: 3 } as const;
const inspectJson = (state: object, ip = '10.0.0.5') => JSON.stringify([{ State: state, NetworkSettings: { Networks: { net: { IPAddress: ip } } } }]);

test('docker health: passes when running and healthy, retries then fails otherwise', async () => {
  const ok = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true, Health: { Status: 'healthy' } }) : 'cid1\n');
  const ctx = await makeCtx({ docker: ok.docker });
  const health: HealthCheck = { type: 'docker', ...fastRetry };
  await waitForHealth(ctx, 'proj', 'web', health, '/tmp');
  assert.deepEqual(ok.commands(), ['compose -p proj ps -q web', 'inspect cid1']);

  const stopped = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: false }) : 'cid1\n');
  await assert.rejects(waitForHealth({ ...ctx, docker: stopped.docker }, 'proj', 'web', health, '/tmp'), /web: not running/);
  assert.equal(stopped.calls.filter(c => c.args[0] === 'inspect').length, 3, 'retries exhausted');

  const unhealthy = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true, Health: { Status: 'starting' } }) : 'cid1\n');
  await assert.rejects(waitForHealth({ ...ctx, docker: unhealthy.docker }, 'proj', 'web', health, '/tmp'), /docker health starting/);
});

test('docker health: recovers when the container becomes healthy on a later attempt', async () => {
  let n = 0;
  const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true, Health: { Status: ++n < 3 ? 'starting' : 'healthy' } }) : 'cid1\n');
  const ctx = await makeCtx({ docker: d.docker });
  await waitForHealth(ctx, 'proj', 'web', { type: 'docker', interval: '1ms', retries: 5 }, '/tmp');
  assert.equal(n, 3);
});

test('http health: follows the container IP and honours the status code', async () => {
  const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true }, '10.1.2.3') : 'cid1\n');
  const urls: string[] = [];
  let status = 200;
  const http = (async (url: string | URL | Request) => { urls.push(String(url)); return new Response('x', { status }); }) as HttpClient;
  const ctx = await makeCtx({ docker: d.docker, http });
  const health: HealthCheck = { type: 'http', port: 8080, path: '/up', ...fastRetry };
  await waitForHealth(ctx, 'proj', 'web', health, '/tmp');
  assert.deepEqual(urls, ['http://10.1.2.3:8080/up']);

  status = 503; urls.length = 0;
  await assert.rejects(waitForHealth(ctx, 'proj', 'web', health, '/tmp'), /web: http 503/);
  assert.equal(urls.length, 3);

  urls.length = 0;
  await waitForHealth(ctx, 'proj', 'web', { type: 'http', interval: '1ms' }, '/tmp').catch(() => {});
  assert.equal(urls[0], 'http://10.1.2.3:80/', 'defaults to port 80 and path /');
});

test('a failed http health check names the check, the attempts and the network error behind "fetch failed"', async () => {
  const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true }, '10.1.2.3') : 'cid1\n');
  const refused = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:8081'), { code: 'ECONNREFUSED' }) }); }) as HttpClient;
  const ctx = await makeCtx({ docker: d.docker, http: refused });
  await assert.rejects(
    waitForHealth(ctx, 'proj', 'web', { type: 'http', port: 8081, path: '/', ...fastRetry }, '/tmp'),
    /web: http health check on port 8081\/ failed after 3 attempts: fetch failed \(ECONNREFUSED\)/,
    'an operator reading a rejected rollout must see which check failed and why, not just "fetch failed"'
  );
});

const oneService: ComposeFile = { services: { web: { image: 'nginx', 'x-tug': { placement: { nodes: ['n1'] }, health: { type: 'docker', interval: '1ms', retries: 2 } } } } };

test('polling an unchanged project adds no lifecycle events, but still applies and checks it', async () => {
  const d = fakeDocker();
  const control = fakeControl(() => ({ secrets: {}, versions: {} }));
  const ctx = await makeCtx({ docker: d.docker, http: control.http });
  await reconcile(desired(twoServices), ctx);
  const first = control.events.length;
  assert.equal(first, 8, 'the first apply announces every step for both services');
  for (let i = 0; i < 3; i++) await reconcile(desired(twoServices), { ...ctx });
  assert.equal(control.events.length, first, 'three more polls of the same revision, including after an agent restart, must not add events');
  assert.equal(d.commands().filter(c => c.includes(' up -d')).length, 4, 'every poll still applies the project, so drift is still repaired');
});

test('a new revision or changed secrets announce themselves again, and the same inputs are quiet afterwards', async () => {
  let versions: Record<string, number> = { API_KEY: 1 };
  const control = fakeControl(() => ({ secrets: { API_KEY: 'k' }, versions }));
  const ctx = await makeCtx({ docker: fakeDocker().docker, http: control.http });
  await reconcile(desired(twoServices, 'v1'), ctx);
  let seen = control.events.length;
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.equal(control.events.slice(seen).filter(e => e.type === 'service.serving').length, 2, 'a new version announces serving for both services');
  seen = control.events.length;
  versions = { API_KEY: 2 };
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.ok(control.events.slice(seen).some(e => e.type === 'service.secret_recreate' && e.metadata.service === 'web'), 'a changed secret is announced for the service that uses it');
  seen = control.events.length;
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.equal(control.events.length, seen, 'the same inputs again are quiet');
});

test('a failing apply is announced once, retries stay quiet, and recovery is announced once', async () => {
  let running = false;
  const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: running }) : 'cid1\n');
  const control = fakeControl(() => ({ secrets: {}, versions: {} }));
  const ctx = await makeCtx({ docker: d.docker, http: control.http });
  const project = desired(oneService);

  await assert.rejects(reconcile(project, ctx), /not running/);
  const failed = control.events.filter(e => e.type === 'service.failed');
  assert.equal(failed.length, 1, 'the first failure is announced');
  assert.equal(failed[0].level, 'error', 'a failure is an error-level event');
  assert.match(String(failed[0].message), /web: docker health check failed after 2 attempts: web: not running/, 'the event says what failed and why');
  assert.equal(failed[0].metadata.service, 'web', 'it names the service whose check failed');

  const seen = control.events.length;
  await assert.rejects(reconcile(project, ctx), /not running/);
  await assert.rejects(reconcile(project, ctx), /not running/);
  assert.equal(control.events.length, seen, 'retrying the same failure adds no events');

  running = true;
  await reconcile(project, ctx);
  assert.deepEqual(control.events.slice(seen).map(e => `${e.type}:${e.message}`), ['service.serving:serving again after a failure'], 'recovery is announced exactly once');
  await reconcile(project, ctx);
  assert.equal(control.events.length, seen + 1, 'once recovered, polling is quiet again');

  running = false;
  await assert.rejects(reconcile(project, ctx), /not running/);
  assert.equal(control.events.filter(e => e.type === 'service.failed').length, 2, 'a later failure of an already serving project is announced once more');
});

test('tcp health: connects to the container IP and port', async () => {
  const server = net.createServer(s => s.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true }, '127.0.0.1') : 'cid1\n');
    const ctx = await makeCtx({ docker: d.docker });
    await waitForHealth(ctx, 'proj', 'db', { type: 'tcp', port, ...fastRetry }, '/tmp');
  } finally { await new Promise(resolve => server.close(resolve)); }

  const closed = net.createServer(); await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = (closed.address() as AddressInfo).port; await new Promise(resolve => closed.close(resolve));
  const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: true }, '127.0.0.1') : 'cid1\n');
  const ctx = await makeCtx({ docker: d.docker });
  await assert.rejects(waitForHealth(ctx, 'proj', 'db', { type: 'tcp', port: deadPort, interval: '1ms', retries: 2 }, '/tmp'));
});

test('health check is skipped without apply or without a health spec', async () => {
  const d = fakeDocker();
  const ctx = await makeCtx({ docker: d.docker });
  await waitForHealth(ctx, 'proj', 'web', null, '/tmp');
  await waitForHealth({ ...ctx, apply: false }, 'proj', 'web', { type: 'docker' }, '/tmp');
  assert.deepEqual(d.calls, []);
});

test('reconcile fails the rollout when a service health check never passes', async () => {
  const d = fakeDocker(args => args[0] === 'inspect' ? inspectJson({ Running: false }) : 'cid1\n');
  const compose: ComposeFile = { services: { web: { image: 'nginx', 'x-tug': { placement: { nodes: ['n1'] }, health: { type: 'docker', interval: '1ms', retries: 2 } } } } };
  const ctx = await makeCtx({ docker: d.docker });
  await assert.rejects(reconcile(desired(compose), ctx), /not running/);
});

test('containerIp resolves the first network IP, falls back to loopback, and errors without a container', async () => {
  const ctx = await makeCtx({ docker: fakeDocker(args => args[0] === 'inspect' ? inspectJson({}, '172.18.0.2') : 'cid1\ncid2\n').docker });
  assert.equal(await containerIp(ctx, 'proj', 'web', '/tmp'), '172.18.0.2');

  const noNet = await makeCtx({ docker: fakeDocker(args => args[0] === 'inspect' ? JSON.stringify([{}]) : 'cid1\n').docker });
  assert.equal(await containerIp(noNet, 'proj', 'web', '/tmp'), '127.0.0.1');

  const none = await makeCtx({ docker: fakeDocker().docker });
  await assert.rejects(containerIp(none, 'proj', 'web', '/tmp'), /web: no container found/);
});

test('executeCommand drives docker for restart, logs, volume delete and diagnostics', async () => {
  const d = fakeDocker(args => args[0] === 'compose' && args[3] === 'logs' ? 'log-line\n' : 'ok');
  const ctx = await makeCtx({ docker: d.docker });
  const dir = path.join(ctx.stateDir, 'projects', 'proj');

  assert.deepEqual(
    await executeCommand({ id: 'c1', type: 'service.restart', payload_json: JSON.stringify({ project: 'proj', service: 'web' }) }, ctx),
    { commandId: 'c1', state: 'succeeded', result: { project: 'proj', service: 'web', restarted: true } });
  assert.deepEqual(d.calls.at(-1), { args: ['compose', '-p', 'proj', 'restart', 'web'], cwd: dir });

  const logs = await executeCommand({ id: 'c2', type: 'logs.fetch', payload_json: JSON.stringify({ project: 'proj', service: 'web', tail: 50 }) }, ctx);
  assert.deepEqual(logs.result, { stdout: 'log-line\n', stderr: '' });
  assert.deepEqual(d.calls.at(-1)?.args, ['compose', '-p', 'proj', 'logs', '--no-color', '--tail', '50', 'web']);

  await executeCommand({ id: 'c3', type: 'volume.delete', payload_json: JSON.stringify({ project: 'proj', volume: 'data' }) }, ctx);
  assert.deepEqual(d.calls.at(-1)?.args, ['volume', 'rm', 'proj_data']);

  const diag = await executeCommand({ id: 'c4', type: 'diagnostics.run', payload_json: '{}' }, ctx);
  assert.equal(diag.state, 'succeeded');
  assert.deepEqual((diag.result as { node: string }).node, 'n1');
  assert.deepEqual(d.commands().slice(-4, -1), ['info', 'version', 'compose version'], 'diagnostics query docker, its version and compose');
  assert.match(d.commands().at(-1) || '', /^ps --filter label=com.docker.compose.project/, 'diagnostics finish by listing Compose containers for the public-port check');
});

test('executeCommand tolerates a missing volume, reports failing diagnostics, rejects unknown types', async () => {
  const missing = await makeCtx({ docker: (async () => { throw new Error('Error: No such volume: proj_data'); }) as DockerRunner });
  const deleted = await executeCommand({ id: 'c1', type: 'volume.delete', payload_json: JSON.stringify({ project: 'proj', volume: 'data' }) }, missing);
  assert.equal(deleted.state, 'succeeded');

  const broken = await makeCtx({ docker: (async () => { throw new Error('permission denied'); }) as DockerRunner });
  await assert.rejects(executeCommand({ id: 'c2', type: 'volume.delete', payload_json: JSON.stringify({ project: 'proj', volume: 'data' }) }, broken), /permission denied/);
  const diag = await executeCommand({ id: 'c3', type: 'diagnostics.run' }, broken);
  assert.equal(diag.state, 'failed');
  assert.equal((diag.result as { checks: { ok: boolean }[] }).checks.every(c => !c.ok), true);

  const unknown = await executeCommand({ id: 'c4', type: 'nope' }, broken);
  assert.deepEqual(unknown, { commandId: 'c4', state: 'failed', result: { error: 'unsupported command nope' } });
});

test('pollOnce reconciles desired states, runs commands and posts one status report', async () => {
  const posted: unknown[] = [];
  const d = fakeDocker();
  const work = { serverTime: 't', nodeId: 'n1', desiredStates: [desired(twoServices), desired({ services: { bad: { image: 'x', environment: {}, 'x-tug': { placement: { nodes: ['n1'] }, health: { type: 'docker', interval: '1ms', retries: 1 } } } } }, 'v1', 'bad-proj')], commands: [{ id: 'c1', type: 'service.restart', payload_json: JSON.stringify({ project: 'proj', service: 'web' }) }] };
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/agent/v1/work')) return Response.json(work);
    if (u.endsWith('/agent/v1/status')) { posted.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
    return Response.json({ secrets: {}, versions: {} });
  }) as HttpClient;
  const failing: DockerRunner = async (args, opts) => {
    if (args[0] === 'inspect') return { out: inspectJson({ Running: false }), err: '' };
    return d.docker(args, opts);
  };
  const ctx = await makeCtx({ docker: failing, http });
  const projects = await pollOnce(ctx);

  assert.deepEqual(projects.map(p => [p.project, p.health]), [['proj', 'serving'], ['bad-proj', 'failed']]);
  assert.equal(posted.length, 1);
  const report = posted[0] as { node: string; projects: unknown[]; commandResults: { commandId: string; state: string }[] };
  assert.equal(report.node, 'n1');
  assert.equal(report.projects.length, 2);
  assert.deepEqual(report.commandResults.map(r => [r.commandId, r.state]), [['c1', 'succeeded']]);
});
