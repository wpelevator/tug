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
import { DockerError } from './docker-api.ts';
import type { ComposeFile, HealthCheck, SecretsResponse } from './protocol.ts';
import type { HttpClient } from './runners.ts';
import { FakeDocker, normalized } from '../tests/fake-docker.ts';

interface FakeControl {
  http: HttpClient;
  events: { type: string; level?: string; message?: string; metadata: { service: string } }[];
  requests: string[];
}
function fakeControl(secrets: () => SecretsResponse): FakeControl {
  const events: FakeControl['events'] = [];
  const requests: string[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    requests.push(u);
    if (u.includes('/agent/v1/secrets')) return Response.json(secrets());
    if (u.includes('/agent/v1/events')) {
      events.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return Response.json({});
  }) as HttpClient;
  return { http, events, requests };
}

async function makeCtx(overrides: Partial<AgentContext> = {}): Promise<AgentContext> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-unit-'));
  return {
    docker: new FakeDocker(),
    http: fakeControl(() => ({ secrets: {}, versions: {} })).http,
    nodeName: 'n1',
    stateDir,
    apply: true,
    controlUrl: 'http://control.test',
    token: 'tok',
    ...overrides,
  };
}
const fake = (ctx: AgentContext) => ctx.docker as FakeDocker;

const place = { 'x-tug': { placement: { nodes: ['n1'] } } };
function desired(compose: ComposeFile, version = 'v1', project = 'proj') {
  return buildDesiredState({
    project,
    version,
    compose: normalized(compose),
    registry: 'reg.test',
    defaultNode: 'n1',
  });
}
const sentinel = (name: string) => `@@tug:secret:${name}@@`;
const twoServices: ComposeFile = {
  services: {
    web: { image: 'nginx', environment: { API_KEY: sentinel('API_KEY') }, ...place },
    worker: { image: 'busybox', environment: { STATIC: 'x' }, ...place },
  },
};

test('reconcile creates the network, then pulls, creates and starts each service and reports serving', async () => {
  const control = fakeControl(() => ({ secrets: {}, versions: {} }));
  const ctx = await makeCtx({ http: control.http });
  const status = await reconcile(desired(twoServices), ctx);
  const d = fake(ctx);

  assert.deepEqual(
    d.calls.map((c) => c.replace(/-[0-9a-f]{8}$/, '')),
    [
      'network tug_proj',
      'pull nginx',
      'pull busybox',
      'create tug-proj-web',
      'start tug-proj-web',
      'create tug-proj-worker',
      'start tug-proj-worker',
    ],
    'the project network comes first, images are pulled for a new revision, then containers start',
  );
  assert.equal(status.health, 'serving');
  assert.deepEqual(status.services, ['web', 'worker']);
  assert.equal(status.serviceStates?.web.rolloutState, 'serving');
  assert.ok(status.serviceStates?.web.healthyAt);
  assert.deepEqual(
    control.events.map((e) => `${e.type}:${e.metadata.service}`),
    [
      'service.pulling:web',
      'service.pulling:worker',
      'service.starting:web',
      'service.starting:worker',
      'service.health_checking:web',
      'service.serving:web',
      'service.health_checking:worker',
      'service.serving:worker',
    ],
  );
  const web = d.service('proj', 'web')[0];
  assert.equal(web.body.Labels?.['tug.project'], 'proj');
  assert.equal(
    web.body.Labels?.['tug.config-hash']?.length,
    16,
    'containers carry their config hash',
  );
  assert.deepEqual(web.body.NetworkingConfig?.EndpointsConfig, {
    tug_proj: { Aliases: ['web'] },
  });
  assert.deepEqual(
    await fs.readdir(path.join(ctx.stateDir, 'projects', 'proj')),
    [],
    'no docker-compose.yml or .env is written to disk',
  );
});

test('secrets are substituted into the container environment and never written to disk', async () => {
  const control = fakeControl(() => ({
    secrets: { API_KEY: 'line1\nline2' },
    versions: { API_KEY: 1 },
  }));
  const ctx = await makeCtx({ http: control.http });
  await reconcile(desired(twoServices), ctx);
  const web = fake(ctx).service('proj', 'web')[0];
  assert.deepEqual(
    web.body.Env,
    ['API_KEY=line1\nline2'],
    'the sentinel is replaced by the released value',
  );
  assert.ok(
    !JSON.stringify(web.body.Labels).includes('line1'),
    'the secret value is not copied into labels',
  );
  assert.deepEqual(await fs.readdir(path.join(ctx.stateDir, 'projects', 'proj')), []);
});

