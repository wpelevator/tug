import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDesiredState } from './compose.ts';
import {
  CADDY_CONTAINER,
  buildIngressWork,
  ingressConfigHash,
  reconcileIngress,
  removeIngress,
  renderCaddyfile,
  resolveServiceEndpoints,
} from './ingress.ts';
import type { NodeView, ReportedStatus } from './ingress.ts';
import type { ComposeFile, DesiredState, IngressWork } from './protocol.ts';
import { FakeDocker } from '../tests/fake-docker.ts';

const FRESH = '2026-01-01T00:00:10.000Z';
const STALE_BEFORE = '2026-01-01T00:00:00.000Z';
const node = (name: string, extra: Partial<NodeView> = {}): NodeView => ({
  name,
  overlayIp: `10.210.0.${name.length}`,
  address: null,
  lastSeenAt: FRESH,
  ...extra,
});
const serving = (n: string, project: string, ...services: string[]): ReportedStatus => ({
  node: n,
  project,
  status: {
    project,
    observedVersion: 'v1',
    health: 'serving',
    serviceStates: Object.fromEntries(
      services.map((s) => [s, { rolloutState: 'serving' as const }]),
    ),
  },
});

const compose: ComposeFile = {
  services: {
    web: {
      image: 'nginx',
      ports: ['8080:80'],
      'x-tug': {
        placement: { nodes: ['app1', 'app22'] },
        ingress: { host: 'App.Example.com', port: 80 },
      },
    },
    db: { image: 'mariadb', 'x-tug': { placement: { nodes: ['dbnode'] } } },
  },
};
const state = (c: ComposeFile = compose, project = 'blog'): DesiredState =>
  buildDesiredState({ project, version: 'v1', compose: c });

test('endpoints list only fresh nodes whose copy of the service reports serving', () => {
  const nodes = [node('app1'), node('app22'), node('dbnode')];
  const all = resolveServiceEndpoints(
    [state()],
    nodes,
    [
      serving('app1', 'blog', 'web'),
      serving('app22', 'blog', 'web'),
      serving('dbnode', 'blog', 'db'),
    ],
    STALE_BEFORE,
  );
  assert.deepEqual(
    all.blog.web.map((e) => e.node),
    ['app1', 'app22'],
    'multi-node service yields one endpoint per serving node',
  );
  assert.deepEqual(
    all.blog.db,
    [{ node: 'dbnode', address: '10.210.0.6' }],
    'name resolves to the placement node overlay address',
  );

  const notServing: ReportedStatus = {
    node: 'app22',
    project: 'blog',
    status: {
      project: 'blog',
      observedVersion: 'v1',
      health: 'serving',
      serviceStates: { web: { rolloutState: 'health_checking' } },
    },
  };
  const withdrawn = resolveServiceEndpoints(
    [state()],
    nodes,
    [serving('app1', 'blog', 'web'), notServing],
    STALE_BEFORE,
  );
  assert.deepEqual(
    withdrawn.blog.web.map((e) => e.node),
    ['app1'],
    'record withdrawn while a node is not serving',
  );
  assert.equal(withdrawn.blog.db, undefined, 'a service nobody reports serving has no record');

  const stale = resolveServiceEndpoints(
    [state()],
    [node('app1', { lastSeenAt: '2025-12-31T00:00:00.000Z' }), node('app22'), node('dbnode')],
    [serving('app1', 'blog', 'web'), serving('app22', 'blog', 'web')],
    STALE_BEFORE,
  );
  assert.deepEqual(
    stale.blog.web.map((e) => e.node),
    ['app22'],
    'record withdrawn when a node stops polling',
  );
});

test('endpoints fall back to the node address without a mesh and skip unreachable nodes', () => {
  const nodes = [
    node('app1', { overlayIp: null, address: '192.168.1.5' }),
    node('app22', { overlayIp: null, address: null }),
  ];
  const eps = resolveServiceEndpoints(
    [state()],
    nodes,
    [serving('app1', 'blog', 'web'), serving('app22', 'blog', 'web')],
    STALE_BEFORE,
  );
  assert.deepEqual(
    eps.blog.web,
    [{ node: 'app1', address: '192.168.1.5' }],
    'node with no overlay or address cannot be an endpoint',
  );
});

