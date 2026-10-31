import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { reconcile } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState, composeForNode } from './compose.ts';
import { loadRolloutState, parsePortRange, remapPublishedPort, revisionProject, rollingCompose, serviceRevisionHash } from './rollout.ts';
import type { ComposeFile, SecretsResponse } from './protocol.ts';
import type { DockerRunner, HttpClient } from './runners.ts';

interface FakeContainer { id: string; project: string; service: string; image: string; port: number | null; ip: string }

/**
 * A tiny Docker model: `compose up -d` on a revision project creates (or keeps) a container with the
 * image and host port from its Compose file, `ps` filters by Compose labels, `stop`/`rm` remove containers.
 * Images listed in `unhealthy` fail their HTTP health check.
 */
function fakeHost() {
  const containers = new Map<string, FakeContainer>();
  const calls: string[] = [];
  const unhealthy = new Set<string>();
  const networks = new Set<string>();
  const volumes: string[] = [];
  const busyPorts = new Set<number>();
  let failMainUp: string | null = null;
  let next = 1;
  const byProject = (project: string, service?: string) => [...containers.values()].filter(c => c.project === project && (!service || c.service === service));
  const label = (args: string[], key: string) => args.find(a => a.startsWith(`label=com.docker.compose.${key}=`))?.split('=')[2];
  const docker: DockerRunner = async (args, opts) => {
    calls.push(args.join(' '));
    const out = (s = '') => ({ out: s, err: '' });
    if (args[0] === 'compose') {
      const project = args[args.indexOf('-p') + 1];
      const fileIndex = args.indexOf('-f');
      const verb = args.find((a, i) => i > 2 && ['up', 'pull', 'ps'].includes(a) && (fileIndex < 0 || i > fileIndex))!;
      if (verb === 'ps') return out(byProject(project, args.at(-1)).map(c => c.id).join('\n'));
      if (verb === 'up' && fileIndex < 0) {
        if (failMainUp) throw new Error(failMainUp);
        const file = yaml.load(await fs.readFile(path.join(opts!.cwd!, 'docker-compose.yml'), 'utf8')) as ComposeFile;
        for (const [service, svc] of Object.entries(file.services)) {
          if (byProject(project, service).length) continue;
          const id = `c${next++}`;
          containers.set(id, { id, project, service, image: svc.image!, port: svc.ports?.length ? Number(String(svc.ports[0]).split(':').at(-2)) : null, ip: `10.0.0.${next}` });
        }
        return out();
      }
      if (verb === 'up') {
        const file = yaml.load(await fs.readFile(args[fileIndex + 1], 'utf8')) as ComposeFile;
        const [service, svc] = Object.entries(file.services)[0];
        const port = svc.ports?.length ? Number(String(svc.ports[0]).split(':').at(-2)) : null;
        const existing = byProject(project, service)[0];
        if (existing && existing.port === port && existing.image === svc.image) return out();
        if (existing) containers.delete(existing.id);
        if (port && ([...containers.values()].some(c => c.port === port) || busyPorts.has(port))) throw new Error(`Bind for 0.0.0.0:${port} failed: port is already allocated`);
        const id = `c${next++}`;
        containers.set(id, { id, project, service, image: svc.image!, port, ip: `10.0.0.${next}` });
        return out();
      }
      return out();
    }
    if (args[0] === 'ps' && args.includes('--format')) return out([...containers.values()].filter(c => c.port).map(c => `0.0.0.0:${c.port}->80/tcp, [::]:${c.port}->80/tcp`).join('\n'));
    if (args[0] === 'ps') {
      const project = label(args, 'project')!; const service = label(args, 'service');
      return out(byProject(project, service).map(c => c.id).join('\n'));
    }
    if (args[0] === 'inspect') {
      const c = containers.get(args[1]);
      return out(JSON.stringify([{ State: { Running: Boolean(c) }, NetworkSettings: { Networks: { net: { IPAddress: c?.ip } } } }]));
    }
    if (args[0] === 'stop') return out();
    if (args[0] === 'rm') { for (const id of args.slice(2)) containers.delete(id); return out(); }
    if (args[0] === 'network' && args[1] === 'inspect') { if (!networks.has(args[2])) throw new Error('No such network'); return out(); }
    if (args[0] === 'network' && args[1] === 'create') { networks.add(args.at(-1)!); return out(); }
    if (args[0] === 'volume' && args[1] === 'create') { volumes.push(args.at(-1)!); return out(); }
    return out();
  };
  const http = (async (url: string | URL | Request) => {
    const ip = new URL(String(url)).hostname;
    const c = [...containers.values()].find(candidate => candidate.ip === ip);
    return new Response('', { status: c && !unhealthy.has(c.image) ? 200 : 503 });
  }) as HttpClient;
  /** Live containers of a project, as `service@port` in id order. */
  const running = (project: string) => byProject(project).map(c => `${c.service}@${c.port}:${c.image}`);
  return { docker, http, containers, calls, unhealthy, networks, volumes, busyPorts, byProject, running, failMain: (message: string | null) => { failMainUp = message; } };
}

