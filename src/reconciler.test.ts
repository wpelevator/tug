import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcile } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState } from './compose.ts';
import { containerSpecs, withHostPort } from './container-spec.ts';
import { loadRolloutState, parsePortRange } from './reconciler.ts';
import type { ComposeFile, SecretsResponse } from './protocol.ts';
import type { HttpClient } from './runners.ts';
import { FakeDocker, normalized } from '../tests/fake-docker.ts';

/** A host where containers whose image is in `unhealthy` fail their HTTP health check. */
function fakeHost() {
  const docker = new FakeDocker();
  const unhealthy = new Set<string>();
  const http = (async (url: string | URL | Request) => {
    const ip = new URL(String(url)).hostname;
    const c = [...docker.containers.values()].find((candidate) => candidate.ip === ip);
    return new Response('', { status: c && !unhealthy.has(c.body.Image) ? 200 : 503 });
  }) as HttpClient;
  return { docker, http, unhealthy };
}
type Host = ReturnType<typeof fakeHost>;

function fakeControl(
  http: HttpClient,
  secrets: () => SecretsResponse = () => ({ secrets: {}, versions: {} }),
): HttpClient {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/agent/v1/secrets')) return Response.json(secrets());
    if (u.includes('/agent/v1/events')) return Response.json({ ok: true });
    if (u.startsWith('http://control.test')) return Response.json({});
    return http(url, init);
  }) as HttpClient;
}

async function makeCtx(
  host: Host,
  overrides: Partial<AgentContext> = {},
  secrets?: () => SecretsResponse,
): Promise<AgentContext> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-rollout-unit-'));
  return {
    docker: host.docker,
    http: fakeControl(host.http, secrets),
    nodeName: 'n1',
    stateDir,
    apply: true,
    controlUrl: 'http://control.test',
    token: 'tok',
    ...overrides,
  };
}

const health = { type: 'http' as const, port: 80, path: '/', retries: 1, interval: '1ms' };
function webService(image: string, extra: Record<string, unknown> = {}) {
  return {
    image,
    ports: ['8080:80'],
    depends_on: ['db'],
    volumes: ['assets:/srv/assets'],
    'x-tug': {
      placement: { nodes: ['n1'] },
      health,
      ingress: { host: 'app.test', port: 80, tls: 'off' },
      rollout: { strategy: 'rolling', drain: '40ms' },
      ...extra,
    },
  };
}
function rolling(image: string, extra: Record<string, unknown> = {}): ComposeFile {
  return {
    services: {
      web: webService(image, extra),
      db: { image: 'postgres', 'x-tug': { placement: { nodes: ['n1'] } } },
    },
    volumes: { assets: {} },
  } as ComposeFile;
}
const desired = (compose: ComposeFile, version: string) =>
  buildDesiredState({
    project: 'proj',
    version,
    revision: `rev-${version}`,
    compose: normalized(compose),
    registry: '',
    defaultNode: 'n1',
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const projectDir = (ctx: AgentContext) => path.join(ctx.stateDir, 'projects', 'proj');
/** Running containers of a service as `port:image`, oldest first. */
const running = (host: Host, service: string) =>
  host.docker
    .service('proj', service)
    .filter((c) => c.state === 'running')
    .map((c) => {
      const bindings = c.body.HostConfig?.PortBindings as
        Record<string, { HostPort: string }[]> | undefined;
      const port = Object.values(bindings || {})[0]?.[0]?.HostPort;
      return `${port ? `${port}:` : ''}${c.body.Image}`;
    });

test('a rolling service runs on an allocated host port beside the recreated services', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);

  assert.equal(status.health, 'serving', 'a healthy first revision reports serving');
  assert.equal(
    status.serviceStates?.web.port,
    20000,
    'the report names the revision host port so control can point the ingress at it',
  );
  assert.ok(
    status.serviceStates?.web.rolloutRevision,
    'the report identifies the serving revision',
  );
  assert.deepEqual(running(host, 'web'), ['20000:web:1'], 'the service runs on the allocated port');
  assert.equal(
    (
      host.docker.service('proj', 'web')[0].body.HostConfig?.PortBindings as Record<
        string,
        { HostIp: string }[]
      >
    )['80/tcp'][0].HostIp,
    '127.0.0.1',
    'the allocated port stays bound to the node bind address (loopback without an address)',
  );
  assert.deepEqual(running(host, 'db'), ['postgres'], 'the recreated service runs as usual');
  assert.ok(host.docker.networks.has('tug_proj'), 'both strategies share the project network');
  assert.ok(
    host.docker.volumes.has('tug_proj_assets'),
    'the named volume is created once under its Tug name',
  );
});