test('registry images are pulled once per desired version, not on every poll', async () => {
  const ctx = await makeCtx();
  const d = fake(ctx);
  await reconcile(desired(twoServices), ctx);
  assert.ok(d.verbs('pull').length === 2, 'the first apply of a version pulls its images');

  d.calls.length = 0;
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual(
    d.verbs('pull'),
    [],
    'reapplying the same version must not pull, so a tag that moved upstream is not deployed without a deploy',
  );
  assert.deepEqual(d.verbs('create'), [], 'an unchanged project creates nothing');

  d.calls.length = 0;
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.equal(d.verbs('pull').length, 2, 'a new desired version pulls again');
  assert.deepEqual(d.verbs('create'), [], 'but identical definitions keep their containers');
});

test('a failed apply pulls again on the retry', async () => {
  const ctx = await makeCtx();
  const d = fake(ctx);
  d.failStart = () => new Error('start failed');
  await assert.rejects(reconcile(desired(twoServices), ctx), /start failed/);

  d.calls.length = 0;
  d.failStart = undefined;
  await reconcile(desired(twoServices), ctx);
  assert.equal(
    d.verbs('pull').length,
    2,
    'a version that never applied successfully must be pulled again on retry',
  );
});

test('reconcile skips projects with no services for this node and removes leftovers', async () => {
  const ctx = await makeCtx({ nodeName: 'elsewhere' });
  const status = await reconcile(desired(twoServices), ctx);
  assert.equal(status.health, 'skipped');
  assert.deepEqual([...fake(ctx).calls], []);

  const d = fake(ctx);
  d.addImage('nginx');
  await d.createContainer('tug-proj-web-old', {
    Image: 'nginx',
    Labels: { 'tug.project': 'proj', 'tug.service': 'web' },
  });
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual(d.names(), [], 'containers of a project that no longer runs here are removed');
});

test('reconcile with apply=false never touches docker', async () => {
  const ctx = await makeCtx({ apply: false });
  const status = await reconcile(desired(twoServices), ctx);
  assert.deepEqual([...fake(ctx).calls], []);
  assert.equal(status.serviceStates?.web.rolloutState, 'serving');
});

test('a changed secret recreates only the services that reference it, without pulling', async () => {
  let versions: Record<string, number> = { API_KEY: 1 };
  const control = fakeControl(() => ({ secrets: { API_KEY: 'k' }, versions }));
  const ctx = await makeCtx({ http: control.http });
  const d = fake(ctx);

  await reconcile(desired(twoServices), ctx);
  const [workerBefore] = d.service('proj', 'worker');
  const [webBefore] = d.service('proj', 'web');

  d.calls.length = 0;
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual([...d.calls], [], 'unchanged secrets change nothing');

  versions = { API_KEY: 2 };
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual(
    d.calls.map((c) => c.replace(/-[0-9a-f]{8}$/, '')),
    ['stop tug-proj-web', 'rm tug-proj-web', 'create tug-proj-web', 'start tug-proj-web'],
    'a secret change on the same version replaces the service that uses it and nothing else',
  );
  assert.equal(d.service('proj', 'worker')[0].id, workerBefore.id, 'the sibling keeps running');
  assert.notEqual(d.service('proj', 'web')[0].id, webBefore.id);
  assert.deepEqual(d.verbs('pull'), [], 'no pull happens for a secret change');
});

test('reconcile sends the bearer token to control and fails without one', async () => {
  const seen: (string | null)[] = [];
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ secrets: {}, versions: {} });
  }) as HttpClient;
  const ctx = await makeCtx({ http, apply: false });
  await reconcile(desired(twoServices), ctx);
  assert.ok(seen.length > 0 && seen.every((h) => h === 'Bearer tok'));
  await assert.rejects(
    reconcile(desired(twoServices, 'v2'), { ...ctx, token: undefined }),
    /TUG_AGENT_TOKEN required/,
  );
});

test('a container that is not running is started again on the next poll', async () => {
  const ctx = await makeCtx();
  const d = fake(ctx);
  await reconcile(desired(twoServices), ctx);
  const web = d.service('proj', 'web')[0];
  web.state = 'exited';
  d.calls.length = 0;
  await reconcile(desired(twoServices), ctx);
  assert.deepEqual(
    d.calls,
    [`start ${web.name}`],
    'the stopped container is started, not recreated',
  );
});

