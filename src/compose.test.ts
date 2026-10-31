import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesiredState, composeForNode, validateCompose } from './compose.ts';

test('builds per-node desired compose preserving service names', () => {
  const compose = { services: { web: { build: './web', environment: { A: 'B' }, volumes: ['web-data:/data'], 'x-launchpad': { placement: { nodes: ['n1'] } } }, db: { image: 'postgres:16', volumes: ['db-data:/data'], 'x-launchpad': { placement: { nodes: ['n2'] } } } }, volumes: { 'web-data': { 'x-launchpad': { placement: { nodes: ['n1'] } } }, 'db-data': { 'x-launchpad': { placement: { nodes: ['n2'] } } } } };
  const ds = buildDesiredState({ project: 'site', version: 'git-abc', compose, registry: 'reg:5000' });
  assert.equal(ds.services.web.image, 'reg:5000/site/web:git-abc');
  const c = composeForNode(ds, 'n1', { SECRET: 'x' });
  assert.deepEqual(Object.keys(c.services), ['web']);
  assert.equal(c.services.web.build, undefined);
  assert.equal(c.services.web['x-launchpad'], undefined);
  assert.deepEqual(c.services.web.env_file, ['.env']);
  assert.deepEqual(Object.keys(c.volumes!), ['web-data']);
});

test('rejects ambiguous multi-node services', () => {
  assert.throws(() => validateCompose({ services: { web: { image: 'nginx' } } }, ['n1', 'n2']), /placement/);
});
