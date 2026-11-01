import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { resolveBackups } from './backup-config.ts';
import { buildDesiredState, validateCompose } from './compose.ts';
import type { ComposeFile } from './protocol.ts';
import { normalized } from '../tests/fake-docker.ts';

const compose = yaml.load(
  fs.readFileSync(new URL('../examples/wordpress/docker-compose.yml', import.meta.url), 'utf8'),
) as ComposeFile;

test('the wordpress example is valid, also with several registered nodes', () => {
  assert.doesNotThrow(() => validateCompose(normalized(compose)), 'valid on a single node');
  assert.doesNotThrow(
    () => validateCompose(normalized(compose), ['app', 'other']),
    'every service and volume names its placement, so extra nodes do not make it ambiguous',
  );
  assert.deepEqual(Object.keys(compose.services).sort(), ['db', 'wordpress']);
  assert.ok(
    !fs.existsSync(new URL('../examples/wordpress/backup', import.meta.url)),
    'there is no backup container or script to maintain',
  );
});

test('the wordpress example backs up the database by command and the uploads as files', () => {
  const { targets, errors } = resolveBackups(normalized(compose), 'blog');
  assert.deepEqual(errors, [], 'the backup configuration validates');
  const db = targets.find((t) => t.target === 'service:db')!;
  assert.equal(db.type, 'command');
  assert.match(db.command!.join(' '), /mariadb-dump/);
  assert.equal(db.verify, '-- Dump completed');
  assert.match(db.restore!.join(' '), /mariadb -uroot/, 'the database can be restored by Tug');
  assert.equal(db.node, 'app');
  const files = targets.find((t) => t.target === 'volume:wp-content')!;
  assert.equal(files.type, 'volume');
  assert.deepEqual(files.exclude, ['cache/']);
  assert.equal(db.schedule, '0 3 * * *', 'targets inherit the project schedule');
  assert.deepEqual(db.retention, { daily: 7, weekly: 4, monthly: 6 });
});

test('the wordpress example keeps every credential out of the file', () => {
  const secretLike = /PASSWORD|SECRET|TOKEN|KEY/;
  let checked = 0;
  for (const [name, svc] of Object.entries(compose.services))
    for (const [key, value] of Object.entries(svc.environment as Record<string, unknown>)) {
      if (!secretLike.test(key)) continue;
      checked++;
      assert.match(String(value), /^\$\{[A-Z_]+\}$/, `${name}.${key} must be a \${VAR} reference`);
    }
  assert.ok(checked >= 3, 'the database and WordPress passwords are checked');
  const backup = JSON.stringify(compose.services.db['x-tug']);
  assert.ok(
    !/PASSWORD=|-p[A-Za-z0-9]/.test(backup.replace(/\$\$MARIADB_ROOT_PASSWORD/g, '')),
    'the dump reads its password from the container environment',
  );
});

test('the wordpress example deploys to one node with the ingress and health checks it documents', () => {
  const desired = buildDesiredState({
    project: 'blog',
    version: 'v1',
    compose: normalized(compose),
  });
  assert.deepEqual(desired.services.db.placement.nodes, ['app']);
  assert.deepEqual(desired.services.wordpress.placement.nodes, ['app']);
  assert.equal(compose.services.wordpress['x-tug']?.ingress?.tls, 'auto');
  assert.equal(compose.services.db['x-tug']?.health?.type, 'tcp');
});