function fakeControl(http: HttpClient, secrets: () => SecretsResponse = () => ({ secrets: {}, versions: {} })): HttpClient {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/agent/v1/secrets')) return Response.json(secrets());
    if (u.includes('/agent/v1/events')) return Response.json({ ok: true });
    if (u.startsWith('http://control.test')) return Response.json({});
    return http(url, init);
  }) as HttpClient;
}

async function makeCtx(host: ReturnType<typeof fakeHost>, overrides: Partial<AgentContext> = {}, secrets?: () => SecretsResponse): Promise<AgentContext> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-rollout-unit-'));
  return { docker: host.docker, http: fakeControl(host.http, secrets), nodeName: 'n1', stateDir, apply: true, controlUrl: 'http://control.test', token: 'tok', ...overrides };
}

const health = { type: 'http' as const, port: 80, path: '/', retries: 1, interval: '1ms' };
function webService(image: string, extra: Record<string, unknown> = {}) {
  return {
    image, ports: ['8080:80'], depends_on: ['db'], volumes: ['assets:/srv/assets'],
    'x-tug': { placement: { nodes: ['n1'] }, health, ingress: { host: 'app.test', port: 80, tls: 'off' }, rollout: { strategy: 'rolling', drain: '40ms' }, ...extra },
  };
}
function rolling(image: string, extra: Record<string, unknown> = {}): ComposeFile {
  return {
    services: { web: webService(image, extra), db: { image: 'postgres', 'x-tug': { placement: { nodes: ['n1'] } } } },
    volumes: { assets: {} },
  } as ComposeFile;
}
const desired = (compose: ComposeFile, version: string) => buildDesiredState({ project: 'proj', version, revision: `rev-${version}`, compose, registry: '', defaultNode: 'n1' });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const projectDir = (ctx: AgentContext) => path.join(ctx.stateDir, 'projects', 'proj');

test('rolling service runs in its own revision project on a remapped port and the main project keeps only recreated services', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);

  assert.equal(status.health, 'serving', 'a healthy first revision reports serving');
  assert.equal(status.serviceStates?.web.port, 20000, 'the report names the revision host port so control can point the ingress at it');
  assert.ok(status.serviceStates?.web.rolloutRevision, 'the report identifies the serving revision');
  const main = yaml.load(await fs.readFile(path.join(projectDir(ctx), 'docker-compose.yml'), 'utf8')) as ComposeFile;
  assert.deepEqual(Object.keys(main.services), ['db'], 'the main project compose no longer contains the rolling service');
  const revision = revisionProject('proj', 'web', status.serviceStates!.web.rolloutRevision!);
  assert.deepEqual(host.running(revision), ['web@20000:web:1'], 'the revision project runs the service on the allocated port');
  const file = yaml.load(await fs.readFile(path.join(projectDir(ctx), 'rollout', `${revision}.yml`), 'utf8')) as ComposeFile;
  assert.deepEqual(file.services.web.ports, ['127.0.0.1:20000:80'], 'the declared host port is replaced by the allocated one and stays bound to the node bind address (loopback without an address)');
  assert.equal(file.services.web.depends_on, undefined, 'depends_on cannot point across Compose projects');
  assert.deepEqual(file.networks, { default: { name: 'proj_default', external: true } }, 'the revision joins the main project network');
  assert.deepEqual(file.volumes, { assets: { external: true, name: 'proj_assets' } }, 'named volumes keep using the main project volumes');
  assert.ok(host.networks.has('proj_default'), 'the shared network exists even when no recreated service created it');
  assert.deepEqual(host.volumes, ['proj_assets'], 'the shared volume is created if missing');
  assert.ok(host.calls.some(c => c.startsWith('compose -p proj up -d')), 'recreated services still go through the main project');
});

