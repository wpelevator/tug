import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { resolveBackups } from './backup-config.ts';
import { validateCompose } from './compose.ts';
import type { ComposeFile } from './protocol.ts';
import { normalized } from '../tests/fake-docker.ts';

for (const name of ['node', 'django', 'laravel']) {
  const compose = yaml.load(
    fs.readFileSync(new URL(`../examples/${name}/docker-compose.yml`, import.meta.url), 'utf8'),
  ) as ComposeFile;
  test(`${name} deploys to a single node with database backup and private dependencies`, () => {
    assert.doesNotThrow(
      () => validateCompose(normalized(compose), ['app', 'other']),
      'all services and volumes should have explicit placement',
    );
    assert.deepEqual(
      Object.keys(compose.services).sort(),
      ['db', 'redis', 'web'],
      'the stack should contain only its web, database and cache services',
    );
    assert.equal(
      compose.services.web['x-tug']?.health?.path,
      '/health',
      'the web process should have a health check',
    );
    assert.equal(
      compose.services.web['x-tug']?.ingress?.tls,
      'auto',
      'the web ingress should use automatic TLS',
    );
    assert.equal(compose.services.redis.ports, undefined, 'Redis should not publish a host port');
    assert.equal(
      compose.services.db.ports,
      undefined,
      'the database should not publish a host port',
    );
    const { targets, errors } = resolveBackups(normalized(compose), name);
    assert.deepEqual(errors, [], 'the backup configuration should validate');
    assert.equal(targets.length, 1, 'only the database should be backed up by Tug');
    assert.equal(
      targets[0].target,
      'service:db',
      'the database should be dumped consistently using its service',
    );
    assert.ok(targets[0].restore, 'the database dump should have a restore command');
  });
}
