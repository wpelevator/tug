import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesiredState,
  crossNodeHosts,
  publishedPort,
  serviceSecretNames,
  serviceSecretVersions,
  validateCompose,
} from './compose.ts';
import { containerSpecs } from './container-spec.ts';
import { normalized } from '../tests/fake-docker.ts';
import type { ComposeFile } from './protocol.ts';

test('builds per-node desired compose preserving service names', () => {
  const compose = {
    services: {
      web: {
        build: './web',
        environment: { A: 'B' },
        volumes: ['web-data:/data'],
        'x-tug': { placement: { nodes: ['n1'] } },
      },
      db: {
        image: 'postgres:16',
        volumes: ['db-data:/data'],
        'x-tug': { placement: { nodes: ['n2'] } },
      },
    },
    volumes: {
      'web-data': { 'x-tug': { placement: { nodes: ['n1'] } } },
      'db-data': { 'x-tug': { placement: { nodes: ['n2'] } } },
    },
  };
  const ds = buildDesiredState({
    project: 'site',
    version: 'git-abc',
    compose: normalized(compose),
    registry: 'reg:5000',
  });
  assert.equal(ds.services.web.image, 'reg:5000/site/web:git-abc');
  const plan = containerSpecs(ds, 'n1');
  assert.deepEqual(Object.keys(plan.specs), ['web']);
  assert.equal(
    plan.specs.web.body.Image,
    'reg:5000/site/web:git-abc',
    'a built service runs the image reference control assigned',
  );
  assert.deepEqual(
    plan.volumes.map((v) => v.name),
    ['tug_site_web-data'],
    'only the volumes this node uses are created',
  );
});

test('rejects ambiguous multi-node services', () => {
  assert.throws(
    () => validateCompose({ services: { web: { image: 'nginx' } } }, ['n1', 'n2']),
    /placement/,
  );
});

const ingressSvc = (ingress: unknown, ports: string[] = ['8080:80']) =>
  ({
    image: 'x',
    ports,
    'x-tug': { placement: { nodes: ['n1'] }, ingress },
  }) as ComposeFile['services'][string];
const errorsFor = (svc: ComposeFile['services'][string]) => {
  try {
    validateCompose({ services: { web: svc } });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

test('publishedPort resolves container ports to host ports across Compose port syntaxes', () => {
  assert.equal(publishedPort({ ports: ['8080:80'] }, 80), 8080, 'short syntax, container port');
  assert.equal(publishedPort({ ports: ['8080:80'] }, 8080), 8080, 'short syntax, host port');
  assert.equal(
    publishedPort({ ports: ['127.0.0.1:9000:90/tcp'] }, 90),
    9000,
    'host IP and protocol are ignored',
  );
  assert.equal(
    publishedPort({ ports: [{ target: 3000, published: 13000 }] }, 3000),
    13000,
    'long syntax',
  );
  assert.equal(publishedPort({ ports: ['80'] }, 80), null, 'unpublished container port');
  assert.equal(publishedPort({}, 80), null, 'no ports');
});

test('validateCompose checks the x-tug.ingress annotation', () => {
  assert.equal(
    errorsFor(ingressSvc({ host: 'app.example.com', port: 80 })),
    '',
    'minimal valid route',
  );
  assert.equal(
    errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'off' })),
    '',
    'tls off is valid',
  );
  assert.equal(
    errorsFor(
      ingressSvc({ host: 'app.example.com', port: 80, tls: 'custom', cert: 'C', key: 'K' }),
    ),
    '',
    'custom with secrets is valid',
  );
  assert.match(
    errorsFor(ingressSvc({ port: 80 })),
    /ingress\.host must be a fully qualified hostname/,
    'host is required',
  );
  assert.match(
    errorsFor(ingressSvc({ host: 'localhost', port: 80 })),
    /fully qualified/,
    'single-label hosts are rejected',
  );
  assert.match(
    errorsFor(ingressSvc({ host: 'app.example.com' })),
    /ingress\.port must be a port number/,
    'port is required',
  );
  assert.match(
    errorsFor(ingressSvc({ host: 'app.example.com', port: 99999 })),
    /port number/,
    'port range is checked',
  );
  assert.match(
    errorsFor(ingressSvc({ host: 'app.example.com', port: 80 }, [])),
    /must be published in ports/,
    'the port must be published for the edge to reach it',
  );
  assert.match(
    errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'magic' })),
    /tls must be auto, custom or off/,
    'tls is an enum',
  );
  assert.match(
    errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'custom' })),
    /requires cert and key/,
    'custom needs secret names',
  );
  assert.throws(
    () =>
      validateCompose({
        services: {
          a: ingressSvc({ host: 'x.example.com', port: 80 }),
          b: ingressSvc({ host: 'X.example.com', port: 80 }),
        },
      }),
    /already used by a/,
    'a host maps to one service',
  );
});

