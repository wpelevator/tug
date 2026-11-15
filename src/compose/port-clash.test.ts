import test from 'node:test';
import assert from 'node:assert/strict';
import { findPortClashes, hostPortUses, portClashMessage } from './port-clash.ts';
import { buildDesiredState } from './compose.ts';
import type { ComposeFile, ComposeService } from '../protocol.ts';

const topology = { nodes: ['n1', 'n2'], ingressNodes: [] as string[] };
const address = (node: string) => (node === 'n1' ? '10.50.0.4' : '10.50.0.5');

function state(project: string, services: Record<string, ComposeService>) {
  return buildDesiredState({
    project,
    version: 'v1',
    compose: { services } as ComposeFile,
    defaultNode: 'n1',
  });
}

const web = (ports: unknown[], extra: Record<string, unknown> = {}, node = 'n1') =>
  ({
    image: 'nginx',
    ports,
    'x-tug': { placement: { nodes: [node] }, ...extra },
  }) as ComposeService;

test('two projects publishing 8080 on one node address clash, naming node, address, port and the other project', () => {
  const clashes = findPortClashes(
    state('laravel', { web: web(['8080:80']) }),
    [state('phpdb', { web: web(['8080:80']) })],
    topology,
    address,
  );
  assert.equal(clashes.length, 1, 'one clash is found');
  assert.deepEqual(
    [clashes[0].node, clashes[0].address, clashes[0].port, clashes[0].otherProject],
    ['n1', '10.50.0.4', 8080, 'phpdb'],
    'the clash names the node, the address, the port and the other project',
  );
  assert.match(
    portClashMessage(clashes[0], 'phpdb'),
    /web: host port 8080 on node n1 \(10\.50\.0\.4\) is already published by web in project phpdb/,
    'the message says who holds the port',
  );
  assert.doesNotMatch(
    portClashMessage(clashes[0], 'another project'),
    /phpdb/,
    'a viewer who cannot see the other project does not learn its name',
  );
});

test('a project redeploying its own port is not a clash', () => {
  const clashes = findPortClashes(
    state('phpdb', { web: web(['8080:80']) }),
    [state('phpdb', { web: web(['8080:80']) })],
    topology,
    address,
  );
  assert.deepEqual(clashes, [], 'the same project replaces its own deployment');
});

test('the same port on different nodes, a different port, or a different protocol does not clash', () => {
  const mine = state('a', { web: web(['8080:80']) });
  assert.deepEqual(
    findPortClashes(mine, [state('b', { web: web(['8080:80'], {}, 'n2') })], topology, address),
    [],
    'another node is another address space',
  );
  assert.deepEqual(
    findPortClashes(mine, [state('b', { web: web(['8081:80']) })], topology, address),
    [],
    'another host port is free',
  );
  assert.deepEqual(
    findPortClashes(mine, [state('b', { web: web(['8080:80/udp']) })], topology, address),
    [],
    'tcp and udp are separate port spaces',
  );
});

test('a loopback bind and a private-address bind of one port do not clash, a wildcard bind clashes with both', () => {
  const mine = state('a', { web: web(['8080:80']) });
  assert.deepEqual(
    findPortClashes(mine, [state('b', { web: web(['127.0.0.1:8080:80']) })], topology, address),
    [],
    'loopback and 10.50.0.4 are different listen addresses',
  );
  assert.equal(
    findPortClashes(mine, [state('b', { web: web(['0.0.0.0:8080:80']) })], topology, address)
      .length,
    1,
    'a bind on every address overlaps the private address',
  );
  assert.equal(
    findPortClashes(
      state('a', { web: web([{ target: 80, published: 8080, host_ip: '127.0.0.1' }]) }),
      [state('b', { web: web(['127.0.0.1:8080:80']) })],
      topology,
      address,
    ).length,
    1,
    'long syntax and short syntax naming the same loopback address clash',
  );
});

test('a rolling service publishes no declared host port, and container-only entries never clash', () => {
  const rolling = web(['8080:80'], {
    rollout: { strategy: 'rolling' },
    ingress: { host: 'a.example.com', port: 80 },
    health: { path: '/' },
  });
  assert.deepEqual(
    hostPortUses('web', rolling, '10.50.0.4', false),
    [],
    'a rolling service gets ports from its own range at runtime',
  );
  assert.deepEqual(
    findPortClashes(
      state('a', { web: web(['80', '127.0.0.1::80']) }),
      [state('b', { web: web(['80']) })],
      topology,
      address,
    ),
    [],
    'a container port with no host port is numbered by Docker',
  );
});

test('host port ranges clash on any shared port, and the ingress port of a loopback-only service stays on 127.0.0.1', () => {
  const clashes = findPortClashes(
    state('a', { web: web(['9000-9002:9000-9002']) }),
    [state('b', { web: web(['9002:80']) })],
    topology,
    address,
  );
  assert.deepEqual(
    clashes.map((c) => c.port),
    [9002],
    'only the shared port of the range clashes',
  );
  const ingress = web(['8080:80'], { ingress: { host: 'a.example.com', port: 80 } });
  const single = { nodes: ['n1'], ingressNodes: ['n1'] };
  assert.deepEqual(
    findPortClashes(
      state('a', { web: ingress }),
      [state('b', { web: web(['8080:80']) })],
      single,
      address,
    ),
    [],
    'the sole ingress node serves a with its port on loopback, so b on 10.50.0.4 does not clash',
  );
});
