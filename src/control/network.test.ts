import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { createCsr, generateKeyPair } from '../pki.ts';
import { json } from '../../tests/helpers.ts';

const NETWORK_ENV = ['TUG_SERVICE_NAMES', 'TUG_ACME_EMAIL'];

async function server(
  env: Record<string, string> = {},
  resolve: (image: string) => Promise<string> = testImageResolver,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-net-'));
  for (const key of NETWORK_ENV) delete process.env[key];
  Object.assign(
    process.env,
    {
      TUG_DATA_DIR: dir,
    },
    env,
  );
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve },
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const op = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
  const post = (route: string, body: unknown, headers: Record<string, string> = op) =>
    fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const agent = (token: string) => ({
    ...(token.startsWith('op-')
      ? { 'x-tug-test-operator': 'operator' }
      : { 'x-tug-test-node': token }),
    'content-type': 'application/json',
  });
  const work = async (token: string) =>
    json(await fetch(`${base}/agent/v1/work`, { headers: agent(token) }));
  const register = async (name: string, body: Record<string, unknown> = {}) =>
    json(await post('/api/v1/nodes/register', { name, ...body }));
  const report = async (token: string, node: string, project: string, services: string[]) =>
    post(
      '/agent/v1/status',
      {
        node,
        commandResults: [],
        projects: [
          {
            project,
            observedVersion: 'v1',
            observedRevision: (await work(token)).desiredStates.find(
              (state: { project: string }) => state.project === project,
            )?.revision,
            health: 'serving',
            services,
            serviceStates: Object.fromEntries(
              services.map((s) => [s, { rolloutState: 'serving' }]),
            ),
          },
        ],
      },
      agent(token),
    );
  return {
    base,
    post,
    agent,
    work,
    register,
    report,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

test('registration ignores removed WireGuard fields and work contains no mesh configuration', async () => {
  const s = await server();
  try {
    const csr = await createCsr((await generateKeyPair()).privateKeyPem);
    const reg = await json(
      await s.post('/api/v1/nodes/n1/identity', {
        csr,
        mode: 'create',
        publicAddress: '203.0.113.1',
        wgPublicKey: 'removed',
      }),
    );
    assert.equal(
      'public_address' in reg.node,
      false,
      'node info should omit the removed public address',
    );
    assert.equal(
      'overlay_ip' in reg.node,
      false,
      'node info should omit the removed overlay address',
    );
    const w = await s.work(reg.node.id);
    assert.deepEqual(
      Object.keys(w).sort(),
      [
        'commands',
        'desiredStates',
        'nodeId',
        'ports',
        'retainedImages',
        'serverTime',
        'serviceEndpoints',
      ],
      'work should include default service names but no network or ingress keys',
    );
    assert.deepEqual(
      w.ports,
      { address: null, loopback: {} },
      'a node without an address should bind published ports to loopback',
    );
    assert.equal(
      (await s.post('/agent/v1/wireguard/key', { publicKey: 'removed' }, s.agent(reg.node.id)))
        .status,
      404,
      'the WireGuard key route should no longer exist',
    );
    assert.equal(
      (await s.post('/api/v1/nodes/n1/rotate-wg-key', {})).status,
      404,
      'the WireGuard rotation route should no longer exist',
    );
    const diagnostics = await json(
      await fetch(`${s.base}/api/v1/diagnostics`, { headers: s.agent('op-net-token') }),
    );
    assert.equal(
      diagnostics.checks.some((check: { name: string }) => check.name === 'mesh'),
      false,
      'doctor should not include a mesh check',
    );
  } finally {
    await s.close();
  }
});

const stack = {
  services: {
    web: {
      image: 'nginx',
      ports: ['8080:80'],
      'x-tug': { placement: { nodes: ['app'] }, ingress: { host: 'app.example.com', port: 80 } },
    },
    db: { image: 'mariadb', ports: ['3306:3306'], 'x-tug': { placement: { nodes: ['dbn'] } } },
  },
};

test('replacing a node identity updates and validates its address', async () => {
  const s = await server();
  try {
    const firstKey = await generateKeyPair();
    const firstCsr = await createCsr(firstKey.privateKeyPem);
    const created = await json(
      await s.post('/api/v1/nodes/n1/identity', {
        csr: firstCsr,
        mode: 'create',
        address: '10.0.0.1',
      }),
    );
    assert.equal(
      created.node.address,
      '10.0.0.1',
      'registration should store the supplied address',
    );

    const secondKey = await generateKeyPair();
    const secondCsr = await createCsr(secondKey.privateKeyPem);
    const replaced = await json(
      await s.post('/api/v1/nodes/n1/identity', {
        csr: secondCsr,
        mode: 'replace',
        address: '10.0.0.2',
      }),
    );
    assert.equal(
      replaced.node.address,
      '10.0.0.2',
      'replacing an identity should update the node address when one is supplied',
    );

    const badKey = await generateKeyPair();
    const badCsr = await createCsr(badKey.privateKeyPem);
    const bad = await s.post('/api/v1/nodes/n1/identity', {
      csr: badCsr,
      mode: 'replace',
      address: 'bad:host',
    });
    assert.equal(bad.status, 400, 'a malformed replacement address should be rejected');
  } finally {
    await s.close();
  }
});

test('service endpoints use node addresses by default once the node reports the service serving', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.4' });
    const dbn = await s.register('dbn', { address: '192.168.1.6' });
    const dep = await s.post('/api/v1/deployments', {
      project: 'blog',
      version: 'v1',
      compose: stack,
    });
    assert.equal(dep.status, 200, 'ingress annotation passes deploy validation');
    assert.deepEqual(
      (await s.work(app.nodeId)).serviceEndpoints,
      { blog: {} },
      'nothing is serving yet, so no records',
    );

    await s.report(dbn.nodeId, 'dbn', 'blog', ['db']);
    assert.deepEqual(
      (await s.work(app.nodeId)).serviceEndpoints,
      { blog: { db: [{ node: 'dbn', address: '192.168.1.6' }] } },
      'db should resolve to its node address once serving',
    );

    await s.post(
      '/agent/v1/status',
      {
        node: 'dbn',
        commandResults: [],
        projects: [
          {
            project: 'blog',
            observedVersion: 'v1',
            health: 'failed',
            serviceStates: { db: { rolloutState: 'health_checking' } },
          },
        ],
      },
      s.agent(dbn.nodeId),
    );
    assert.deepEqual(
      (await s.work(app.nodeId)).serviceEndpoints,
      { blog: {} },
      'record withdrawn when the node stops serving',
    );
  } finally {
    await s.close();
  }
});

