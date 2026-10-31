import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesiredState } from './compose.ts';
import { composeDurationMs, containerSpecs, sizeBytes, startOrder } from './container-spec.ts';
import { normalized } from '../tests/fake-docker.ts';
import type { ComposeFile } from './protocol.ts';

const place = { 'x-tug': { placement: { nodes: ['n1'] } } };
const plan = (compose: ComposeFile, opts = {}, version = 'v1') =>
  containerSpecs(
    buildDesiredState({ project: 'p', version, compose: normalized(compose), registry: '' }),
    'n1',
    opts,
  );

test('the config hash ignores the deployment revision but follows definition and secret versions', () => {
  const c: ComposeFile = {
    services: { web: { image: 'x', environment: { K: '@@tug:secret:K@@' }, ...place } },
  };
  const a = plan(c, { secretVersions: { K: 1 } }, 'v1').specs.web;
  assert.equal(plan(c, { secretVersions: { K: 1 } }, 'v2').specs.web.hash, a.hash);
  assert.notEqual(plan(c, { secretVersions: { K: 2 } }).specs.web.hash, a.hash);
  assert.notEqual(
    plan({ services: { web: { ...c.services.web, image: 'y' } } }).specs.web.hash,
    a.hash,
  );
  assert.equal(a.name, `tug-p-web-${a.hash.slice(0, 8)}`);
});

test('definitions map to Engine API fields', () => {
  const { specs } = plan({
    services: {
      web: {
        image: 'x',
        command: ['run'],
        mem_limit: '134217728',
        cpus: 0.5,
        restart: 'on-failure:3',
        healthcheck: { test: ['CMD', 'true'], interval: '1m30s', retries: 2 },
        stop_grace_period: '20s',
        ulimits: { nofile: { soft: 1, hard: 2 } },
        ...place,
      },
    },
  });
  const b = specs.web.body;
  assert.deepEqual(b.Cmd, ['run']);
  assert.equal(b.HostConfig?.Memory, 134217728);
  assert.equal(b.HostConfig?.NanoCpus, 500000000);
  assert.deepEqual(b.HostConfig?.RestartPolicy, { Name: 'on-failure', MaximumRetryCount: 3 });
  assert.deepEqual(b.Healthcheck, { Test: ['CMD', 'true'], Interval: 90e9, Retries: 2 });
  assert.equal(b.StopTimeout, 20);
  assert.deepEqual(b.HostConfig?.Ulimits, [{ Name: 'nofile', Soft: 1, Hard: 2 }]);
  assert.equal(
    b.Cmd !== undefined && b.Entrypoint === undefined,
    true,
    'unset entrypoint keeps the image default',
  );
});

test('startOrder puts dependencies first and rejects cycles; parsers handle units', () => {
  const s = plan({
    services: { a: { image: 'a', depends_on: ['b'], ...place }, b: { image: 'b', ...place } },
  }).specs;
  assert.deepEqual(startOrder(s), ['b', 'a']);
  assert.equal(composeDurationMs('1m30s'), 90000);
  assert.equal(composeDurationMs('500ms'), 500);
  assert.equal(sizeBytes('64m'), 64 * 1024 * 1024);
  assert.equal(sizeBytes('1g'), 1024 ** 3);
});