test('ingress dials a local service on its bound address when other nodes also reach it, and remote ones on their overlay address', () => {
  const eps = {
    blog: {
      web: [
        { node: 'app1', address: '10.210.0.4' },
        { node: 'app22', address: '10.210.0.5' },
      ],
    },
  };
  const work = buildIngressWork({
    states: [state()],
    endpoints: eps,
    node: 'app1',
    nodes: ['app1', 'app22', 'dbnode'],
    ingressNodes: ['app1'],
    secrets: new Map(),
  });
  assert.deepEqual(
    work.routes,
    [
      {
        project: 'blog',
        service: 'web',
        host: 'app.example.com',
        tls: 'auto',
        upstreams: ['10.210.0.4:8080', '10.210.0.5:8080'],
      },
    ],
    'web runs on two nodes, so its port is bound to the overlay address and the local upstream uses it too; container port 80 resolves to published 8080',
  );
  assert.equal(
    work.caddyfile,
    `app.example.com {\n\treverse_proxy 10.210.0.4:8080 10.210.0.5:8080 {\n\t\tlb_policy round_robin\n\t}\n}\n`,
    'the Caddyfile lists the same upstreams',
  );
  assert.deepEqual(work.warnings, []);
});

test('ingress dials 127.0.0.1 for a service whose ingress port listens on loopback on the ingress node', () => {
  const local: ComposeFile = {
    services: {
      web: {
        image: 'nginx',
        ports: ['8080:80'],
        'x-tug': { placement: { nodes: ['edge'] }, ingress: { host: 'app.example.com', port: 80 } },
      },
    },
  };
  const eps = { blog: { web: [{ node: 'edge', address: '10.210.0.4' }] } };
  const work = buildIngressWork({
    states: [state(local)],
    endpoints: eps,
    node: 'edge',
    nodes: ['edge', 'app'],
    ingressNodes: ['edge'],
    secrets: new Map(),
  });
  assert.deepEqual(
    work.routes[0].upstreams,
    ['127.0.0.1:8080'],
    'a project wholly on the only ingress node is reached on loopback, where its port is bound',
  );
  const twoEdges = buildIngressWork({
    states: [state(local)],
    endpoints: eps,
    node: 'edge',
    nodes: ['edge', 'edge2'],
    ingressNodes: ['edge', 'edge2'],
    secrets: new Map(),
  });
  assert.deepEqual(
    twoEdges.routes[0].upstreams,
    ['10.210.0.4:8080'],
    'with a second ingress node the port is bound to the overlay address, so the local Caddy dials that too',
  );
  const v6 = buildIngressWork({
    states: [state()],
    endpoints: { blog: { web: [{ node: 'app22', address: 'fd00::5' }] } },
    node: 'edge',
    nodes: ['edge', 'app1', 'app22', 'dbnode'],
    ingressNodes: ['edge'],
    secrets: new Map(),
  });
  assert.deepEqual(
    v6.routes[0].upstreams,
    ['[fd00::5]:8080'],
    'an IPv6 node address is bracketed in the upstream',
  );
});

test('routes without serving upstreams are withheld with a warning', () => {
  const work = buildIngressWork({
    states: [state()],
    endpoints: {},
    node: 'edge',
    secrets: new Map(),
  });
  assert.deepEqual(work.routes, []);
  assert.match(work.warnings[0], /blog\/web: no serving upstream/);
  assert.equal(work.caddyfile, '# no ingress routes\n', 'an empty config is still valid Caddyfile');
});