test('only ingress nodes get an edge config, built from all projects and serving upstreams', async () => {
  const s = await server({ TUG_ACME_EMAIL: 'ops@example.com' });
  try {
    const edge = await s.register('edge', { address: '192.168.1.2' });
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.register('dbn', { address: '192.168.1.6' });
    await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: stack });
    assert.equal(
      (await s.work(edge.nodeId)).ingress,
      undefined,
      'a node is not an edge until marked',
    );

    assert.equal((await s.post('/api/v1/nodes/edge/ingress', { enabled: true })).status, 200);
    let w = await s.work(edge.nodeId);
    assert.deepEqual(
      w.ingress.routes.map((r: { upstreams: string[] }) => r.upstreams),
      [[]],
      'the host is routed with no upstream until one serves, so the edge answers 503',
    );
    assert.match(w.ingress.warnings[0], /no serving upstream.*answering 503/);

    await s.report(app.nodeId, 'app', 'blog', ['web']);
    w = await s.work(edge.nodeId);
    assert.match(
      w.ingress.caddyfile,
      new RegExp(
        `email ops@example\\.com[\\s\\S]*app\\.example\\.com \\{\\n[\\s\\S]*?\\treverse_proxy 192.168.1.5:8080`,
      ),
      'upstream should be the app node address on the published port',
    );

    const nodes = (
      await json(await fetch(`${s.base}/api/v1/nodes`, { headers: s.agent('op-net-token') }))
    ).nodes;
    assert.equal(
      nodes.find((n: { name: string }) => n.name === 'edge').ingress,
      1,
      'node list shows the ingress role',
    );

    await s.post('/api/v1/nodes/edge/ingress', { enabled: false });
    assert.equal((await s.work(edge.nodeId)).ingress, undefined, 'role can be removed');
  } finally {
    await s.close();
  }
});

