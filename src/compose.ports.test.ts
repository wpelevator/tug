import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressBoundServices,
  bindPort,
  bindPorts,
  buildDesiredState,
  composeForNode,
  hasHostIp,
  loopbackIngressServices,
  publishedPort,
} from './compose.ts';
import { remapPublishedPort, rollingCompose } from './rollout.ts';
import { isPublicAddress } from './util.ts';
import type { ComposeFile } from './protocol.ts';

test('bindPort binds short-syntax entries without a host IP and keeps ranges and protocols', () => {
  assert.equal(
    bindPort('8080:80', '10.210.0.2'),
    '10.210.0.2:8080:80',
    'a host:container mapping gets the bind address',
  );
  assert.equal(
    bindPort('5353:53/udp', '10.210.0.2'),
    '10.210.0.2:5353:53/udp',
    'the /udp suffix is kept',
  );
  assert.equal(
    bindPort('8000-8010:8000-8010', '10.210.0.2'),
    '10.210.0.2:8000-8010:8000-8010',
    'port ranges are kept',
  );
  assert.equal(
    bindPort('9000-9001:9000-9001/udp', '10.210.0.2'),
    '10.210.0.2:9000-9001:9000-9001/udp',
    'ranges with a protocol are kept',
  );
  assert.equal(
    bindPort('80', '10.210.0.2'),
    '10.210.0.2::80',
    'a container-only entry (random host port) is bound too',
  );
  assert.equal(
    bindPort(80, '10.210.0.2'),
    '10.210.0.2::80',
    'a numeric container-only entry is bound too',
  );
  assert.equal(
    bindPort('8080:80', 'fd00::2'),
    '[fd00::2]:8080:80',
    'an IPv6 bind address is bracketed',
  );
});

test('bindPort leaves entries that name a host IP exactly as written', () => {
  for (const entry of [
    '127.0.0.1:8080:80',
    '0.0.0.0:8080:80',
    '[::]:8080:80',
    '[::1]:8080:80/udp',
    '0.0.0.0::80',
    '203.0.113.5:8000-8010:8000-8010',
  ]) {
    assert.equal(hasHostIp(entry), true, `${entry} names a host IP`);
    assert.equal(
      bindPort(entry, '10.210.0.2'),
      entry,
      `${entry} is the operator's explicit choice and stays unchanged`,
    );
  }
  assert.deepEqual(
    bindPort({ target: 80, published: 8080, host_ip: '0.0.0.0' }, '10.210.0.2'),
    { target: 80, published: 8080, host_ip: '0.0.0.0' },
    'long syntax with host_ip 0.0.0.0 stays unchanged',
  );
});

test('bindPort adds host_ip to long-syntax entries without one', () => {
  assert.deepEqual(
    bindPort({ target: 53, published: '5353', protocol: 'udp' }, '10.210.0.2'),
    { target: 53, published: '5353', protocol: 'udp', host_ip: '10.210.0.2' },
    'host_ip is added and the other fields kept',
  );
  assert.deepEqual(
    bindPort({ target: 80 }, '127.0.0.1'),
    { target: 80, host_ip: '127.0.0.1' },
    'an entry without a published port is bound too',
  );
});

test('bindPorts puts only the ingress port on loopback', () => {
  assert.deepEqual(
    bindPorts(['8080:80', '9090:90', { target: 443, published: 8443 }], '10.0.0.5', 80),
    [
      '127.0.0.1:8080:80',
      '10.0.0.5:9090:90',
      { target: 443, published: 8443, host_ip: '10.0.0.5' },
    ],
    'the entry publishing the ingress port binds to 127.0.0.1 and the rest to the node address',
  );
  assert.deepEqual(
    bindPorts([{ target: 80, published: 8080 }], '10.0.0.5', 8080),
    [{ target: 80, published: 8080, host_ip: '127.0.0.1' }],
    'the ingress port may name the published side, in long syntax too',
  );
});

test('publishedPort still resolves ports that carry a host IP', () => {
  assert.equal(
    publishedPort({ ports: ['127.0.0.1:8080:80'] }, 80),
    8080,
    'container port resolves through a loopback binding',
  );
  assert.equal(
    publishedPort({ ports: ['[fd00::2]:8080:80'] }, 80),
    8080,
    'container port resolves through an IPv6 binding',
  );
});

const project = (services: ComposeFile['services']) =>
  buildDesiredState({ project: 'blog', version: 'v1', compose: { services }, registry: '' });
const web = (nodes: string[], extra: Record<string, unknown> = {}) => ({
  image: 'nginx',
  ports: ['8080:80'],
  'x-tug': { placement: { nodes }, ingress: { host: 'a.example.com', port: 80 } },
  ...extra,
});

