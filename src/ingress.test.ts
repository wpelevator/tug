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
  PROXY_STREAM_CLOSE_DELAY,
  PROXY_TRY_DURATION,
  PROXY_TRY_INTERVAL,
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
  address: `192.168.1.${name.length}`,
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

test('a reported port that is not a valid port number never becomes an endpoint port', () => {
  const status = serving('app1', 'blog', 'web');
  const injected = '8080 {\n\theader_down X-Audit injected\n\t#' as unknown as number;
  status.status.serviceStates!.web.port = injected;
  const endpoints = resolveServiceEndpoints([state()], [node('app1')], [status], STALE_BEFORE);
  assert.equal(
    endpoints.blog.web[0].port,
    undefined,
    'a string port is dropped so it cannot reach the Caddyfile',
  );
});

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
    [{ node: 'dbnode', address: '192.168.1.6' }],
    'name should resolve to the placement node address',
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

test('endpoints use node addresses and skip nodes without an address', () => {
  const nodes = [node('app1', { address: '192.168.1.5' }), node('app22', { address: null })];
  const eps = resolveServiceEndpoints(
    [state()],
    nodes,
    [serving('app1', 'blog', 'web'), serving('app22', 'blog', 'web')],
    STALE_BEFORE,
  );
  assert.deepEqual(
    eps.blog.web,
    [{ node: 'app1', address: '192.168.1.5' }],
    'a node without an address should not become an endpoint',
  );
});

