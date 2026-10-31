import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompose } from './compose.ts';
import type { ComposeFile } from './protocol.ts';

type Service = ComposeFile['services'][string];
const errorsFor = (svc: Service) => {
  try {
    validateCompose({ services: { web: svc } });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};
const rollingSvc = (rollout: unknown, extra: Record<string, unknown> = {}) =>
  ({
    image: 'x',
    ports: ['8080:80'],
    'x-tug': {
      placement: { nodes: ['n1'] },
      health: { type: 'http', port: 80 },
      ingress: { host: 'a.example.com', port: 80 },
      rollout,
      ...extra,
    },
  }) as Service;

test('x-tug.rollout accepts recreate and rolling and validates what rolling needs', () => {
  assert.equal(
    errorsFor(rollingSvc({ strategy: 'rolling', drain: '30s' })),
    '',
    'a complete rolling service validates',
  );
  assert.equal(
    errorsFor(rollingSvc({ strategy: 'rolling', drain: 500 })),
    '',
    'drain accepts a millisecond number',
  );
  assert.equal(errorsFor(rollingSvc({ strategy: 'recreate' })), '', 'recreate is always valid');
  assert.equal(
    errorsFor({ image: 'x', 'x-tug': { rollout: { strategy: 'recreate' } } } as Service),
    '',
    'recreate needs no ingress',
  );
  assert.match(
    errorsFor(rollingSvc({ strategy: 'blue-green' })),
    /rollout\.strategy must be recreate or rolling/,
    'unknown strategies are rejected',
  );
  assert.match(
    errorsFor(rollingSvc({ strategy: 'rolling', drain: 'soon' })),
    /rollout\.drain must be a duration/,
    'a bad drain is rejected',
  );
  assert.match(
    errorsFor(rollingSvc({ strategy: 'rolling', maxSurge: 2 })),
    /rollout\.maxSurge is not supported/,
    'unsupported keys are named',
  );
  assert.match(
    errorsFor(rollingSvc('rolling')),
    /rollout must be an object/,
    'the rollout block must be an object',
  );
  assert.match(
    errorsFor(rollingSvc({ strategy: 'rolling' }, { ingress: undefined })),
    /requires x-tug\.ingress/,
    'rolling needs an ingress to switch traffic',
  );
  assert.match(
    errorsFor(rollingSvc({ strategy: 'rolling' }, { health: undefined })),
    /requires x-tug\.health/,
    'rolling needs a health check',
  );
  const twoPorts = rollingSvc({ strategy: 'rolling' });
  twoPorts.ports = ['8080:80', '9090:90'];
  assert.match(
    errorsFor(twoPorts),
    /exactly one entry in ports/,
    'rolling services publish only the ingress port',
  );
});

test('x-tug.rollback is validated at the top level', () => {
  const services = { web: { image: 'x' } };
  assert.doesNotThrow(
    () => validateCompose({ services, 'x-tug': { rollback: 'auto' } }),
    'auto is accepted',
  );
  assert.doesNotThrow(
    () => validateCompose({ services, 'x-tug': { rollback: 'manual' } }),
    'manual is accepted',
  );
  assert.throws(
    () => validateCompose({ services, 'x-tug': { rollback: 'always' as 'auto' } }),
    /x-tug\.rollback must be auto or manual/,
    'other values are rejected',
  );
  assert.throws(
    () => validateCompose({ services, 'x-tug': { surprise: true } as ComposeFile['x-tug'] }),
    /x-tug\.surprise is not supported/,
    'unknown project options are rejected',
  );
});