test('services are started in depends_on order and wait for a healthy dependency', async () => {
  const ctx = await makeCtx();
  const d = fake(ctx);
  const compose: ComposeFile = {
    services: {
      app: {
        image: 'app',
        depends_on: { db: { condition: 'service_healthy', required: true } },
        ...place,
      },
      db: { image: 'postgres', ...place },
    },
  };
  d.addImage('app');
  d.addImage('postgres');
  // db has a Docker HEALTHCHECK that reports healthy once it is created.
  const create = d.createContainer.bind(d);
  d.createContainer = async (name, body) => {
    const id = await create(name, body);
    if (name.includes('-db-')) d.containers.get(id)!.health = 'healthy';
    return id;
  };
  await reconcile(desired(compose), ctx);
  const starts = d.verbs('start').map((c) => c.replace(/-[0-9a-f]{8}$/, ''));
  assert.deepEqual(starts, ['start tug-proj-db', 'start tug-proj-app'], 'dependencies start first');

  const stuck = await makeCtx();
  const sd = fake(stuck);
  sd.addImage('app');
  sd.addImage('postgres');
  const sCreate = sd.createContainer.bind(sd);
  sd.createContainer = async (name, body) => {
    const id = await sCreate(name, body);
    if (name.includes('-db-')) sd.containers.get(id)!.health = 'starting';
    return id;
  };
  await assert.rejects(
    reconcile(
      desired({
        services: {
          ...compose.services,
          db: {
            image: 'postgres',
            ...place,
            'x-tug': { ...place['x-tug'], health: { type: 'docker', interval: '1ms', retries: 2 } },
          },
        },
      }),
      stuck,
    ),
    /docker health starting/,
    'a dependent service does not start before service_healthy is satisfied',
  );
  assert.ok(
    !sd.names().some((n) => n.includes('-app-')),
    'the dependent container was never created',
  );
});

test('a depends_on cycle fails the apply with the cycle named', async () => {
  const ctx = await makeCtx();
  await assert.rejects(
    reconcile(
      desired({
        services: {
          a: { image: 'a', depends_on: ['b'], ...place },
          b: { image: 'b', depends_on: ['a'], ...place },
        },
      }),
      ctx,
    ),
    /depends_on cycle: a -> b -> a/,
  );
});

const fastRetry = { interval: '1ms', retries: 3 } as const;

async function withContainer(
  ctx: AgentContext,
  options: { health?: string; ip?: string; state?: 'running' | 'exited' } = {},
) {
  const d = fake(ctx);
  d.addImage('nginx');
  const id = await d.createContainer('web', {
    Image: 'nginx',
    NetworkingConfig: { EndpointsConfig: { tug_proj: {} } },
  });
  const c = d.containers.get(id)!;
  c.state = options.state ?? 'running';
  c.health = options.health;
  if (options.ip) c.ip = options.ip;
  return { id, c };
}

test('docker health: passes when running and healthy, retries then fails otherwise', async () => {
  const ctx = await makeCtx();
  const { c } = await withContainer(ctx, { health: 'healthy' });
  const health: HealthCheck = { type: 'docker', ...fastRetry };
  await waitForHealth(ctx, 'proj', 'web', 'web', health);

  c.state = 'exited';
  await assert.rejects(waitForHealth(ctx, 'proj', 'web', 'web', health), /web: not running/);

  c.state = 'running';
  c.health = 'starting';
  await assert.rejects(waitForHealth(ctx, 'proj', 'web', 'web', health), /docker health starting/);
});

test('docker health: recovers when the container becomes healthy on a later attempt', async () => {
  const ctx = await makeCtx();
  const { c } = await withContainer(ctx, { health: 'starting' });
  const d = fake(ctx);
  const inspect = d.inspectContainer.bind(d);
  let n = 0;
  d.inspectContainer = async (id) => {
    if (++n >= 3) c.health = 'healthy';
    return inspect(id);
  };
  await waitForHealth(ctx, 'proj', 'web', 'web', { type: 'docker', interval: '1ms', retries: 5 });
  assert.equal(n, 3);
});

