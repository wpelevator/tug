import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesiredState, composeForNode, crossNodeHosts, publishedPort, validateCompose } from './compose.ts';
import type { ComposeFile } from './protocol.ts';

test('builds per-node desired compose preserving service names', () => {
  const compose = { services: { web: { build: './web', environment: { A: 'B' }, volumes: ['web-data:/data'], 'x-tug': { placement: { nodes: ['n1'] } } }, db: { image: 'postgres:16', volumes: ['db-data:/data'], 'x-tug': { placement: { nodes: ['n2'] } } } }, volumes: { 'web-data': { 'x-tug': { placement: { nodes: ['n1'] } } }, 'db-data': { 'x-tug': { placement: { nodes: ['n2'] } } } } };
  const ds = buildDesiredState({ project: 'site', version: 'git-abc', compose, registry: 'reg:5000' });
  assert.equal(ds.services.web.image, 'reg:5000/site/web:git-abc');
  const c = composeForNode(ds, 'n1', { SECRET: 'x' });
  assert.deepEqual(Object.keys(c.services), ['web']);
  assert.equal(c.services.web.build, undefined);
  assert.equal(c.services.web['x-tug'], undefined);
  assert.deepEqual(c.services.web.env_file, ['.env']);
  assert.deepEqual(Object.keys(c.volumes!), ['web-data']);
});

test('rejects ambiguous multi-node services', () => {
  assert.throws(() => validateCompose({ services: { web: { image: 'nginx' } } }, ['n1', 'n2']), /placement/);
});

const ingressSvc = (ingress: unknown, ports: string[] = ['8080:80']) => ({ image: 'x', ports, 'x-tug': { placement: { nodes: ['n1'] }, ingress } }) as ComposeFile['services'][string];
const errorsFor = (svc: ComposeFile['services'][string]) => { try { validateCompose({ services: { web: svc } }); return ''; } catch (e) { return (e as Error).message; } };

test('publishedPort resolves container ports to host ports across Compose port syntaxes', () => {
  assert.equal(publishedPort({ ports: ['8080:80'] }, 80), 8080, 'short syntax, container port');
  assert.equal(publishedPort({ ports: ['8080:80'] }, 8080), 8080, 'short syntax, host port');
  assert.equal(publishedPort({ ports: ['127.0.0.1:9000:90/tcp'] }, 90), 9000, 'host IP and protocol are ignored');
  assert.equal(publishedPort({ ports: [{ target: 3000, published: 13000 }] }, 3000), 13000, 'long syntax');
  assert.equal(publishedPort({ ports: ['80'] }, 80), null, 'unpublished container port');
  assert.equal(publishedPort({}, 80), null, 'no ports');
});

test('validateCompose checks the x-tug.ingress annotation', () => {
  assert.equal(errorsFor(ingressSvc({ host: 'app.example.com', port: 80 })), '', 'minimal valid route');
  assert.equal(errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'off' })), '', 'tls off is valid');
  assert.equal(errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'custom', cert: 'C', key: 'K' })), '', 'custom with secrets is valid');
  assert.match(errorsFor(ingressSvc({ port: 80 })), /ingress\.host must be a fully qualified hostname/, 'host is required');
  assert.match(errorsFor(ingressSvc({ host: 'localhost', port: 80 })), /fully qualified/, 'single-label hosts are rejected');
  assert.match(errorsFor(ingressSvc({ host: 'app.example.com' })), /ingress\.port must be a port number/, 'port is required');
  assert.match(errorsFor(ingressSvc({ host: 'app.example.com', port: 99999 })), /port number/, 'port range is checked');
  assert.match(errorsFor(ingressSvc({ host: 'app.example.com', port: 80 }, [])), /must be published in ports/, 'the port must be published for the edge to reach it');
  assert.match(errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'magic' })), /tls must be auto, custom or off/, 'tls is an enum');
  assert.match(errorsFor(ingressSvc({ host: 'app.example.com', port: 80, tls: 'custom' })), /requires cert and key/, 'custom needs secret names');
  assert.throws(() => validateCompose({ services: { a: ingressSvc({ host: 'x.example.com', port: 80 }), b: ingressSvc({ host: 'X.example.com', port: 80 }) } }), /already used by a/, 'a host maps to one service');
});

test('composeForNode injects cross-node names as extra_hosts without touching local siblings', () => {
  const compose: ComposeFile = { services: {
    web: { image: 'w', extra_hosts: ['legacy:10.9.9.9'], 'x-tug': { placement: { nodes: ['n1'] } } },
    cache: { image: 'c', 'x-tug': { placement: { nodes: ['n1'] } } },
    db: { image: 'd', 'x-tug': { placement: { nodes: ['n2', 'n3'] } } }
  } };
  const ds = buildDesiredState({ project: 'blog', version: 'v1', compose, registry: 'reg' });
  const endpoints = { db: [{ node: 'n2', address: '10.210.0.2' }, { node: 'n3', address: '10.210.0.3' }], cache: [{ node: 'n1', address: '10.210.0.1' }] };
  const c = composeForNode(ds, 'n1', {}, endpoints);
  assert.deepEqual(c.services.web.extra_hosts as string[], ['legacy:10.9.9.9', 'db:10.210.0.2', 'db.blog.tug:10.210.0.2', 'db:10.210.0.3', 'db.blog.tug:10.210.0.3'], 'every serving replica gets a record, user entries are kept');
  assert.deepEqual(c.services.cache.extra_hosts, (c.services.web.extra_hosts as string[]).slice(1), 'local services resolve via Compose DNS, so cache is not mapped');
  assert.equal((composeForNode(ds, 'n1').services.web.extra_hosts as string[]).join(), 'legacy:10.9.9.9', 'without endpoints the compose file is unchanged');
  assert.deepEqual(crossNodeHosts('blog', {}, new Set()), [], 'no endpoints, no hosts');
  assert.equal((composeForNode(ds, 'n2', {}, { ...endpoints, web: [{ node: 'n1', address: '10.210.0.1' }] }).services.db.extra_hosts as string[]).includes('web:10.210.0.1'), true, 'the other direction resolves too');
});