test('a new revision starts next to the old one, takes over and the old one is removed only after the drain', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);

  const v2 = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  assert.equal(v2.health, 'serving', 'the new revision passed its health check');
  assert.equal(v2.serviceStates?.web.port, 20001, 'the new revision gets the next free port');
  assert.deepEqual(
    running(host, 'web'),
    ['20000:web:1', '20001:web:2'],
    'the old revision is still running right after takeover',
  );

  await sleep(60);
  const again = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  assert.deepEqual(
    running(host, 'web'),
    ['20001:web:2'],
    'the old revision is removed once its drain has passed',
  );
  assert.equal(again.serviceStates?.web.port, 20001, 'the report still names the new port');
  assert.equal(
    (await loadRolloutState(projectDir(ctx))).services.web.draining.length,
    0,
    'the drained revision is forgotten',
  );
});

test('a revision that fails its health check is removed and the old revision keeps serving untouched', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const oldId = host.docker.service('proj', 'web')[0].id;
  host.unhealthy.add('web:bad');

  const failed = await reconcile(desired(rolling('web:bad'), 'v2'), ctx);
  assert.equal(failed.health, 'failed', 'the node reports failed for the rejected revision');
  assert.match(
    failed.error ?? '',
    /web: .*503/,
    'the error names the service and the health failure',
  );
  assert.equal(
    failed.observedRevision,
    'rev-v2',
    'the failure is reported against the new desired revision',
  );
  assert.equal(
    failed.serviceStates?.web.rolloutState,
    'serving',
    'the old revision is still reported serving so the ingress keeps its route',
  );
  assert.equal(failed.serviceStates?.web.port, 20000, 'the old revision port stays in the report');
  assert.match(
    failed.serviceStates?.web.rolloutError ?? '',
    /503/,
    'the rejection reason is visible in the service state',
  );
  assert.deepEqual(running(host, 'web'), ['20000:web:1'], 'only the old revision is left');
  assert.equal(
    host.docker.service('proj', 'web')[0].id,
    oldId,
    'the old container was not touched',
  );

  const createsBefore = host.docker.verbs('create').length;
  const repeated = await reconcile(desired(rolling('web:bad'), 'v2'), ctx);
  assert.equal(repeated.health, 'failed', 'polling again keeps reporting the failure');
  assert.equal(
    host.docker.verbs('create').length,
    createsBefore,
    'a rejected revision is not retried on every poll',
  );
  assert.equal(
    repeated.serviceStates?.web.port,
    20000,
    'the old revision is still the one serving',
  );

  host.unhealthy.clear();
  const fixed = await reconcile(desired(rolling('web:good'), 'v3'), ctx);
  assert.equal(
    fixed.health,
    'serving',
    'a new deployment is attempted normally after a rejected one',
  );
});

test('repeated reconciliation of the same desired state creates nothing new', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  const first = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const ids = [...host.docker.containers.keys()];
  host.docker.calls.length = 0;
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const third = await reconcile(desired(rolling('web:1'), 'v1'), ctx);

  assert.deepEqual([...host.docker.containers.keys()], ids, 'no container is created or recreated');
  assert.deepEqual([...host.docker.calls], [], 'steady state issues no mutating call');
  assert.equal(third.serviceStates?.web.port, 20000, 'the port is stable');
  assert.equal(
    third.serviceStates?.web.rolloutRevision,
    first.serviceStates?.web.rolloutRevision,
    'the revision identity is stable',
  );
});

test('a service whose definition did not change is not restarted when a sibling rolls', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  const two = (webImage: string): ComposeFile => {
    const c = rolling(webImage);
    c.services.api = {
      ...webService('api:1'),
      ports: ['9090:80'],
      'x-tug': {
        ...webService('api:1')['x-tug'],
        ingress: { host: 'api.test', port: 80, tls: 'off' },
      },
    } as ComposeFile['services'][string];
    return c;
  };
  const v1 = await reconcile(desired(two('web:1'), 'v1'), ctx);
  const apiId = host.docker.service('proj', 'api')[0].id;
  const v2 = await reconcile(desired(two('web:2'), 'v2'), ctx);

  assert.notEqual(
    v2.serviceStates?.web.rolloutRevision,
    v1.serviceStates?.web.rolloutRevision,
    'web changed',
  );
  assert.equal(
    v2.serviceStates?.api.rolloutRevision,
    v1.serviceStates?.api.rolloutRevision,
    'api keeps its revision',
  );
  assert.equal(
    host.docker.service('proj', 'api')[0].id,
    apiId,
    'the unchanged service keeps its container',
  );
  assert.equal(
    v2.serviceStates?.api.port,
    v1.serviceStates?.api.port,
    'the unchanged service keeps its port',
  );
});