test('http health: follows the container IP and honours the status code', async () => {
  const urls: string[] = [];
  let status = 200;
  const http = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response('x', { status });
  }) as HttpClient;
  const ctx = await makeCtx({ http });
  await withContainer(ctx, { ip: '10.1.2.3' });
  const health: HealthCheck = { type: 'http', port: 8080, path: '/up', ...fastRetry };
  await waitForHealth(ctx, 'proj', 'web', 'web', health);
  assert.deepEqual(urls, ['http://10.1.2.3:8080/up']);

  status = 503;
  urls.length = 0;
  await assert.rejects(waitForHealth(ctx, 'proj', 'web', 'web', health), /web: http 503/);
  assert.equal(urls.length, 3);

  urls.length = 0;
  await waitForHealth(ctx, 'proj', 'web', 'web', { type: 'http', interval: '1ms' }).catch(() => {});
  assert.equal(urls[0], 'http://10.1.2.3:80/', 'defaults to port 80 and path /');
});

test('a failed http health check names the check, the attempts and the network error behind "fetch failed"', async () => {
  const refused = (async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:8081'), {
        code: 'ECONNREFUSED',
      }),
    });
  }) as HttpClient;
  const ctx = await makeCtx({ http: refused });
  await withContainer(ctx, { ip: '10.1.2.3' });
  await assert.rejects(
    waitForHealth(ctx, 'proj', 'web', 'web', { type: 'http', port: 8081, path: '/', ...fastRetry }),
    /web: http health check on port 8081\/ failed after 3 attempts: fetch failed \(ECONNREFUSED\)/,
    'an operator reading a rejected rollout must see which check failed and why, not just "fetch failed"',
  );
});

const oneService: ComposeFile = {
  services: {
    web: {
      image: 'nginx',
      'x-tug': {
        placement: { nodes: ['n1'] },
        health: { type: 'docker', interval: '1ms', retries: 2 },
      },
    },
  },
};

test('polling an unchanged project adds no lifecycle events, but still applies and checks it', async () => {
  const control = fakeControl(() => ({ secrets: {}, versions: {} }));
  const ctx = await makeCtx({ http: control.http });
  await reconcile(desired(twoServices), ctx);
  const first = control.events.length;
  assert.equal(first, 8, 'the first apply announces every step for both services');
  for (let i = 0; i < 3; i++) await reconcile(desired(twoServices), { ...ctx });
  assert.equal(
    control.events.length,
    first,
    'three more polls of the same revision, including after an agent restart, must not add events',
  );

  const d = fake(ctx);
  d.containers.get(d.service('proj', 'web')[0].id)!.state = 'exited';
  await reconcile(desired(twoServices), ctx);
  assert.equal(d.running().length, 2, 'every poll still applies the project, so drift is repaired');
});

test('a new revision or changed secrets announce themselves again, and the same inputs are quiet afterwards', async () => {
  let versions: Record<string, number> = { API_KEY: 1 };
  const control = fakeControl(() => ({ secrets: { API_KEY: 'k' }, versions }));
  const ctx = await makeCtx({ http: control.http });
  await reconcile(desired(twoServices, 'v1'), ctx);
  let seen = control.events.length;
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.equal(
    control.events.slice(seen).filter((e) => e.type === 'service.serving').length,
    2,
    'a new version announces serving for both services',
  );
  seen = control.events.length;
  versions = { API_KEY: 2 };
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.ok(
    control.events
      .slice(seen)
      .some((e) => e.type === 'service.starting' && e.metadata.service === 'web'),
    'a changed secret is announced for the service that uses it',
  );
  seen = control.events.length;
  await reconcile(desired(twoServices, 'v2'), ctx);
  assert.equal(control.events.length, seen, 'the same inputs again are quiet');
});

test('a failing apply is announced once, retries stay quiet, and recovery is announced once', async () => {
  const control = fakeControl(() => ({ secrets: {}, versions: {} }));
  const ctx = await makeCtx({ http: control.http });
  const d = fake(ctx);
  const project = desired(oneService);

  d.startsAs = 'exited';
  await assert.rejects(reconcile(project, ctx), /not running/);
  const failed = control.events.filter((e) => e.type === 'service.failed');
  assert.equal(failed.length, 1, 'the first failure is announced');
  assert.equal(failed[0].level, 'error', 'a failure is an error-level event');
  assert.match(
    String(failed[0].message),
    /web: docker health check failed after 2 attempts: web: not running/,
    'the event says what failed and why',
  );
  assert.equal(failed[0].metadata.service, 'web', 'it names the service whose check failed');

  const seen = control.events.length;
  await assert.rejects(reconcile(project, ctx), /not running/);
  await assert.rejects(reconcile(project, ctx), /not running/);
  assert.equal(control.events.length, seen, 'retrying the same failure adds no events');

  d.startsAs = 'running';
  await reconcile(project, ctx);
  assert.deepEqual(
    control.events.slice(seen).map((e) => `${e.type}:${e.message}`),
    ['service.serving:serving again after a failure'],
    'recovery is announced exactly once',
  );
  await reconcile(project, ctx);
  assert.equal(control.events.length, seen + 1, 'once recovered, polling is quiet again');

  d.startsAs = 'exited';
  d.containers.get(d.service('proj', 'web')[0].id)!.state = 'exited';
  await assert.rejects(reconcile(project, ctx), /not running/);
  assert.equal(
    control.events.filter((e) => e.type === 'service.failed').length,
    2,
    'a later failure of an already serving project is announced once more',
  );
});