test('containerSpecs injects cross-node names as extra hosts without touching local siblings', () => {
  const compose: ComposeFile = {
    services: {
      web: {
        image: 'w',
        extra_hosts: { legacy: '10.9.9.9' },
        'x-tug': { placement: { nodes: ['n1'] } },
      },
      cache: { image: 'c', 'x-tug': { placement: { nodes: ['n1'] } } },
      db: { image: 'd', 'x-tug': { placement: { nodes: ['n2', 'n3'] } } },
    },
  };
  const ds = buildDesiredState({ project: 'blog', version: 'v1', compose, registry: 'reg' });
  const endpoints = {
    db: [
      { node: 'n2', address: '10.210.0.2' },
      { node: 'n3', address: '10.210.0.3' },
    ],
    cache: [{ node: 'n1', address: '10.210.0.1' }],
  };
  const hosts = (plan: ReturnType<typeof containerSpecs>, service: string) =>
    plan.specs[service].body.HostConfig?.ExtraHosts as string[] | undefined;
  const plan = containerSpecs(ds, 'n1', { endpoints });
  assert.deepEqual(
    hosts(plan, 'web'),
    [
      'legacy:10.9.9.9',
      'db:10.210.0.2',
      'db.blog.tug:10.210.0.2',
      'db:10.210.0.3',
      'db.blog.tug:10.210.0.3',
    ],
    'every serving replica gets a record, user entries are kept',
  );
  assert.deepEqual(
    hosts(plan, 'cache'),
    hosts(plan, 'web')!.slice(1),
    'local services resolve through the network alias, so cache is not mapped',
  );
  assert.deepEqual(
    hosts(containerSpecs(ds, 'n1'), 'web'),
    ['legacy:10.9.9.9'],
    'without endpoints only the declared hosts remain',
  );
  assert.deepEqual(crossNodeHosts('blog', {}, new Set()), [], 'no endpoints, no hosts');
  assert.equal(
    hosts(
      containerSpecs(ds, 'n2', {
        endpoints: { ...endpoints, web: [{ node: 'n1', address: '10.210.0.1' }] },
      }),
      'db',
    )?.includes('web:10.210.0.1'),
    true,
    'the other direction resolves too',
  );
});

test('validateCompose accepts label and global placement without explicit nodes', () => {
  const nodes = ['n1', 'n2'];
  assert.equal(
    validateCompose(
      { services: { web: { image: 'nginx', 'x-tug': { placement: { labels: ['app'] } } } } },
      nodes,
    ),
    undefined,
    'label placement should be valid',
  );
  assert.equal(
    validateCompose({ services: { web: { image: 'nginx', 'x-tug': { global: true } } } }, nodes),
    undefined,
    'global mode should be valid',
  );
});

test('buildDesiredState resolves label placement when nodes are provided', () => {
  const compose = {
    services: { web: { image: 'nginx', 'x-tug': { placement: { labels: ['app'] }, replicas: 1 } } },
  };
  const ds = buildDesiredState({
    project: 'site',
    version: 'v1',
    compose,
    registry: 'reg',
    nodes: [
      { name: 'n1', labels: ['app'] },
      { name: 'n2', labels: ['db'] },
    ],
  });
  assert.deepEqual(
    ds.services.web.placement.nodes,
    ['n1'],
    'only matching nodes should be selected',
  );
});

test('buildDesiredState global mode selects every matching node', () => {
  const compose = {
    services: {
      web: { image: 'nginx', 'x-tug': { placement: { labels: ['app'] }, global: true } },
    },
  };
  const ds = buildDesiredState({
    project: 'site',
    version: 'v1',
    compose,
    registry: 'reg',
    nodes: [
      { name: 'n1', labels: ['app'] },
      { name: 'n2', labels: ['app'] },
    ],
  });
  assert.deepEqual(
    ds.services.web.placement.nodes,
    ['n1', 'n2'],
    'global mode should select all matching nodes',
  );
});

test('containerSpecs generates an NFS volume on consuming nodes', () => {
  const compose = normalized({
    services: {
      web: {
        image: 'nginx',
        volumes: ['shared:/data'],
        'x-tug': { placement: { nodes: ['n1', 'n2'] } },
      },
    },
    volumes: { shared: { 'x-tug': { type: 'nfs', placement: { nodes: ['n1'] } } } },
  });
  const ds = buildDesiredState({ project: 'site', version: 'v1', compose, registry: 'reg' });
  const consumer = containerSpecs(ds, 'n2', { nodeAddresses: { n1: '10.0.0.1' } });
  const opts = consumer.volumes[0].opts;
  assert.equal(consumer.volumes[0].name, 'tug_site_shared', 'volumes carry the Tug name');
  assert.equal(opts.type, 'nfs', 'consumers should get an nfs-typed volume');
  assert.equal(opts.device, ':/srv/tug/shared', 'nfs device should be the default export path');
  assert.match(opts.o, /addr=10\.0\.0\.1/, 'consumers should mount the exporter address');
  assert.deepEqual(
    consumer.specs.web.body.HostConfig?.Binds,
    ['tug_site_shared:/data'],
    'the container mounts the Tug-named volume',
  );
  const exporter = containerSpecs(ds, 'n1');
  assert.equal(
    exporter.volumes[0].opts.o,
    'bind',
    'exporter should bind-mount the exported directory',
  );
  assert.equal(exporter.volumes[0].opts.device, '/srv/tug/shared');
});