test('a new revision starts next to the old one, takes over and the old one is removed only after the drain', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const v1 = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const oldProject = revisionProject('proj', 'web', v1.serviceStates!.web.rolloutRevision!);

  const v2 = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  const newProject = revisionProject('proj', 'web', v2.serviceStates!.web.rolloutRevision!);
  assert.equal(v2.health, 'serving', 'the new revision passed its health check');
  assert.equal(v2.serviceStates?.web.port, 20001, 'the new revision gets the next free port, not the old one');
  assert.deepEqual(host.running(oldProject), ['web@20000:web:1'], 'the old revision is still running right after takeover');
  assert.deepEqual(host.running(newProject), ['web@20001:web:2'], 'the new revision is running');

  await sleep(60);
  const again = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  assert.deepEqual(host.running(oldProject), [], 'the old revision is removed once its drain has passed');
  assert.deepEqual(host.running(newProject), ['web@20001:web:2'], 'the new revision keeps running');
  assert.equal(again.serviceStates?.web.port, 20001, 'the report still names the new port');
  assert.equal((await loadRolloutState(projectDir(ctx))).services.web.draining.length, 0, 'the drained revision is forgotten');
  await assert.rejects(fs.stat(path.join(projectDir(ctx), 'rollout', `${oldProject}.yml`)), 'the old revision compose file is deleted');
});

test('a revision that fails its health check is removed and the old revision keeps serving untouched', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const v1 = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const oldProject = revisionProject('proj', 'web', v1.serviceStates!.web.rolloutRevision!);
  host.unhealthy.add('web:bad');

  const failed = await reconcile(desired(rolling('web:bad'), 'v2'), ctx);
  assert.equal(failed.health, 'failed', 'the node reports failed for the rejected revision');
  assert.match(failed.error ?? '', /web: .*503/, 'the error names the service and the health failure');
  assert.equal(failed.observedRevision, 'rev-v2', 'the failure is reported against the new desired revision');
  assert.equal(failed.serviceStates?.web.rolloutState, 'serving', 'the old revision is still reported serving so the ingress keeps its route');
  assert.equal(failed.serviceStates?.web.port, 20000, 'the old revision port stays in the report');
  assert.match(failed.serviceStates?.web.rolloutError ?? '', /503/, 'the rejection reason is visible in the service state');
  assert.deepEqual(host.running(oldProject), ['web@20000:web:1'], 'the old container was not touched');
  assert.equal([...host.containers.values()].filter(c => c.image === 'web:bad').length, 0, 'the failed candidate is removed');

  const upsBefore = host.calls.filter(c => c.includes(' up -d') && c.includes('-f')).length;
  const repeated = await reconcile(desired(rolling('web:bad'), 'v2'), ctx);
  assert.equal(repeated.health, 'failed', 'polling again keeps reporting the failure');
  assert.equal(host.calls.filter(c => c.includes(' up -d') && c.includes('-f')).length, upsBefore, 'a rejected revision is not retried on every poll');
  assert.equal(repeated.serviceStates?.web.port, 20000, 'the old revision is still the one serving');

  host.unhealthy.clear();
  const fixed = await reconcile(desired(rolling('web:good'), 'v3'), ctx);
  assert.equal(fixed.health, 'serving', 'a new deployment is attempted normally after a rejected one');
});

test('repeated reconciliation of the same desired state creates nothing new', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const first = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const ids = [...host.containers.keys()];
  const second = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const third = await reconcile(desired(rolling('web:1'), 'v1'), ctx);

  assert.deepEqual([...host.containers.keys()], ids, 'no container is created or recreated');
  assert.equal(third.serviceStates?.web.port, 20000, 'the port is stable');
  assert.equal(second.serviceStates?.web.rolloutRevision, first.serviceStates?.web.rolloutRevision, 'the revision identity is stable');
  assert.equal((await loadRolloutState(projectDir(ctx))).services.web.draining.length, 0, 'nothing drains');
});

test('a service whose definition did not change is not restarted when a sibling rolls', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const two = (webImage: string): ComposeFile => {
    const c = rolling(webImage);
    c.services.api = { ...webService('api:1'), ports: ['9090:80'], 'x-tug': { ...webService('api:1')['x-tug'], ingress: { host: 'api.test', port: 80, tls: 'off' } } } as ComposeFile['services'][string];
    return c;
  };
  const v1 = await reconcile(desired(two('web:1'), 'v1'), ctx);
  const apiContainer = [...host.containers.values()].find(c => c.service === 'api')!;
  const v2 = await reconcile(desired(two('web:2'), 'v2'), ctx);

  assert.notEqual(v2.serviceStates?.web.rolloutRevision, v1.serviceStates?.web.rolloutRevision, 'web changed');
  assert.equal(v2.serviceStates?.api.rolloutRevision, v1.serviceStates?.api.rolloutRevision, 'api keeps its revision');
  assert.equal(host.containers.get(apiContainer.id)?.image, 'api:1', 'the unchanged rolling service container is the very same one');
  assert.equal(v2.serviceStates?.api.port, v1.serviceStates?.api.port, 'the unchanged service keeps its port');
});