test('tcp health: connects to the container IP and port', async () => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const ctx = await makeCtx();
    await withContainer(ctx, { ip: '127.0.0.1' });
    await waitForHealth(ctx, 'proj', 'web', 'db', { type: 'tcp', port, ...fastRetry });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const closed = net.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  const ctx = await makeCtx();
  await withContainer(ctx, { ip: '127.0.0.1' });
  await assert.rejects(
    waitForHealth(ctx, 'proj', 'web', 'db', {
      type: 'tcp',
      port: deadPort,
      interval: '1ms',
      retries: 2,
    }),
  );
});

test('health check is skipped without apply or without a health spec', async () => {
  const ctx = await makeCtx();
  await waitForHealth(ctx, 'proj', 'web', 'web', null);
  await waitForHealth({ ...ctx, apply: false }, 'proj', 'web', 'web', { type: 'docker' });
  assert.deepEqual([...fake(ctx).calls], []);
});

test('reconcile fails the rollout when a service health check never passes', async () => {
  const ctx = await makeCtx();
  fake(ctx).startsAs = 'exited';
  await assert.rejects(reconcile(desired(oneService), ctx), /not running/);
});

test('containerIp resolves the project network IP, falls back to the first network and to loopback, and errors without a container', async () => {
  const ctx = await makeCtx();
  await withContainer(ctx, { ip: '172.18.0.2' });
  assert.equal(await containerIp(ctx, 'proj', 'web'), '172.18.0.2');
  assert.equal(
    await containerIp(ctx, 'other', 'web'),
    '172.18.0.2',
    'a container on another network still resolves to its first network',
  );

  const d = fake(ctx);
  d.containers.get([...d.containers.keys()][0])!.body.NetworkingConfig = { EndpointsConfig: {} };
  assert.equal(await containerIp(ctx, 'proj', 'web'), '127.0.0.1');

  await assert.rejects(containerIp(ctx, 'proj', 'missing'), /No such container/);
});

test('executeCommand drives the Engine API for restart, logs, volume delete and diagnostics', async () => {
  const ctx = await makeCtx();
  const d = fake(ctx);
  await reconcile(desired(twoServices), ctx);
  d.logOutput.set(d.service('proj', 'web')[0].name, 'log-line\n');
  d.addImage('nginx');
  d.volumes.set('tug_proj_data', { Name: 'tug_proj_data' });

  assert.deepEqual(
    await executeCommand(
      {
        id: 'c1',
        type: 'service.restart',
        payload_json: JSON.stringify({ project: 'proj', service: 'web' }),
      },
      ctx,
    ),
    {
      commandId: 'c1',
      state: 'succeeded',
      result: { project: 'proj', service: 'web', restarted: true },
    },
  );
  assert.match(d.calls.at(-1)!, /^restart tug-proj-web-/);

  const logs = await executeCommand(
    {
      id: 'c2',
      type: 'logs.fetch',
      payload_json: JSON.stringify({ project: 'proj', service: 'web', tail: 50 }),
    },
    ctx,
  );
  assert.deepEqual(logs.result, { stdout: 'log-line\n', stderr: '' });
  assert.match(d.calls.at(-1)!, /^logs tug-proj-web-\w+ tail=50$/);

  await executeCommand(
    {
      id: 'c3',
      type: 'volume.delete',
      payload_json: JSON.stringify({ project: 'proj', volume: 'data' }),
    },
    ctx,
  );
  assert.equal(d.calls.at(-1), 'volume-rm tug_proj_data', 'the Tug-named volume is removed');
  assert.ok(!d.volumes.has('tug_proj_data'));

  const diag = await executeCommand({ id: 'c4', type: 'diagnostics.run', payload_json: '{}' }, ctx);
  assert.equal(diag.state, 'succeeded');
  assert.deepEqual((diag.result as { node: string }).node, 'n1');
  assert.deepEqual(
    (diag.result as { checks: { name: string }[] }).checks.map((c) => c.name),
    ['docker.info', 'docker.version', 'ports.public'],
    'diagnostics query the daemon and no longer look for the Compose plugin',
  );
});

