import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { testImageResolver, testControlUrl, testIdentity } from '../tests/helpers.ts';
import { createCsr, generateKeyPair } from './pki.ts';
import { json } from '../tests/helpers.ts';

const NETWORK_ENV = ['TUG_SERVICE_NAMES', 'TUG_ACME_EMAIL'];

async function server(env: Record<string, string> = {}) {
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
    images: { resolve: testImageResolver },
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
