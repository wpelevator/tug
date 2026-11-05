import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { Ajv } from 'ajv';
import { xTugSchema, SCHEMA_URL } from './x-tug-schema.ts';
import {
  SERVICE_EXTENSION_KEYS,
  SUPPORTED_SERVICE_KEYS,
  SUPPORTED_VOLUME_KEYS,
  VOLUME_EXTENSION_KEYS,
} from './compose.ts';
import { RETENTION_KEYS, SERVICE_KEYS, VOLUME_KEYS } from './backup-config.ts';

// yaml-language-server (Red Hat YAML et al.) validates schemas with Ajv in draft mode, so the same
// library here stands in for the editors the schema is published for.
const compile = () => new Ajv({ allErrors: true, strict: true }).compile(xTugSchema());
const loadYaml = async (file: string): Promise<unknown> =>
  yaml.load(await fs.readFile(file, 'utf8'));

test('the committed x-tug.schema.json is exactly what the generator writes', async () => {
  const committed = JSON.parse(await fs.readFile(path.resolve('x-tug.schema.json'), 'utf8'));
  assert.deepEqual(committed, xTugSchema(), 'drift: run npm run schema to regenerate it');
});

test('the schema is registered at the documented stable URL', () => {
  const schema = xTugSchema();
  assert.equal(schema.$id, SCHEMA_URL, 'editors reference $id when resolving relatives');
  assert.match(SCHEMA_URL, /^https:\/\/unpkg\.com\/@wpelevator\/tug\//);
});

test('the schema keys mirror the validator allowlists', () => {
  const schema = xTugSchema();
  const service = schema.properties.services.patternProperties['.+'];
  const volume = schema.properties.volumes.patternProperties['.+'];
  const serviceXtug = service.properties['x-tug'];
  const volumeXtug = volume.properties['x-tug'];
  assert.deepEqual(
    Object.keys(serviceXtug.properties).sort(),
    [...SERVICE_EXTENSION_KEYS].sort(),
    'the service x-tug block and the validator accept the same keys',
  );
  assert.deepEqual(
    Object.keys(volumeXtug.properties).sort(),
    [...VOLUME_EXTENSION_KEYS].sort(),
    'the volume x-tug block and the validator accept the same keys',
  );
  assert.deepEqual(
    service.propertyNames.anyOf[0].enum,
    [...SUPPORTED_SERVICE_KEYS, 'networks', 'pull_policy'].sort(),
    'service key names outside the x- prefix are the ones the validator accepts',
  );
  assert.deepEqual(
    volume.propertyNames.anyOf[0].enum,
    [...SUPPORTED_VOLUME_KEYS].sort(),
    'volume key names outside the x- prefix are the ones the validator accepts',
  );
});

test('the schema enums match the validated values', () => {
  const schema = xTugSchema();
  const serviceXtug = schema.properties.services.patternProperties['.+'].properties['x-tug'];
  const volumeXtug = schema.properties.volumes.patternProperties['.+'].properties['x-tug'];
  assert.deepEqual(serviceXtug.properties.health.properties.type.enum, ['docker', 'tcp', 'http']);
  assert.deepEqual(serviceXtug.properties.ingress.properties.tls.enum, ['auto', 'custom', 'off']);
  assert.deepEqual(serviceXtug.properties.rollout.properties.strategy.enum, [
    'recreate',
    'rolling',
  ]);
  assert.deepEqual(
    [...schema.properties['x-tug'].properties.rollback.enum].sort(),
    ['auto', 'manual'],
    'the enum order does not matter, only the set',
  );
  assert.deepEqual(
    Object.keys(
      serviceXtug.properties.backup.oneOf.find((o: any) => o.type === 'object').properties,
    ).sort(),
    [...SERVICE_KEYS].sort(),
    'service backup keys match what resolveBackups accepts',
  );
  assert.deepEqual(
    Object.keys(
      volumeXtug.properties.backup.oneOf.find((o: any) => o.type === 'object').properties,
    ).sort(),
    [...VOLUME_KEYS].sort(),
    'volume backup keys match what resolveBackups accepts',
  );
  assert.deepEqual(
    Object.keys(
      volumeXtug.properties.backup.oneOf.find((o: any) => o.type === 'object').properties.retention
        .properties,
    ).sort(),
    [...RETENTION_KEYS].sort(),
    'retention keys match what restic keep policy accepts',
  );
});

test('the repository example and sample compose files validate against the schema', async () => {
  const validate = compile();
  for (const file of [
    'examples/wordpress/docker-compose.yml',
    'docker-compose.sample.yml',
    'docker-compose.tug.yml',
  ]) {
    assert.equal(validate(await loadYaml(file)), true, `${file} must be a valid Tug compose file`);
  }
});

test('the schema squiggles the findings tug lint reports', async () => {
  const validate = compile();
  const bad = `
services:
  web:
    image: nginx
    x-tug:
      ingresss:
        host: app.example.com
        port: 80
      health:
        type: htp
      placement:
        global: true
volumes:
  data:
    x-tug:
      persistant: true
`;
  const errors = (() => {
    validate(yaml.load(bad));
    return validate.errors ?? [];
  })();
  assert.match(
    JSON.stringify(errors),
    /"additionalProperty":"ingresss"/,
    'an unknown x-tug key is a finding',
  );
  assert.ok(
    errors.some((e: { instancePath?: string }) =>
      String(e.instancePath).endsWith('/x-tug/health/type'),
    ),
    'an unknown health type is a finding on properties.health.type',
  );
  assert.match(
    JSON.stringify(errors),
    /"additionalProperty":"persistant"/,
    'an unknown volume x-tug key is a finding',
  );
  assert.match(
    JSON.stringify(errors),
    /"additionalProperty":"global"/,
    'placement.global is flagged, not silently accepted',
  );
});

test('unknown standard service keys and custom x- keys behave like the validator', async () => {
  const validate = compile();
  assert.equal(
    validate({ services: { web: { image: 'nginx', deploy: { replicas: 2 } } } }),
    false,
    'deploy (Swarm) is not supported',
  );
  assert.equal(
    validate({ services: { web: { image: 'nginx', 'x-tug': { global: true } } } }),
    true,
    'global stays a boolean x-tug key',
  );
  assert.equal(
    validate({ services: { web: { image: 'nginx', 'x-helper': { anything: 'x- stays valid' } } } }),
    true,
    'custom x- extensions are accepted like compose-spec does',
  );
  assert.equal(
    validate({ services: { web: { image: 'nginx', networks: ['other'] } } }),
    false,
    'custom networks are not accepted',
  );
  assert.equal(validate({ volumes: {} }), false, 'services are required');
});