test('diagnostics fail on a daemon older than the Engine API the agent needs', async () => {
  const ctx = await makeCtx();
  fake(ctx).version_ = { Version: '20.10.0', ApiVersion: '1.41' };
  const diag = await executeCommand({ id: 'c1', type: 'diagnostics.run' }, ctx);
  assert.equal(diag.state, 'failed');
  const check = (
    diag.result as { checks: { name: string; ok: boolean; error?: string }[] }
  ).checks.find((c) => c.name === 'docker.version');
  assert.equal(check?.ok, false);
  assert.match(String(check?.error), /older than the 1\.43/);
});

test('executeCommand tolerates a missing volume, reports failing diagnostics, rejects unknown types', async () => {
  const ctx = await makeCtx();
  const deleted = await executeCommand(
    {
      id: 'c1',
      type: 'volume.delete',
      payload_json: JSON.stringify({ project: 'proj', volume: 'data' }),
    },
    ctx,
  );
  assert.equal(deleted.state, 'succeeded', 'deleting a volume that is already gone succeeds');

  const broken = await makeCtx();
  const fail = async () => {
    throw new DockerError(500, 'permission denied');
  };
  Object.assign(fake(broken), {
    removeVolume: fail,
    info: fail,
    version: fail,
    listContainers: fail,
  });
  await assert.rejects(
    executeCommand(
      {
        id: 'c2',
        type: 'volume.delete',
        payload_json: JSON.stringify({ project: 'proj', volume: 'data' }),
      },
      broken,
    ),
    /permission denied/,
  );
  const diag = await executeCommand({ id: 'c3', type: 'diagnostics.run' }, broken);
  assert.equal(diag.state, 'failed');
  assert.equal(
    (diag.result as { checks: { ok: boolean }[] }).checks.every((c) => !c.ok),
    true,
  );

  const unknown = await executeCommand({ id: 'c4', type: 'nope' }, broken);
  assert.deepEqual(unknown, {
    commandId: 'c4',
    state: 'failed',
    result: { error: 'unsupported command nope' },
  });
});

test('pollOnce reconciles desired states, runs commands and posts one status report', async () => {
  const posted: unknown[] = [];
  const work = {
    serverTime: 't',
    nodeId: 'n1',
    desiredStates: [
      desired(twoServices),
      desired(
        {
          services: {
            bad: {
              image: 'x',
              environment: {},
              'x-tug': {
                placement: { nodes: ['n1'] },
                health: { type: 'docker', interval: '1ms', retries: 1 },
              },
            },
          },
        },
        'v1',
        'bad-proj',
      ),
    ],
    commands: [
      {
        id: 'c1',
        type: 'service.restart',
        payload_json: JSON.stringify({ project: 'proj', service: 'web' }),
      },
    ],
  };
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/agent/v1/work')) return Response.json(work);
    if (u.endsWith('/agent/v1/status')) {
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return Response.json({ secrets: {}, versions: {} });
  }) as HttpClient;
  const ctx = await makeCtx({ http });
  const d = fake(ctx);
  // Only the `bad` project's container dies on start; the other project is healthy.
  const start = d.startContainer.bind(d);
  d.startContainer = async (id) => {
    await start(id);
    const c = d.containers.get(id)!;
    if (c.body.Labels?.['tug.project'] === 'bad-proj') c.state = 'exited';
  };
  const projects = await pollOnce(ctx);

  assert.deepEqual(
    projects.map((p) => [p.project, p.health]),
    [
      ['proj', 'serving'],
      ['bad-proj', 'failed'],
    ],
  );
  assert.equal(posted.length, 1);
  const report = posted[0] as {
    node: string;
    projects: unknown[];
    commandResults: { commandId: string; state: string }[];
  };
  assert.equal(report.node, 'n1');
  assert.equal(report.projects.length, 2);
  assert.deepEqual(
    report.commandResults.map((r) => [r.commandId, r.state]),
    [['c1', 'succeeded']],
  );
});