test('the port range is configurable and exhaustion rejects the rollout without touching the serving revision', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host, { rolloutPorts: '20100-20101' });
  const v1 = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(v1.serviceStates?.web.port, 20100, 'the first port of the configured range is used');
  const v2 = await reconcile(desired(rolling('web:2'), 'v2'), ctx);
  assert.equal(v2.serviceStates?.web.port, 20101, 'the second revision takes the other port');

  const v3 = await reconcile(desired(rolling('web:3'), 'v3'), ctx);
  assert.equal(
    v3.health,
    'failed',
    'with every port held by a serving or draining revision the rollout is rejected',
  );
  assert.match(
    v3.error ?? '',
    /no free host port left in the rollout range 20100-20101/,
    'the error explains the exhaustion and the setting',
  );
  assert.equal(v3.serviceStates?.web.port, 20101, 'the serving revision keeps being reported');

  await sleep(60);
  const v4 = await reconcile(desired(rolling('web:4'), 'v4'), ctx);
  assert.equal(
    v4.health,
    'serving',
    'a later deployment succeeds once the drained revision released its port',
  );
  assert.equal(v4.serviceStates?.web.port, 20100, 'the released port is reused');
  assert.throws(
    () => parsePortRange('nonsense'),
    /invalid rollout port range/,
    'a malformed range is reported',
  );
});

test('a host port taken by something else is skipped', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  // A foreign container publishes 20000 in a way the port scan does not see, so only the bind conflict reveals it.
  host.docker.addImage('other');
  const foreign = await host.docker.createContainer('foreign', {
    Image: 'other',
    HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '20000' }] } },
  });
  await host.docker.startContainer(foreign);
  const list = host.docker.listContainers.bind(host.docker);
  host.docker.listContainers = async (filter, all) =>
    (await list(filter, all)).map((c) => (c.Names[0] === '/foreign' ? { ...c, Ports: [] } : c));
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(
    status.serviceStates?.web.port,
    20001,
    'a bind conflict makes the agent retry with another port',
  );
  assert.equal(
    host.docker.service('proj', 'web').length,
    1,
    'the container that failed to bind was removed',
  );
});

test('an agent restarted mid-rollout resumes the same candidate instead of starting another', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const v2 = desired(rolling('web:2'), 'v2');
  const spec = containerSpecs(v2, 'n1', { bind: { address: '127.0.0.1' } }).specs.web;
  // The previous agent process had started the candidate and persisted it, then died before the takeover.
  host.docker.addImage('web:2');
  const id = await host.docker.createContainer(spec.name, withHostPort(spec.body, 20007));
  await host.docker.startContainer(id);
  const state = await loadRolloutState(projectDir(ctx));
  (state.services.web as unknown as Record<string, unknown>).candidate = {
    hash: spec.hash,
    container: spec.name,
    port: 20007,
    image: 'web:2',
  };
  await fs.writeFile(path.join(projectDir(ctx), 'rollout.json'), JSON.stringify(state));

  const resumed = await reconcile(v2, ctx);
  assert.equal(
    resumed.health,
    'serving',
    'the recovered candidate is health-checked and takes over',
  );
  assert.equal(resumed.serviceStates?.web.port, 20007, 'the persisted candidate port is reused');
  assert.deepEqual(
    running(host, 'web'),
    ['20000:web:1', '20007:web:2'],
    'the old revision is drained, not dropped, and the candidate exists once',
  );
  assert.equal(
    (await loadRolloutState(projectDir(ctx))).services.web.draining.length,
    1,
    'the old revision is scheduled for removal',
  );
});

test('a candidate left over from a superseded deployment is removed', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  host.docker.addImage('web:old');
  const stale = await host.docker.createContainer('tug-proj-web-stale', {
    Image: 'web:old',
    Labels: { 'tug.project': 'proj', 'tug.service': 'web', 'tug.config-hash': 'stale' },
  });
  await host.docker.startContainer(stale);
  const state = await loadRolloutState(projectDir(ctx));
  (state.services.web as unknown as Record<string, unknown>).candidate = {
    hash: 'stale',
    container: 'tug-proj-web-stale',
    port: 20009,
  };
  await fs.writeFile(path.join(projectDir(ctx), 'rollout.json'), JSON.stringify(state));
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(
    host.docker.byName('tug-proj-web-stale'),
    undefined,
    'a candidate for a different revision is cleaned up',
  );
});