test('ingress uses node addresses with service names disabled, and ingress status is stored and diagnosed', async () => {
  const s = await server({ TUG_SERVICE_NAMES: 'false' });
  try {
    const edge = await s.register('edge');
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
    await s.post('/api/v1/deployments', {
      project: 'blog',
      version: 'v1',
      compose: { services: { web: stack.services.web } },
    });
    await s.report(app.nodeId, 'app', 'blog', ['web']);
    const w = await s.work(edge.nodeId);
    assert.deepEqual(
      w.ingress.routes[0].upstreams,
      ['192.168.1.5:8080'],
      'the plain node address should be the ingress upstream',
    );
    assert.equal(
      w.serviceEndpoints,
      undefined,
      'TUG_SERVICE_NAMES=false should disable service DNS',
    );

    const diag = async () =>
      (
        await json(
          await fetch(`${s.base}/api/v1/diagnostics`, { headers: s.agent('op-net-token') }),
        )
      ).checks.find((c: { name: string }) => c.name === 'ingress');
    assert.equal((await diag()).ok, false, 'doctor flags an ingress node that has not reported');
    await s.post(
      '/agent/v1/status',
      {
        node: 'edge',
        projects: [],
        commandResults: [],
        ingress: { state: 'serving', configHash: 'h', routes: 1 },
      },
      s.agent(edge.nodeId),
    );
    assert.equal((await diag()).ok, true, 'doctor passes once the edge reports serving');
  } finally {
    await s.close();
  }
});

test('the work response binds published ports to node addresses or loopback', async () => {
  const s = await server();
  try {
    const edge = await s.register('edge', { address: '192.168.1.9' });
    const app = await s.register('app', { address: '192.168.1.10' });
    await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
    const site = {
      services: {
        web: {
          ...stack.services.web,
          'x-tug': { ...stack.services.web['x-tug'], placement: { nodes: ['edge'] } },
        },
      },
    };
    await s.post('/api/v1/deployments', { project: 'site', version: 'v1', compose: site });
    await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: stack });
    assert.deepEqual(
      (await s.work(edge.nodeId)).ports,
      { address: '192.168.1.9', loopback: { site: ['web'] } },
      'a project wholly on the only ingress node should bind its ingress port to loopback',
    );
    assert.deepEqual(
      (await s.work(app.nodeId)).ports,
      { address: '192.168.1.10', loopback: {} },
      'a non-ingress node should bind published ports to its node address',
    );
  } finally {
    await s.close();
  }
});

test('deploy rejects invalid ingress annotations and custom TLS without its secrets', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    const bad = await s.post('/api/v1/deployments', {
      project: 'blog',
      version: 'v1',
      compose: {
        services: { web: { image: 'nginx', 'x-tug': { ingress: { host: 'nope', port: 80 } } } },
      },
    });
    assert.equal(bad.status, 400);
    assert.match((await json(bad)).error, /ingress\.host must be a fully qualified hostname/);
    const custom = {
      services: {
        web: {
          image: 'nginx',
          ports: ['8080:80'],
          'x-tug': {
            ingress: { host: 'a.example.com', port: 80, tls: 'custom', cert: 'C', key: 'K' },
          },
        },
      },
    };
    const missing = await s.post('/api/v1/deployments', {
      project: 'blog',
      version: 'v1',
      compose: custom,
    });
    assert.equal(missing.status, 400);
    assert.match((await json(missing)).error, /custom TLS secret C not found/);
    await s.post('/api/v1/secrets', { project: 'blog', name: 'C', value: 'CERT-PEM' });
    await s.post('/api/v1/secrets', { project: 'blog', name: 'K', value: 'KEY-PEM' });
    assert.equal(
      (await s.post('/api/v1/deployments', { project: 'blog', version: 'v1', compose: custom }))
        .status,
      200,
      'deploy succeeds once secrets exist',
    );
    const edge = await s.register('edge');
    await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
    await s.report(app.nodeId, 'app', 'blog', ['web']);
    const w = await s.work(edge.nodeId);
    assert.deepEqual(
      w.ingress.files,
      { 'certs/a.example.com.crt': 'CERT-PEM\n', 'certs/a.example.com.key': 'KEY-PEM\n' },
      'the edge receives the decrypted project secrets as files',
    );
    assert.match(w.ingress.caddyfile, /tls \/etc\/caddy\/certs\/a\.example\.com\.crt/);
    assert.equal(
      (await s.work(app.nodeId)).ingress,
      undefined,
      'app nodes never receive the TLS key material',
    );
  } finally {
    await s.close();
  }
});