test('the port range is configurable and exhaustion rejects the rollout without touching the serving revision', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host, { rolloutPorts: '20100-20101' });
  const v1 = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(v1.serviceStates?.web.port, 20100, 'the first port of the configured range is used');
  const v2 = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  assert.equal(v2.serviceStates?.web.port, 20101, 'the second revision takes the other port');

  const v3 = await reconcile(desired(rolling('web:3'), 'v3'), ctx);
  assert.equal(v3.health, 'failed', 'with every port held by a serving or draining revision the rollout is rejected');
  assert.match(v3.error ?? '', /no free host port left in the rollout range 20100-20101/, 'the error explains the exhaustion and the setting');
  assert.equal(v3.serviceStates?.web.port, 20101, 'the serving revision keeps being reported');

  await sleep(60);
  const v4 = await reconcile(desired(rolling('web:4'), 'v4'), ctx);
  assert.equal(v4.health, 'serving', 'a later deployment succeeds once the drained revision released its port');
  assert.equal(v4.serviceStates?.web.port, 20100, 'the released port is reused');
  assert.throws(() => parsePortRange('nonsense'), /invalid rollout port range/, 'a malformed range is reported');
});

test('a host port taken by something else is skipped', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  host.busyPorts.add(20000);
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(status.serviceStates?.web.port, 20001, 'a bind conflict makes the agent retry with another port');
});

test('an agent restarted mid-rollout resumes the same candidate instead of starting another', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const v1 = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const v2 = desired(rolling('web:2'), 'v2');
  const full = composeForNode(v2, 'n1', { bind: { address: '127.0.0.1' } });
  const hash = serviceRevisionHash(v2, full.services.web, 'web');
  // The previous agent process had started the candidate and persisted it, then died before the takeover.
  const candidateProject = revisionProject('proj', 'web', hash);
  host.containers.set('crashed', { id: 'crashed', project: candidateProject, service: 'web', image: 'web:2', port: 20007, ip: '10.9.9.9' });
  const state = await loadRolloutState(projectDir(ctx));
  (state.services.web as unknown as Record<string, unknown>).candidate = { hash, project: candidateProject, port: 20007, image: 'web:2' };
  await fs.writeFile(path.join(projectDir(ctx), 'rollout.json'), JSON.stringify(state));

  const resumed = await reconcile(v2, ctx);
  assert.equal(resumed.health, 'serving', 'the recovered candidate is health-checked and takes over');
  assert.equal(resumed.serviceStates?.web.port, 20007, 'the persisted candidate port is reused');
  assert.deepEqual(host.running(candidateProject), ['web@20007:web:2'], 'there is still exactly one container for the candidate');
  const oldProject = revisionProject('proj', 'web', v1.serviceStates!.web.rolloutRevision!);
  assert.deepEqual(host.running(oldProject), ['web@20000:web:1'], 'the old revision is drained, not dropped');
  assert.equal((await loadRolloutState(projectDir(ctx))).services.web.draining.length, 1, 'the old revision is scheduled for removal');
});

test('a candidate left over from a superseded deployment is removed', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  host.containers.set('stale', { id: 'stale', project: 'proj-web-stale', service: 'web', image: 'web:old', port: 20009, ip: '10.9.9.8' });
  const state = await loadRolloutState(projectDir(ctx));
  (state.services.web as unknown as Record<string, unknown>).candidate = { hash: 'stale', project: 'proj-web-stale', port: 20009 };
  await fs.writeFile(path.join(projectDir(ctx), 'rollout.json'), JSON.stringify(state));
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(host.containers.has('stale'), false, 'a candidate for a different revision is cleaned up');
});

test('apply=false never touches docker and reports rolling services as serving', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host, { apply: false });
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.deepEqual(host.calls, [], 'no docker command is issued');
  assert.equal(status.health, 'serving', 'the dry-run node is healthy');
  assert.equal(status.serviceStates?.web.rolloutState, 'serving', 'the rolling service is reported serving');
  await assert.rejects(fs.stat(path.join(projectDir(ctx), 'rollout.json')), 'no rollout state is written');
});