test('ingress dials local and remote services on their bound node addresses', () => {
  const eps = {
    blog: {
      web: [
        { node: 'app1', address: '192.168.1.4' },
        { node: 'app22', address: '192.168.1.5' },
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
        upstreams: ['192.168.1.4:8080', '192.168.1.5:8080'],
      },
    ],
    'web runs on two nodes, so its port is bound to the node address and the local upstream uses it too; container port 80 resolves to published 8080',
  );
  assert.match(
    work.caddyfile,
    /\napp\.example\.com \{\n(?:\t.*\n|\t\t.*\n)*?\treverse_proxy 192\.168\.1\.4:8080 192\.168\.1\.5:8080 \{\n\t\tlb_policy round_robin\n/,
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
  const eps = { blog: { web: [{ node: 'edge', address: '192.168.1.4' }] } };
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
    ['192.168.1.4:8080'],
    'with a second ingress node the port is bound to the node address, so the local Caddy dials that too',
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

test('a host without a serving upstream is answered with a 503 and a warning', () => {
  const work = buildIngressWork({
    states: [state()],
    endpoints: {},
    node: 'edge',
    secrets: new Map(),
  });
  assert.deepEqual(
    work.routes.map((r) => [r.host, r.upstreams]),
    [['app.example.com', []]],
    'the host keeps its site block so clients see a 503 instead of a TLS failure',
  );
  assert.match(work.warnings[0], /blog\/web: no serving upstream.*answering 503/);
  assert.match(
    work.caddyfile,
    /app\.example\.com \{[\s\S]*header Retry-After 5[\s\S]*respond ".*" 503\n\}/,
    'the block answers 503 with Retry-After',
  );
  assert.doesNotMatch(work.caddyfile, /reverse_proxy/, 'nothing is proxied without an upstream');
  assert.equal(
    renderCaddyfile([]),
    '# no ingress routes\n',
    'an empty config is still valid Caddyfile',
  );
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
  assert.match(
    out,
    /^\{\n\temail ops@example\.com\n\tmetrics \{/,
    'ACME email goes in the global block',
  );
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
  const eps = { blog: { web: [{ node: 'app1', address: '192.168.1.4' }] } };
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

test('every route keeps requests and streams alive across upstream churn and reloads', () => {
  const route = (host: string, upstreams: string[]) => ({
    project: 'p',
    service: 's',
    host,
    tls: 'off' as const,
    upstreams,
  });
  const out = renderCaddyfile([
    route('one.example.com', ['10.0.0.1:80']),
    route('many.example.com', ['10.0.0.1:80', '10.0.0.2:80']),
  ]);
  const blockOf = (host: string) =>
    out.split('\n\n').find((b) => b.startsWith(`http://${host} {`)) ?? '';
  for (const host of ['one.example.com', 'many.example.com']) {
    const block = blockOf(host);
    assert.match(
      block,
      new RegExp(`lb_try_duration ${PROXY_TRY_DURATION}\\n`),
      `${host}: requests retry for a window instead of failing at the first dial error`,
    );
    assert.match(
      block,
      new RegExp(`lb_try_interval ${PROXY_TRY_INTERVAL}\\n`),
      `${host}: retries are paced`,
    );
    assert.match(
      block,
      new RegExp(`stream_close_delay ${PROXY_STREAM_CLOSE_DELAY}\\n`),
      `${host}: a reload does not cut live WebSockets`,
    );
    assert.match(block, /lb_policy round_robin/, `${host}: round_robin stays the default policy`);
    assert.doesNotMatch(
      block,
      /fail_duration|max_fails/,
      `${host}: no passive health, which would mark every replica down together after a shared blip; the endpoint list is already health-aware`,
    );
  }
});

test('maintenance mode answers 503 without proxying even when upstreams serve', () => {
  const s = state();
  (s.compose.services.web['x-tug'] as { ingress: { maintenance?: boolean } }).ingress.maintenance =
    true;
  const work = buildIngressWork({
    states: [s],
    endpoints: { blog: { web: [{ node: 'app1', address: '10.0.0.5' }] } },
    node: 'edge',
    secrets: new Map(),
  });
  assert.deepEqual(work.routes[0].upstreams, [], 'a host in maintenance has no upstreams');
  assert.equal(
    work.routes[0].maintenance,
    true,
    'the route says the empty upstream list is intended, so a rollout is not held waiting for one',
  );
  assert.doesNotMatch(work.caddyfile, /reverse_proxy/, 'traffic never reaches the service');
  assert.match(work.warnings[0], /app\.example\.com is in maintenance/, 'the operator is told');
});

test('metrics are always rendered and access logs only when asked for', () => {
  const route = {
    project: 'p',
    service: 's',
    host: 'a.example.com',
    tls: 'auto' as const,
    upstreams: ['10.0.0.1:80'],
  };
  const on = renderCaddyfile([route], { accessLog: true });
  assert.match(
    on,
    /a\.example\.com \{\n\tlog \{\n\t\toutput stdout\n\t\tformat json\n\t\}/,
    'each site writes a JSON access log to stdout',
  );
  assert.match(on, /metrics \{\n\t\tper_host\n\t\}/, 'metrics are labelled per host');
  const off = renderCaddyfile([route]);
  assert.doesNotMatch(off, /\blog\b/, 'access logging is off by default');
  assert.match(off, /metrics/, 'metrics do not depend on access logging');
  const input = {
    states: [state()],
    endpoints: {},
    node: 'edge',
    secrets: new Map<string, string>(),
  };
  assert.doesNotMatch(
    buildIngressWork(input).caddyfile,
    /\blog\b/,
    'control renders no access log unless it is switched on',
  );
  assert.match(
    buildIngressWork({ ...input, accessLog: true }).caddyfile,
    /\blog \{/,
    'control renders the access log when it is switched on',
  );
});

const wildRoute = (
  host: string,
  tls: 'auto' | 'off' | 'custom',
  aliases: string[] = [],
  upstreams = ['10.0.0.1:80'],
) => ({ project: 'p', service: 's', host, tls, upstreams, aliases });

test('a wildcard host with automatic HTTPS is issued on demand, approved only for one label under its zone', () => {
  const out = renderCaddyfile([
    wildRoute('*.network.example.com', 'auto'),
    wildRoute('*.other.example.org', 'auto'),
  ]);
  assert.match(
    out,
    /on_demand_tls \{\n\t\task http:\/\/127\.0\.0\.1:2021\/ask\n\t\}/,
    'on-demand issuance is gated by the loopback ask endpoint',
  );
  assert.match(
    out,
    /\*\.network\.example\.com \{\n\ttls \{\n\t\ton_demand\n\t\}/,
    'the zone site issues on demand',
  );
  assert.match(
    out,
    /http:\/\/127\.0\.0\.1:2021 \{\n\tbind 127\.0\.0\.1\n/,
    'the ask site listens on loopback only',
  );
  assert.ok(
    out.includes("{query.domain}.matches('^[a-z0-9-]+\\\\.network\\\\.example\\\\.com$')"),
    'the ask expression accepts exactly one label under the zone with its dots escaped',
  );
  assert.match(
    out,
    /respond @zone1 200\n\t\trespond 403/,
    'every zone is approved, anything else is refused',
  );
});

test('on-demand issuance is rendered only for wildcard hosts with automatic HTTPS', () => {
  for (const [label, route] of [
    ['an ordinary host', wildRoute('app.example.com', 'auto')],
    ['a wildcard with a custom certificate', wildRoute('*.example.com', 'custom')],
    ['a wildcard served over plain HTTP', wildRoute('*.example.com', 'off')],
  ] as const) {
    const out = renderCaddyfile([route]);
    assert.doesNotMatch(out, /on_demand/, `${label} needs no on-demand issuance`);
    assert.doesNotMatch(out, /127\.0\.0\.1:2021/, `${label} needs no ask site`);
  }
});

test('mapped domains share the route block, and a custom certificate does not cover them', () => {
  const auto = renderCaddyfile([wildRoute('app.example.com', 'auto', ['a.org', 'b.net'])]);
  assert.match(
    auto,
    /\napp\.example\.com, a\.org, b\.net \{\n/,
    'automatic HTTPS names share one block and one upstream list',
  );
  const off = renderCaddyfile([wildRoute('app.example.com', 'off', ['a.org'])]);
  assert.match(
    off,
    /http:\/\/app\.example\.com, http:\/\/a\.org \{/,
    'plain HTTP applies to every name',
  );
  const custom = renderCaddyfile([wildRoute('app.example.com', 'custom', ['a.org'])]);
  assert.match(
    custom,
    /\napp\.example\.com \{\n\ttls \/etc\/caddy\/certs\//,
    'the declared host keeps its certificate',
  );
  assert.match(
    custom,
    /\na\.org \{\n\treverse_proxy/,
    'a mapped domain gets its own automatic HTTPS block, which a custom certificate cannot serve',
  );
});

test('mixed mapped names keep wildcard zones on-demand and explicit names out of it', () => {
  const out = renderCaddyfile([
    wildRoute('app.example.com', 'auto', ['*.network.example.com', 'a.org']),
  ]);
  assert.match(
    out,
    /\napp\.example\.com, a\.org \{\n\treverse_proxy/,
    'explicit names are ordinary automatic HTTPS',
  );
  assert.match(
    out,
    /\*\.network\.example\.com \{\n\ttls \{\n\t\ton_demand/,
    'only the wildcard issues on demand',
  );
});

test('a wildcard host with characters outside a hostname never reaches a Caddy expression', () => {
  assert.throws(
    () => renderCaddyfile([wildRoute("*.a'b.example.com", 'auto')]),
    /not a wildcard host/,
    'the zone is validated before it is interpolated into the ask expression',
  );
});

test('mapped domains become aliases of their service route and follow its state', () => {
  const input = {
    states: [state()],
    endpoints: {},
    node: 'edge',
    secrets: new Map<string, string>(),
  };
  const domains = [
    { project: 'blog', service: 'web', host: 'A.Example.org' },
    { project: 'blog', service: 'web', host: 'app.example.com' },
    { project: 'blog', service: 'gone', host: 'orphan.example.org' },
    { project: 'other', service: 'web', host: 'other.example.org' },
  ];
  const work = buildIngressWork({ ...input, domains });
  assert.deepEqual(
    work.routes[0].aliases,
    ['a.example.org'],
    "only this service's domains are aliases, lowercased, and the route's own host is not repeated",
  );
  assert.match(
    work.caddyfile,
    /app\.example\.com, a\.example\.org \{[\s\S]*respond "[^"]*" 503/,
    'a domain follows its route, including the 503 answer while no upstream serves',
  );
  assert.match(
    work.warnings.join('\n'),
    /blog\/gone: domain orphan\.example\.org is not served because the service has no ingress route/,
    'a domain whose service has no route is reported',
  );
  assert.match(
    work.warnings.join('\n'),
    /other\/web: domain other\.example\.org is not served/,
    'a domain of a project that has no routes is reported too, not silently attached elsewhere',
  );
});