test('loopbackIngressServices picks ingress services only the local Caddy reaches', () => {
  const single = project({
    web: web(['edge']),
    db: { image: 'db', ports: ['3306:3306'], 'x-tug': { placement: { nodes: ['edge'] } } },
  });
  assert.deepEqual(
    loopbackIngressServices(single, 'edge', ['edge'], ['edge', 'app']),
    ['web'],
    'a project wholly on the only ingress node puts its ingress service on loopback',
  );
  assert.deepEqual(
    loopbackIngressServices(single, 'edge', ['edge', 'edge2'], ['edge', 'edge2']),
    [],
    'another ingress node must reach the service over the network',
  );
  assert.deepEqual(
    loopbackIngressServices(single, 'app', ['edge'], ['edge', 'app']),
    [],
    'a node that is not the ingress node never uses loopback',
  );
  const split = project({
    web: web(['edge']),
    client: { image: 'c', 'x-tug': { placement: { nodes: ['app'] } } },
  });
  assert.deepEqual(
    loopbackIngressServices(split, 'edge', ['edge'], ['edge', 'app']),
    [],
    'a service of the project on another node may dial web through its service name',
  );
  const everywhere = project({ web: web([]) });
  assert.deepEqual(
    loopbackIngressServices(everywhere, 'edge', ['edge'], ['edge', 'app']),
    ['web'],
    'an unplaced service runs on every node; no other service exists, so only the local Caddy dials the edge copy',
  );
  const withWorker = project({
    web: web([]),
    worker: { image: 'w', 'x-tug': { placement: { nodes: ['app'] } } },
  });
  assert.deepEqual(
    loopbackIngressServices(withWorker, 'edge', ['edge'], ['edge', 'app']),
    ['web'],
    'a worker on app has its own copy of the unplaced web, so it does not need the edge copy',
  );
  const pinnedClient = project({ web: web(['edge']), worker: { image: 'w', 'x-tug': {} } });
  assert.deepEqual(
    loopbackIngressServices(pinnedClient, 'edge', ['edge'], ['edge', 'app']),
    [],
    'an unplaced client also runs on app, where it reaches web through the edge node address',
  );
});

test('composeForNode binds published ports and leaves them alone without a bind', () => {
  const ds = project({
    web: web(['n1']),
    db: {
      image: 'db',
      ports: ['3306:3306', '0.0.0.0:3307:3307'],
      'x-tug': { placement: { nodes: ['n1'] } },
    },
  });
  assert.deepEqual(
    composeForNode(ds, 'n1').services.db.ports,
    ['3306:3306', '0.0.0.0:3307:3307'],
    'without bind the ports are rendered as written',
  );
  const bound = composeForNode(ds, 'n1', {
    bind: { address: '10.210.0.4', loopback: new Set(['web']) },
  });
  assert.deepEqual(
    bound.services.db.ports,
    ['10.210.0.4:3306:3306', '0.0.0.0:3307:3307'],
    'unbound ports go to the node address and an explicit 0.0.0.0 is kept',
  );
  assert.deepEqual(
    bound.services.web.ports,
    ['127.0.0.1:8080:80'],
    'the loopback ingress port binds to 127.0.0.1',
  );
});

test('rolling revisions keep the bind address when their host port is remapped', () => {
  const ds = project({
    web: web(['n1'], {
      'x-tug': {
        placement: { nodes: ['n1'] },
        ingress: { host: 'a.example.com', port: 80 },
        health: { type: 'http', port: 80 },
        rollout: { strategy: 'rolling' },
      },
    }),
  });
  const full = composeForNode(ds, 'n1', { bind: { address: '10.210.0.4' } });
  assert.deepEqual(
    rollingCompose(full, 'blog', 'web', 20003).services.web.ports,
    ['10.210.0.4:20003:80'],
    'the revision port is published on the overlay address',
  );
  assert.deepEqual(
    remapPublishedPort(['127.0.0.1:8080:80/tcp'], 20001),
    ['127.0.0.1:20001:80/tcp'],
    'a loopback short-syntax entry keeps its host IP and protocol',
  );
  assert.deepEqual(
    remapPublishedPort([{ target: 80, published: 8080, host_ip: '10.0.0.5' }], 20001),
    [{ target: 80, published: 20001, host_ip: '10.0.0.5' }],
    'long syntax keeps host_ip',
  );
});

test('addressBoundServices names services with ports on the node address', () => {
  const compose: ComposeFile = {
    services: {
      web: web(['n1']),
      db: { image: 'db', ports: ['3306:3306'] },
      admin: { image: 'a', ports: ['0.0.0.0:81:80'] },
      worker: { image: 'w' },
    },
  };
  assert.deepEqual(
    addressBoundServices(compose, ['web', 'db', 'admin', 'worker']),
    ['db', 'web'],
    'services with unbound ports are named; explicit host IPs and portless services are not',
  );
  assert.deepEqual(
    addressBoundServices(compose, ['web', 'db'], new Set(['web'])),
    ['db'],
    'a service whose only port is on loopback is not',
  );
});

test('isPublicAddress separates internet-routable addresses from private ones', () => {
  for (const ip of [
    '203.0.113.5',
    '8.8.8.8',
    '0.0.0.0',
    '::',
    '2001:db8::1',
    '[2a01:4f8::1]',
    '172.32.0.1',
  ])
    assert.equal(
      isPublicAddress(ip),
      true,
      `${ip} is reachable from the internet (or means every interface)`,
    );
  for (const ip of [
    '10.210.0.2',
    '127.0.0.1',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.5',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    'fd00::2',
    'fe80::1',
    '::ffff:10.0.0.1',
    'node1.example.com',
  ])
    assert.equal(isPublicAddress(ip), false, `${ip} is not a public address`);
});