// ---- supported subset ----------------------------------------------------------------------------

const subset = (svc: Record<string, unknown>, extra: Partial<ComposeFile> = {}) => {
  try {
    validateCompose({ services: { web: { image: 'x', ...svc } }, ...extra } as ComposeFile);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

test('validateCompose accepts what docker compose config emits for the supported keys', () => {
  const emitted = {
    name: 'blog',
    networks: { default: { name: 'blog_default', ipam: {} } },
    volumes: { data: { name: 'blog_data', driver: 'local' } },
    'x-shared': { anchors: 'are fine' },
    services: {
      web: {
        image: 'nginx',
        networks: { default: null },
        command: ['nginx', '-g', 'daemon off;'],
        environment: { A: '1' },
        ports: [{ mode: 'ingress', target: 80, published: '8080', protocol: 'tcp' }],
        volumes: [
          { type: 'volume', source: 'data', target: '/data', volume: {} },
          {
            type: 'bind',
            source: '/srv/assets',
            target: '/assets',
            bind: { create_host_path: true },
          },
          { type: 'tmpfs', target: '/run' },
        ],
        depends_on: { db: { condition: 'service_healthy', required: true } },
        healthcheck: { test: ['CMD', 'true'], interval: '10s' },
        restart: 'unless-stopped',
        mem_limit: '134217728',
        cpus: 0.5,
        ulimits: { nofile: { soft: 1024, hard: 2048 } },
        logging: { driver: 'json-file' },
        pull_policy: 'always',
        'x-tug': { placement: { nodes: ['n1'] } },
      },
      db: { image: 'postgres', networks: { default: null } },
    },
  };
  assert.doesNotThrow(
    () => validateCompose(emitted as unknown as ComposeFile),
    'the default name, default-only networks, pull_policy and every supported key pass',
  );
});

test('validateCompose rejects unsupported keys and names the key', () => {
  for (const key of [
    'network_mode',
    'privileged',
    'devices',
    'pid',
    'ipc',
    'security_opt',
    'sysctls',
    'secrets',
    'configs',
    'env_file',
    'links',
    'dns',
    'container_name',
  ])
    assert.match(
      subset({ [key]: key === 'privileged' ? true : ['x'] }),
      new RegExp(`web: ${key} is not supported`),
      `${key} is rejected by name`,
    );
  assert.match(subset({ deploy: { replicas: 2 } }), /deploy \(swarm\) is not supported/);
});

test('validateCompose rejects custom networks, unnamed volumes, relative binds and odd dependencies', () => {
  assert.match(
    subset({ networks: { backend: null } }),
    /networks other than the default network are not supported/,
  );
  assert.match(
    subset({ network_mode: 'host' }),
    /network_mode is not supported/,
    'host networking is not available until a use case needs it',
  );
  assert.match(
    subset({}, { networks: { backend: {} } } as Partial<ComposeFile>),
    /networks\.backend: custom networks are not supported/,
  );
  assert.match(
    subset({ volumes: [{ type: 'bind', source: './data', target: '/d' }] }),
    /bind mount source "\.\/data" must be an absolute path/,
  );
  assert.match(
    subset({ volumes: [{ type: 'volume', target: '/d' }] }),
    /anonymous volumes are not supported/,
  );
  assert.match(
    subset({ volumes: [{ type: 'volume', source: 'ghost', target: '/d' }] }),
    /volume ghost is not defined/,
  );
  assert.match(
    subset({ volumes: ['data:/d'] }),
    /must be normalized by docker compose config/,
    'short syntax means the file did not go through the CLI',
  );
  assert.match(
    subset({ depends_on: { db: { condition: 'service_completed_successfully' } } }),
    /depends_on db is not a service/,
  );
  assert.match(subset({ image: undefined, build: undefined }), /image or build is required/);
  assert.match(
    subset({}, { secrets: { s: {} } } as Partial<ComposeFile>),
    /secrets is not supported at the top level/,
  );
  assert.match(
    subset({}, { volumes: { data: { external: true, bogus: 1 } } } as Partial<ComposeFile>),
    /volumes\.data: bogus is not supported/,
  );
});

test('secrets are the sentinels a service references', () => {
  const compose = {
    services: {
      web: {
        image: 'x',
        environment: { A: '@@tug:secret:API_KEY@@', B: 'x@@tug:secret:DB_PASS@@y' },
      },
      worker: { image: 'x', environment: { C: 'plain' } },
    },
  } as unknown as ComposeFile;
  assert.deepEqual([...serviceSecretNames(compose, ['web'])].sort(), ['API_KEY', 'DB_PASS']);
  assert.deepEqual(serviceSecretVersions(compose, ['web', 'worker'], { API_KEY: 3, OTHER: 9 }), {
    web: { API_KEY: 3 },
    worker: {},
  });
});
