import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { buildDesiredState, validateCompose } from './compose.ts';
import type { ComposeFile } from './protocol.ts';
import { normalized } from '../tests/fake-docker.ts';

const dir = new URL('../examples/wordpress-backup/', import.meta.url);
const compose = yaml.load(
  fs.readFileSync(new URL('docker-compose.yml', dir), 'utf8'),
) as ComposeFile;
const envOf = (svc: ComposeFile['services'][string]): Record<string, string> =>
  Object.fromEntries(
    Object.entries(svc.environment as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );

test('wordpress-backup example passes validateCompose, also with several registered nodes', () => {
  assert.doesNotThrow(
    () => validateCompose(normalized(compose)),
    'the example is valid on a single-node setup',
  );
  assert.doesNotThrow(
    () => validateCompose(normalized(compose), ['app', 'other']),
    'every service names its placement, so extra nodes do not make it ambiguous',
  );
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    ['backup', 'db', 'wordpress'],
    'the example has the three services the docs describe',
  );
});

test('wordpress-backup example takes every credential from ${VAR} references', () => {
  const secretLike = /PASSWORD|SECRET|TOKEN|KEY|REPOSITORY|URL/;
  let checked = 0;
  for (const [name, svc] of Object.entries(compose.services)) {
    for (const [key, value] of Object.entries(envOf(svc))) {
      if (!secretLike.test(key)) continue;
      checked++;
      assert.match(
        value,
        /^\$\{[A-Z_]+(:-)?\}$/,
        `${name}.${key} must be a \${VAR} reference, not a literal`,
      );
    }
  }
  assert.ok(
    checked >= 9,
    'the credential check covers the database, WordPress and backup variables',
  );
  for (const key of [
    'RESTIC_REPOSITORY',
    'RESTIC_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'DB_PASSWORD',
  ])
    assert.ok(envOf(compose.services.backup)[key], `backup receives ${key}`);
});

test('wordpress-backup places the backup service with the database and the volumes it reads', () => {
  const nodes = (name: string) => compose.services[name]['x-tug']?.placement?.nodes;
  assert.deepEqual(
    nodes('backup'),
    nodes('db'),
    'backup runs on the database node so it reaches db over the Compose network',
  );
  const mounted = (compose.services.backup.volumes as string[]).map((v) => v.split(':'));
  assert.ok(mounted.length > 0, 'backup mounts the data it archives');
  for (const [volume, , mode] of mounted) {
    assert.equal(mode, 'ro', `backup mounts ${volume} read-only`);
    assert.deepEqual(
      compose.volumes![volume]['x-tug']?.placement?.nodes,
      nodes('backup'),
      `volume ${volume} lives on the backup node`,
    );
  }
  for (const name of Object.keys(compose.services))
    assert.ok(compose.services[name].mem_limit, `${name} has a mem_limit`);
  assert.match(
    String(compose.services.db.image),
    /^mariadb:11\.4\.\d+$/,
    'MariaDB is pinned to an exact 11.4.x tag',
  );
  assert.match(
    String(compose.services.wordpress.image),
    /^wordpress:6\.8\.\d+-apache$/,
    'WordPress is pinned to an exact 6.8.x tag',
  );
});

test('wordpress-backup builds a service from a directory that holds its Dockerfile and script', () => {
  const ctx = compose.services.backup.build as string;
  assert.ok(fs.existsSync(new URL(`${ctx}/Dockerfile`, dir)), 'the build context has a Dockerfile');
  assert.ok(fs.existsSync(new URL(`${ctx}/backup.sh`, dir)), 'the build context has backup.sh');
  const state = buildDesiredState({ project: 'blog', version: 'v1', compose });
  assert.equal(
    state.services.backup.placement?.nodes?.[0],
    'app',
    'desired state places backup on the app node',
  );
});