test('tls modes render the right Caddy site blocks', () => {
  const route = (tls: 'auto' | 'off' | 'custom', host: string) => ({
    project: 'p',
    service: 's',
    host,
    tls,
    upstreams: ['10.0.0.1:80'],
  });
  const out = renderCaddyfile(
    [
      route('auto', 'a.example.com'),
      route('off', 'b.example.com'),
      route('custom', 'c.example.com'),
    ],
    { acmeEmail: 'ops@example.com' },
  );
  assert.match(out, /^\{\n\temail ops@example\.com\n\}/, 'ACME email goes in the global block');
  assert.match(
    out,
    /\na\.example\.com \{\n\treverse_proxy/,
    'auto: bare host enables automatic HTTPS',
  );
  assert.match(out, /\nhttp:\/\/b\.example\.com \{/, 'off: explicit http:// disables HTTPS');
  assert.match(
    out,
    /c\.example\.com \{\n\ttls \/etc\/caddy\/certs\/c\.example\.com\.crt \/etc\/caddy\/certs\/c\.example\.com\.key/,
    'custom: tls directive points at the shipped files',
  );
});

test('custom TLS ships cert and key from the project secrets and skips routes missing them', () => {
  const c: ComposeFile = {
    services: {
      web: {
        image: 'x',
        ports: ['8080:80'],
        'x-tug': {
          placement: { nodes: ['app1'] },
          ingress: {
            host: 'secure.example.com',
            port: 80,
            tls: 'custom',
            cert: 'WEB_CERT',
            key: 'WEB_KEY',
          },
        },
      },
    },
  };
  const eps = { blog: { web: [{ node: 'app1', address: '10.210.0.4' }] } };
  const ok = buildIngressWork({
    states: [state(c)],
    endpoints: eps,
    node: 'edge',
    secrets: new Map([
      ['blog/WEB_CERT', 'CERT-PEM'],
      ['blog/WEB_KEY', 'KEY-PEM\n'],
    ]),
  });
  assert.deepEqual(
    ok.files,
    { 'certs/secure.example.com.crt': 'CERT-PEM\n', 'certs/secure.example.com.key': 'KEY-PEM\n' },
    'PEMs are delivered as files for the Caddy container',
  );
  assert.doesNotMatch(ok.caddyfile, /PEM/, 'key material never appears in the Caddyfile');
  const missing = buildIngressWork({
    states: [state(c)],
    endpoints: eps,
    node: 'edge',
    secrets: new Map(),
  });
  assert.deepEqual(missing.routes, [], 'route skipped without secrets');
  assert.match(missing.warnings[0], /custom TLS secrets WEB_CERT\/WEB_KEY not found/);
});

test('a hostname claimed by two projects is served by the first and warned about', () => {
  const eps = {
    a: { web: [{ node: 'n', address: '10.0.0.1' }] },
    b: { web: [{ node: 'n', address: '10.0.0.2' }] },
  };
  const work = buildIngressWork({
    states: [state(compose, 'b'), state(compose, 'a')],
    endpoints: eps,
    node: 'edge',
    secrets: new Map(),
  });
  assert.deepEqual(
    work.routes.map((r) => r.project),
    ['a'],
    'deterministic winner by project name',
  );
  assert.match(work.warnings[0], /b\/web: host app\.example\.com is already routed by a\/web/);
});

// ---- agent side: managed Caddy container -------------------------------------------------------

const work = (caddyfile: string, files: Record<string, string> = {}): IngressWork => ({
  caddyfile,
  files,
  routes: [],
  warnings: [],
});
const stateDirFor = () => fs.mkdtemp(path.join(os.tmpdir(), 'tug-ingress-'));
const reload = (c: string) => c.startsWith(`exec ${CADDY_CONTAINER} caddy reload`);

test('first reconcile creates the Caddy container with persistent volumes, loads config and starts it', async () => {
  const docker = new FakeDocker();
  const stateDir = await stateDirFor();
  const status = await reconcileIngress(
    { docker, stateDir },
    work('a.example.com {\n}\n', { 'certs/a.crt': 'C' }),
  );
  assert.equal(status.state, 'serving');
  const caddy = docker.byName(CADDY_CONTAINER)!;
  assert.equal(
    caddy.body.HostConfig?.NetworkMode,
    'host',
    'host networking so 80/443 and loopback upstreams work',
  );
  assert.ok(
    (caddy.body.HostConfig?.Binds as string[]).includes('tug-caddy-data:/data'),
    'ACME state lives on a named volume that survives container recreation',
  );
  assert.deepEqual(
    docker.calls,
    [
      'pull caddy:2-alpine',
      `create ${CADDY_CONTAINER}`,
      `archive ${CADDY_CONTAINER} /etc/caddy`,
      `start ${CADDY_CONTAINER}`,
    ],
    'the image is pulled, then config is uploaded before Caddy starts, with no reload on a fresh container',
  );
  assert.ok(docker.archives[0].bytes > 0, 'the staged Caddyfile and certs travel as a tar archive');
});

test('unchanged config is a no-op and changed config reloads gracefully without restarting', async () => {
  const docker = new FakeDocker();
  const stateDir = await stateDirFor();
  const ctx = { docker, stateDir };
  await reconcileIngress(ctx, work('v1\n'));
  docker.calls.length = 0;
  await reconcileIngress(ctx, work('v1\n'));
  assert.deepEqual([...docker.calls], [], 'a quiet tick only inspects the container');

  const status = await reconcileIngress(ctx, work('v2\n'));
  assert.equal(status.state, 'serving');
  assert.ok(
    docker.calls.includes(
      `exec ${CADDY_CONTAINER} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
    ),
    'config applied with caddy reload',
  );
  assert.ok(
    !docker.calls.some((c) => /^(restart|stop|rm|start) /.test(c)),
    'the container is never restarted, so connections are not dropped',
  );
});

test('a rejected config is reported, keeps the old config on disk and is retried next tick', async () => {
  const docker = new FakeDocker();
  const stateDir = await stateDirFor();
  const ctx = { docker, stateDir };
  await reconcileIngress(ctx, work('good\n'));
  docker.failExec = (cmd) =>
    cmd.includes('reload') ? { code: 1, err: 'adapting config: unknown directive' } : undefined;
  docker.calls.length = 0;
  const status = await reconcileIngress(ctx, work('bad\n'));
  assert.equal(status.state, 'failed');
  assert.match(status.error!, /unknown directive/);
  assert.equal(
    docker.calls.filter((c) => c.startsWith('archive')).length,
    2,
    'the rejected config is uploaded and then the previously applied config is restored',
  );
  docker.failExec = undefined;
  assert.equal(
    (await reconcileIngress(ctx, work('bad\n'))).state,
    'serving',
    'a later tick applies the same config again',
  );
});

test('a stopped Caddy container is started again and config hash covers files', async () => {
  const docker = new FakeDocker();
  const stateDir = await stateDirFor();
  await reconcileIngress({ docker, stateDir }, work('x\n'));
  docker.byName(CADDY_CONTAINER)!.state = 'exited';
  await fs.rm(path.join(stateDir, 'ingress', 'applied.hash'));
  docker.calls.length = 0;
  await reconcileIngress({ docker, stateDir }, work('x\n'));
  assert.ok(
    docker.calls.includes(`start ${CADDY_CONTAINER}`),
    'existing stopped container is started',
  );
  assert.ok(!docker.calls.some(reload), 'a stopped container needs no reload');
  assert.notEqual(
    ingressConfigHash(work('x\n', { a: '1' })),
    ingressConfigHash(work('x\n', { a: '2' })),
    'changing a cert file changes the hash so it is reloaded',
  );
});

test('removeIngress deletes the container but keeps ACME volumes, and is a no-op on non-ingress nodes', async () => {
  const docker = new FakeDocker();
  const stateDir = await stateDirFor();
  assert.equal(await removeIngress({ docker, stateDir }), false, 'nothing to remove');
  assert.deepEqual([...docker.calls], []);
  await reconcileIngress({ docker, stateDir }, work('x\n'));
  docker.calls.length = 0;
  assert.equal(await removeIngress({ docker, stateDir }), true);
  assert.deepEqual(
    docker.calls,
    [`rm ${CADDY_CONTAINER}`],
    'only the container is removed; no volume is touched',
  );
});