test('apply=false never touches docker and reports rolling services as serving', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host, { apply: false });
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.deepEqual([...host.docker.calls], [], 'no docker call is issued');
  assert.equal(status.health, 'serving', 'the dry-run node is healthy');
  assert.equal(
    status.serviceStates?.web.rolloutState,
    'serving',
    'the rolling service is reported serving',
  );
  await assert.rejects(
    fs.stat(path.join(projectDir(ctx), 'rollout.json')),
    'no rollout state is written',
  );
});

test('a changed secret rolls the service that uses it', async () => {
  const host = fakeHost();
  let version = 1;
  const ctx = await makeCtx(host, {}, () => ({
    secrets: { API_KEY: `k${version}` },
    versions: { API_KEY: version },
  }));
  const withSecret = (): ComposeFile => {
    const c = rolling('web:1');
    c.services.web.environment = { API_KEY: '@@tug:secret:API_KEY@@' };
    return c;
  };
  const first = await reconcile(desired(withSecret(), 'v1'), ctx);
  version = 2;
  const second = await reconcile(desired(withSecret(), 'v1'), ctx);

  assert.notEqual(
    second.serviceStates?.web.rolloutRevision,
    first.serviceStates?.web.rolloutRevision,
    'the secret version is part of the revision',
  );
  assert.equal(
    second.serviceStates?.web.port,
    20001,
    'the service moved to a new revision instead of being recreated in place',
  );
  assert.deepEqual(
    host.docker.service('proj', 'web').map((c) => c.body.Env),
    [['API_KEY=k1'], ['API_KEY=k2']],
    'both revisions run side by side with their own secret value until the drain ends',
  );
});

test('a failure in the recreated services does not withdraw the serving rolling revision', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  host.docker.failCreate = (name) => (name.includes('-db-') ? new Error('db exploded') : undefined);
  const status = await reconcile(
    desired(
      {
        ...rolling('web:2'),
        services: {
          ...rolling('web:2').services,
          db: { image: 'postgres:2', 'x-tug': { placement: { nodes: ['n1'] } } },
        },
      },
      'v2',
    ),
    ctx,
  );
  assert.equal(status.health, 'failed', 'the node reports the failure');
  assert.equal(
    status.serviceStates?.web.port,
    20000,
    'the untouched rolling revision keeps being reported',
  );
  assert.deepEqual(running(host, 'web'), ['20000:web:1'], 'the rolling rollout was not started');
});

test('a running container that predates the rollout state is adopted and replaced when its definition differs', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  // Before: web ran as a recreated service on its declared host port.
  host.docker.addImage('web:0');
  const legacy = await host.docker.createContainer('tug-proj-web-legacy', {
    Image: 'web:0',
    Labels: { 'tug.project': 'proj', 'tug.service': 'web', 'tug.config-hash': 'legacy' },
    HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] } },
  });
  await host.docker.startContainer(legacy);
  const status = await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(
    status.serviceStates?.web.port,
    20000,
    'the first rolling revision is reported on its own port',
  );
  assert.ok(
    host.docker.byName('tug-proj-web-legacy'),
    'the old container still runs right after the takeover',
  );

  await sleep(60);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  assert.equal(
    host.docker.byName('tug-proj-web-legacy'),
    undefined,
    'the old container is removed after the drain',
  );
});

test('a service that stops being rolling is replaced in place by the recreate path', async () => {
  const host = fakeHost();
  const ctx = await makeCtx(host);
  await reconcile(desired(rolling('web:1'), 'v1'), ctx);
  const recreated = rolling('web:2');
  delete (recreated.services.web['x-tug'] as Record<string, unknown>).rollout;
  const status = await reconcile(desired(recreated, 'v2'), ctx);
  assert.equal(
    status.serviceStates?.web.port,
    undefined,
    'the service is reported without a rolling port again',
  );
  assert.deepEqual(
    running(host, 'web'),
    ['8080:web:2'],
    'a single container runs on the declared port',
  );
  assert.deepEqual(
    (await loadRolloutState(projectDir(ctx))).services,
    {},
    'the rolling state is forgotten',
  );
});

test('withHostPort replaces the host side of every binding and keeps the bind address', () => {
  const body = withHostPort(
    {
      Image: 'x',
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '10.0.0.2', HostPort: '8080' }] } },
    },
    20001,
  );
  assert.deepEqual(body.HostConfig?.PortBindings, {
    '80/tcp': [{ HostIp: '10.0.0.2', HostPort: '20001' }],
  });
});