test('a changed secret rolls the service that uses it', async () => {
  const host = fakeHost(); let version = 1;
  const ctx = await makeCtx(host, {}, () => ({ secrets: { API_KEY: `k${version}` }, versions: { API_KEY: version } }));
  const withSecret = (): ComposeFile => { const c = rolling('web:1'); c.services.web.environment = { API_KEY: '${API_KEY}' }; return c; };
  const first = await reconcile(desired(withSecret(), 'v1'), ctx);
  version = 2;
  const second = await reconcile(desired(withSecret(), 'v1'), ctx);

  assert.notEqual(second.serviceStates?.web.rolloutRevision, first.serviceStates?.web.rolloutRevision, 'the secret version is part of the revision');
  assert.equal(second.serviceStates?.web.port, 20001, 'the service moved to a new revision instead of being force-recreated');
  assert.ok(!host.calls.some(c => c.includes('--force-recreate')), 'rolling services are never force-recreated');
});

test('a failure in the recreated services does not withdraw the serving rolling revision', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  host.failMain('db exploded');
  const status = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  assert.equal(status.health, 'failed', 'the node reports the failure');
  assert.equal(status.serviceStates?.web.port, 20000, 'the untouched rolling revision keeps being reported');
  assert.equal([...host.containers.values()].some(c => c.image === 'web:2'), false, 'the rolling rollout was not started');
});

test('a service that was recreated before becoming rolling keeps serving until its replacement takes over', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  // Before: web ran in the main project on its declared host port.
  host.containers.set('legacy', { id: 'legacy', project: 'proj', service: 'web', image: 'web:0', port: 8080, ip: '10.8.8.8' });
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(status.serviceStates?.web.port, 20000, 'the first rolling revision is reported on its own port');
  assert.ok(host.calls.some(c => c === 'compose -p proj up -d'), 'orphans are not removed while the old main-project container still serves');
  assert.ok(!host.calls.some(c => c.includes('--remove-orphans')), 'the old container is not removed as an orphan');
  assert.ok(host.containers.has('legacy'), 'the legacy container still runs right after the takeover');

  await sleep(60);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(host.containers.has('legacy'), false, 'the legacy container is removed after the drain');
});

test('a service that stops being rolling is drained and handed back to the main project', async () => {
  const host = fakeHost(); const ctx = await makeCtx(host);
  const v1 = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const project = revisionProject('proj', 'web', v1.serviceStates!.web.rolloutRevision!);
  const recreated = rolling('web:2');
  delete (recreated.services.web['x-tug'] as Record<string, unknown>).rollout;
  const status = await reconcile(desired(recreated, 'v2'), ctx);
  assert.equal(status.serviceStates?.web.port, undefined, 'the service is reported without a rolling port again');
  assert.deepEqual(host.running(project), ['web@20000:web:1'], 'the rolling revision still runs during the switch');
  assert.equal((await loadRolloutState(projectDir(ctx))).services.web.draining.length, 1, 'it is scheduled for removal');
});

test('rolling compose rewriting helpers', () => {
  assert.deepEqual(remapPublishedPort(['8080:80'], 20001), ['20001:80'], 'short syntax');
  assert.deepEqual(remapPublishedPort(['127.0.0.1:8080:80/tcp'], 20001), ['127.0.0.1:20001:80/tcp'], 'bind address and protocol are preserved');
  assert.deepEqual(remapPublishedPort([{ target: 80, published: 8080 }], 20001), [{ target: 80, published: 20001 }], 'long syntax');
  assert.equal(revisionProject('My.Proj', 'web_1', 'abcdef0123456789'), 'my-proj-web_1-abcdef01', 'project names are valid Compose project names');
  const full: ComposeFile = { services: { web: { image: 'x', ports: ['8080:80'], volumes: ['data:/d', './bind:/b'], depends_on: { db: { condition: 'service_healthy' } } } }, volumes: { data: { driver: 'local' } } };
  const out = rollingCompose(full, 'p', 'web', null);
  assert.deepEqual(out.services.web.ports, ['8080:80'], 'a null port leaves ports as rendered (used for hashing)');
  assert.deepEqual(out.volumes, { data: { driver: 'local', external: true, name: 'p_data' } }, 'only named volumes in use are carried, as external');
});
