import test from 'node:test';
import assert from 'node:assert/strict';
import {
  privilegedComposeFeatures,
  parseProjectPolicy,
  projectPolicyViolations,
} from './deployment-policy.ts';
import { buildDesiredState } from './compose.ts';
import type { ComposeFile } from './protocol.ts';

const features = (service: Record<string, unknown>, volumes: ComposeFile['volumes'] = {}) =>
  privilegedComposeFeatures({ services: { app: { image: 'example', ...service } }, volumes });

test('project grants reject malformed input and normalize explicit names', () => {
  assert.throws(
    () => parseProjectPolicy({ nodes: ['n1'], ingressHosts: [], admin: true }),
    /unknown/,
    'policy must reject injected fields',
  );
  assert.throws(
    () => parseProjectPolicy({ nodes: ['bad name'], ingressHosts: [] }),
    /nodes/,
    'policy must reject invalid node names',
  );
  assert.throws(
    () => parseProjectPolicy({ nodes: [], ingressHosts: ['*'] }),
    /ingressHosts/,
    'policy must reject unbounded hostname grants',
  );
  assert.deepEqual(
    parseProjectPolicy({
      nodes: ['n2', 'n1', 'n2'],
      ingressHosts: ['*.EXAMPLE.COM', '*.example.com'],
    }),
    { nodes: ['n1', 'n2'], ingressHosts: ['*.example.com'] },
    'grants must be normalized and deduplicated',
  );
});

test('project grants check concrete placement and do not grant wildcard apexes', () => {
  const compose: ComposeFile = {
    services: {
      web: {
        image: 'web',
        'x-tug': { placement: { nodes: ['n1'] }, ingress: { host: 'app.example.com', port: 80 } },
      },
    },
  };
  const desired = buildDesiredState({ project: 'site', version: 'v1', compose });
  const policy = parseProjectPolicy({ nodes: ['n1'], ingressHosts: ['*.example.com'] });
  assert.deepEqual(
    projectPolicyViolations(policy, desired),
    [],
    'the explicit node and matching subdomain must be granted',
  );
  desired.services.web.placement.nodes = [];
  assert.match(
    projectPolicyViolations(policy, desired).join(' '),
    /no fixed node placement/,
    'implicit placement must be resolved before publication',
  );
  desired.compose.services.web['x-tug']!.ingress!.host = 'example.com';
  assert.match(
    projectPolicyViolations(policy, desired).join(' '),
    /example.com is not granted/,
    'wildcard grants must not include the apex hostname',
  );
});
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