test('node address updates validate input and reach agent work', async () => {
  const s = await server();
  try {
    const reg = await s.register('address-node', { address: '10.0.0.1' });
    const bad = await s.post('/api/v1/nodes/address-node/address', { address: 'bad:port' });
    assert.equal(bad.status, 400, 'invalid node addresses should be rejected');
    const changed = await s.post('/api/v1/nodes/address-node/address', { address: '10.0.0.2' });
    assert.equal(changed.status, 200, 'valid node addresses should be accepted');
    assert.equal(
      (await s.work(reg.nodeId)).ports.address,
      '10.0.0.2',
      'agent work should use the updated address',
    );
    const missing = await s.post('/api/v1/nodes/unknown/address', { address: '10.0.0.2' });
    assert.equal(missing.status, 404, 'address updates should reject unknown nodes');
  } finally {
    await s.close();
  }
});

async function domainsServer(resolve?: (image: string) => Promise<string>) {
  const s = await server({}, resolve);
  const edge = await s.register('edge', { address: '192.168.1.2' });
  const app = await s.register('app', { address: '192.168.1.5' });
  await s.register('dbn', { address: '192.168.1.6' });
  await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
  const op = s.agent('op-net-token');
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${s.base}${route}`, {
      method,
      headers: op,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const deploy = (project: string, compose: unknown, version = 'v1') =>
    s.post('/api/v1/deployments', { project, version, compose });
  /** A deployment stays rolling_out until its nodes report, and blocks the next one; cancel it to deploy again. */
  const supersede = async (first: Response) => {
    const { deployment } = await json(first);
    return s.post(`/api/v1/deployments/${deployment.id}/cancel`, {});
  };
  const edgeWork = async () => (await s.work(edge.nodeId)).ingress;
  return { ...s, edge, app, call, deploy, supersede, edgeWork };
}

test('a mapped domain is served on its service route from the next poll, without a deployment, and can be removed', async () => {
  const s = await domainsServer();
  try {
    const first = await s.deploy('blog', stack);
    const added = await s.call('POST', '/api/v1/domains', {
      project: 'blog',
      service: 'web',
      host: 'Mapped.Example.org',
    });
    assert.equal(added.status, 200, `adding a domain succeeds: ${JSON.stringify(added.body)}`);
    assert.equal(added.body.host, 'mapped.example.org', 'the host is stored lowercase');
    let ingress = await s.edgeWork();
    assert.deepEqual(
      ingress.routes[0].aliases,
      ['mapped.example.org'],
      'the domain becomes an alias of the service route with no new deployment',
    );
    assert.match(
      ingress.caddyfile,
      /app\.example\.com, mapped\.example\.org \{/,
      'the Caddyfile serves both names from one block',
    );
    const again = await s.call('POST', '/api/v1/domains', {
      project: 'blog',
      service: 'web',
      host: 'mapped.example.org',
    });
    assert.equal(again.body.unchanged, true, 'adding the same mapping again is idempotent');
    assert.deepEqual(
      (await s.call('GET', '/api/v1/domains?project=blog')).body.domains.map(
        (d: { host: string; service: string }) => [d.host, d.service],
      ),
      [['mapped.example.org', 'web']],
      'the list shows the mapping',
    );
    await s.supersede(first);
    assert.equal(
      (await s.deploy('blog', { ...stack, services: { ...stack.services } }, 'v2')).status,
      200,
      `the redeploy is accepted`,
    );
    assert.deepEqual(
      (await s.edgeWork()).routes[0].aliases,
      ['mapped.example.org'],
      'a redeploy keeps the mapped domains',
    );
    assert.equal(
      (await s.call('DELETE', '/api/v1/domains/mapped.example.org?project=blog')).status,
      200,
      'removing a domain succeeds',
    );
    ingress = await s.edgeWork();
    assert.equal(ingress.routes[0].aliases, undefined, 'the domain is no longer served');
    assert.equal(
      (await s.call('DELETE', '/api/v1/domains/mapped.example.org?project=blog')).status,
      404,
      'removing an unknown domain says so',
    );
    const events = await json(
      await fetch(`${s.base}/api/v1/events?project=blog`, { headers: s.agent('op-net-token') }),
    );
    assert.deepEqual(
      events.events
        .map((e: { type: string }) => e.type)
        .filter((t: string) => t.startsWith('domain.'))
        .sort(),
      ['domain.added', 'domain.removed'],
      'adding and removing a domain are audited',
    );
  } finally {
    await s.close();
  }
});

test('a domain is refused unless the project can serve it and no other project owns the name', async () => {
  const s = await domainsServer();
  try {
    const add = (body: Record<string, unknown>) =>
      s.call('POST', '/api/v1/domains', { project: 'blog', service: 'web', ...body });
    assert.equal(
      (await add({ host: 'a.example.org' })).status,
      409,
      'a project with no deployment has nothing to serve the domain on',
    );
    await s.deploy('blog', stack);
    const shop = {
      services: {
        web: {
          image: 'nginx',
          ports: ['9090:80'],
          'x-tug': {
            placement: { nodes: ['app'] },
            ingress: { host: 'shop.example.net', port: 80 },
          },
        },
      },
    };
    await s.deploy('shop', shop);
    for (const [body, status, why] of [
      [{ host: 'not a host' }, 400, 'a malformed hostname'],
      [{ host: 'a.example.org', service: 'db' }, 409, 'a service without an ingress route'],
      [{ host: 'a.example.org', service: 'nope' }, 409, 'a service that does not exist'],
      [{ host: 'app.example.com' }, 409, "the service's own declared host"],
      [{ host: 'shop.example.net' }, 409, "another project's declared host"],
      [{ host: 'x.shop.example.net' }, 200, 'a name under another project host is not an overlap'],
    ] as const)
      assert.equal((await add(body)).status, status, `${JSON.stringify(body)}: ${why}`);
    assert.equal(
      (
        await s.call('POST', '/api/v1/domains', {
          project: 'shop',
          service: 'web',
          host: 'x.shop.example.net',
        })
      ).status,
      409,
      "another project's mapped domain",
    );
    assert.equal(
      (
        await s.call('POST', '/api/v1/domains', {
          project: 'shop',
          service: 'web',
          host: '*.shop.example.net',
        })
      ).status,
      409,
      'a wildcard that would cover a name another project already maps',
    );
    const rejected = await s.deploy('shop', {
      services: {
        web: {
          ...shop.services.web,
          'x-tug': {
            placement: { nodes: ['app'] },
            ingress: { host: 'x.shop.example.net', port: 80 },
          },
        },
      },
    });
    assert.equal(
      rejected.status,
      409,
      'a deployment cannot declare a host another project has mapped as a domain',
    );
  } finally {
    await s.close();
  }
});

test('a domain whose service lost its ingress route is kept but not served, with a warning', async () => {
  const s = await domainsServer();
  try {
    const first = await s.deploy('blog', stack);
    await s.call('POST', '/api/v1/domains', {
      project: 'blog',
      service: 'web',
      host: 'm.example.org',
    });
    const noIngress = {
      services: {
        ...stack.services,
        web: { ...stack.services.web, 'x-tug': { placement: { nodes: ['app'] } } },
      },
    };
    await s.supersede(first);
    assert.equal(
      (await s.deploy('blog', noIngress, 'v2')).status,
      200,
      'the deployment without the route is accepted',
    );
    const ingress = await s.edgeWork();
    assert.equal(ingress.routes.length, 0, 'nothing is served without an ingress route');
    assert.match(
      ingress.warnings.join('\n'),
      /domain m\.example\.org is not served because the service has no served ingress route/,
      'the operator is told why the domain is not served',
    );
    assert.equal(
      (await s.call('GET', '/api/v1/domains?project=blog')).body.domains.length,
      1,
      'the mapping is kept, so a rollback or a new route restores it',
    );
  } finally {
    await s.close();
  }
});

test('a service on an ingress node cannot publish the ports the managed Caddy listens on', async () => {
  const s = await domainsServer();
  try {
    const web = (ports: string[], nodes = ['edge']) => ({
      services: {
        web: { image: 'nginx', ports, 'x-tug': { placement: { nodes } } },
      },
    });
    for (const [ports, nodes, status, why] of [
      [['2021:80'], ['edge'], 400, "the ask site's port on the ingress node"],
      [
        ['127.0.0.1:2019:80'],
        ['edge'],
        400,
        'the admin port on the ingress node, even on loopback',
      ],
      [['2000-2030:80'], ['edge'], 400, 'a range that covers a reserved port'],
      [['2021:80'], ['app'], 200, 'the same port on a node that is not an ingress node'],
      [['8080:80'], ['edge'], 200, 'any other port on the ingress node'],
    ] as const) {
      const res = await s.deploy('ports', web([...ports], [...nodes]), `v-${status}-${ports[0]}`);
      assert.equal(res.status, status, `${ports[0]} on ${nodes[0]}: ${why}`);
      if (res.status === 200) await s.supersede(res);
    }
  } finally {
    await s.close();
  }
});

test('a name claimed by a domain while another project was still building is refused at publication', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const s = await domainsServer(async (image) => {
    if (image === 'slow') await gate;
    return image;
  });
  try {
    await s.deploy('blog', stack);
    const shop = {
      services: {
        web: {
          image: 'slow',
          ports: ['9090:80'],
          'x-tug': {
            placement: { nodes: ['app'] },
            ingress: { host: 'claimed.example.org', port: 80 },
          },
        },
      },
    };
    const building = s.deploy('shop', shop);
    // The shop deployment passed the first ownership check and is waiting for its image.
    await new Promise((r) => setTimeout(r, 100));
    const added = await s.call('POST', '/api/v1/domains', {
      project: 'blog',
      service: 'web',
      host: 'claimed.example.org',
    });
    assert.equal(added.status, 200, 'the name is free while the shop deployment is only building');
    release();
    const result = await building;
    assert.equal(
      result.status,
      409,
      'publishing re-checks ownership, so two projects never both own the name',
    );
    assert.match(
      await result.text(),
      /already mapped as a domain of blog\/web/,
      'the reason names the owner',
    );
  } finally {
    release();
    await s.close();
  }
});

test('a mapped domain must be a plausible public name, and a wildcard domain round-trips', async () => {
  const s = await domainsServer();
  try {
    await s.deploy('blog', stack);
    const add = (host: string) =>
      s.call('POST', '/api/v1/domains', { project: 'blog', service: 'web', host });
    for (const [host, why] of [
      ['10.0.0.5', 'an IP address'],
      ['256.256.256.256', 'a dotted number'],
      [`${'a'.repeat(64)}.example.org`, 'a label over 63 characters'],
      [`${'a.'.repeat(130)}org`, 'a name over 253 characters'],
    ] as const)
      assert.equal((await add(host)).status, 400, `${why} is refused`);
    assert.equal((await add('*.network.example.org')).status, 200, 'a wildcard zone is accepted');
    assert.deepEqual(
      (await s.edgeWork()).routes[0].aliases,
      ['*.network.example.org'],
      'the zone is served on the route',
    );
    assert.equal(
      (await s.call('DELETE', '/api/v1/domains/*.network.example.org?project=blog')).status,
      200,
      'a wildcard host in the path is removable',
    );
  } finally {
    await s.close();
  }
});

test('a list of declared hosts is served and owned like single hosts, beside CLI-mapped domains', async () => {
  const s = await domainsServer();
  try {
    const listed = {
      services: {
        web: {
          image: 'nginx',
          ports: ['8080:80'],
          'x-tug': {
            placement: { nodes: ['app'] },
            ingress: { host: ['app.example.com', 'example.org'], port: 80 },
          },
        },
      },
    };
    const first = await s.deploy('blog', listed);
    assert.equal(first.status, 200, 'a deployment with a list of hosts is accepted');
    const added = await s.call('POST', '/api/v1/domains', {
      project: 'blog',
      service: 'web',
      host: 'mapped.example.net',
    });
    assert.equal(added.status, 200, 'a manually mapped domain is still accepted on such a route');
    const ingress = await s.edgeWork();
    assert.deepEqual(
      [ingress.routes[0].host, ingress.routes[0].hosts, ingress.routes[0].aliases],
      ['app.example.com', ['example.org'], ['mapped.example.net']],
      'declared names and CLI-mapped domains are both served on the route',
    );
    assert.match(
      ingress.caddyfile,
      /app\.example\.com, example\.org, mapped\.example\.net \{/,
      'one block serves all three',
    );
    for (const host of ['example.org', 'app.example.com'])
      assert.equal(
        (await s.call('POST', '/api/v1/domains', { project: 'blog', service: 'web', host })).status,
        409,
        `${host} is already declared in the list, so it cannot also be mapped`,
      );
    const other = await s.deploy('shop', {
      services: {
        web: {
          image: 'nginx',
          ports: ['9090:80'],
          'x-tug': {
            placement: { nodes: ['app'] },
            ingress: { host: ['shop.example.net', 'example.org'], port: 80 },
          },
        },
      },
    });
    assert.equal(
      other.status,
      409,
      "a second name in another project's list is refused when another project owns it",
    );
    assert.match(
      await other.text(),
      /example\.org .*already routed by project blog/,
      'the owner is named',
    );
  } finally {
    await s.close();
  }
});
