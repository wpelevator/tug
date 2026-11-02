import test from 'node:test';
import assert from 'node:assert/strict';
import { privilegedComposeFeatures } from './deployment-policy.ts';
import type { ComposeFile } from './protocol.ts';

const features = (service: Record<string, unknown>, volumes: ComposeFile['volumes'] = {}) =>
  privilegedComposeFeatures({ services: { app: { image: 'example', ...service } }, volumes });
test('ordinary local volumes and default logging do not require administrator privileges', () => {
  assert.deepEqual(
    features(
      {
        volumes: [{ type: 'volume', source: 'data', target: '/data' }],
        logging: { driver: 'json-file' },
      },
      { data: {} },
    ),
    [],
    'ordinary named volumes and default logging must remain available',
  );
});
test('host-sensitive workloads require administrator privileges', () => {
  const cases: [Record<string, unknown>, ComposeFile['volumes'], string][] = [
    [{ volumes: [{ type: 'bind', source: '/', target: '/host' }] }, {}, 'host bind'],
    [
      { volumes: [{ type: 'volume', source: 'data', target: '/data' }] },
      { data: { external: true } },
      'external volume',
    ],
    [
      { volumes: [{ type: 'volume', source: 'data', target: '/data' }] },
      { data: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/' } } },
      'driver options',
    ],
    [
      { volumes: [{ type: 'volume', source: 'data', target: '/data' }] },
      { data: { driver: 'plugin' } },
      'volume driver',
    ],
    [{ cap_add: ['SYS_ADMIN'] }, {}, 'added capabilities'],
    [{ logging: { driver: 'syslog' } }, {}, 'logging driver'],
    [{ logging: { options: { env: 'SECRET' } } }, {}, 'logging options'],
    [
      { volumes: [{ type: 'volume', source: '@@tug:secret:OTHER@@', target: '/data' }] },
      { '@@tug:secret:OTHER@@': {} },
      'secrets',
    ],
  ];
  for (const [service, volumes, expected] of cases)
    assert.ok(
      features(service, volumes).some((value) => value.includes(expected)),
      `${expected} must require administrator privileges`,
    );
});
