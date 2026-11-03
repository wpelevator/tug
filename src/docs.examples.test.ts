import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { buildDesiredState, validateCompose } from './compose.ts';
import type { ComposeFile } from './protocol.ts';
import { unescapeDollars } from './normalize.ts';
import { normalized } from '../tests/fake-docker.ts';

function yamlBlocks(file: string): string[] {
  const source = fs.readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');
  return Array.from(source.matchAll(/```yaml\n([\s\S]*?)\n```/g), (match) => match[1]);
}

function composeBlock(file: string, index = 0): ComposeFile {
  return yaml.load(yamlBlocks(file)[index]) as ComposeFile;
}

test('the quickstart service deploys to the single node and publishes its documented port', () => {
  const compose = normalized(composeBlock('getting-started.md'));
  assert.doesNotThrow(
    () => validateCompose(compose, ['app1']),
    'the quickstart Compose example should validate',
  );
  const desired = buildDesiredState({
    project: 'site',
    version: 'v1',
    compose,
    defaultNode: 'app1',
  });
  assert.deepEqual(
    desired.services.web.placement.nodes,
    ['app1'],
    'implicit placement should select the only node',
  );
  assert.equal(
    desired.services.web.health?.type,
    'http',
    'the quickstart should use its documented HTTP health check',
  );
  assert.deepEqual(
    compose.services.web.ports,
    [{ mode: 'ingress', target: 80, published: '8080', host_ip: '0.0.0.0', protocol: 'tcp' }],
    'the example should expose port 8080 as described',
  );
});

test('the second-node example places the service on both named nodes', () => {
  const compose = normalized(composeBlock('service-placement.md'));
  assert.doesNotThrow(
    () => validateCompose(compose, ['app1', 'app2']),
    'the placement example should validate with two nodes',
  );
  const desired = buildDesiredState({ project: 'site', version: 'v1', compose });
  assert.deepEqual(
    desired.services.web.placement.nodes,
    ['app1', 'app2'],
    'both nodes should receive a web replica',
  );
  assert.equal(desired.services.web.replicas, 2, 'the example should resolve to two replicas');
});

test('the health-check example declares a healthy database dependency', () => {
  const compose = normalized(composeBlock('healthchecks.md'));
  assert.doesNotThrow(
    () => validateCompose(compose, ['app1']),
    'the health-check example should validate',
  );
  assert.equal(
    compose.services.db['x-tug']?.health?.type,
    'tcp',
    'the database should use a TCP check',
  );
  assert.equal(
    compose.services.web['x-tug']?.health?.type,
    'http',
    'the web service should use an HTTP check',
  );
  assert.equal(
    (compose.services.web.depends_on as Record<string, { condition: string }>).db.condition,
    'service_healthy',
    'web should wait for database health on the same node',
  );
});

test('documented backup commands survive Compose interpolation without leaking operator values', (t) => {
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (version.status !== 0) return t.skip('Docker Compose is required to check real interpolation');
  const referenceText = yamlBlocks('compose.md').find((block) =>
    block.includes('command: mariadb-dump'),
  );
  assert.ok(referenceText, 'the Compose reference should contain its backup example');
  const reference = yaml.load(referenceText) as ComposeFile;
  const recipes = yamlBlocks('backups.md')[0];
  const commands = Array.from(recipes.matchAll(/^ {2}command: (.+)$/gm), (match) => match[1]);
  const command = reference.services.db['x-tug']?.backup;
  assert.ok(
    command && typeof command === 'object',
    'the backup reference should include a service backup',
  );
  const backupGuide = fs.readFileSync(new URL('../docs/backups.md', import.meta.url), 'utf8');
  const restore = backupGuide.match(/restore: sh -c '([^']+)'/);
  assert.ok(restore, 'the backup guide should document a MariaDB restore command');
  const examples = [(command as { command: string }).command, ...commands.slice(0, 2), restore[1]];
  for (const example of examples) {
    const input = yaml.dump({
      services: { db: { image: 'mariadb:11.4', 'x-tug': { backup: { command: example } } } },
    });
    const result = spawnSync('docker', ['compose', '-f', '-', 'config', '--format', 'yaml'], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        MARIADB_ROOT_PASSWORD: 'operator-secret',
        POSTGRES_USER: 'operator-user',
        POSTGRES_DB: 'operator-db',
      },
    });
    assert.equal(
      result.status,
      0,
      `Compose should normalize the documented backup command: ${result.stderr}`,
    );
    const output = unescapeDollars(yaml.load(result.stdout)) as {
      services: { db: { 'x-tug': { backup: { command: string } } } };
    };
    const rendered = output.services.db['x-tug'].backup.command;
    assert.doesNotMatch(
      rendered,
      /operator-secret|operator-user|operator-db/,
      'operator values should not be inserted into backup commands',
    );
    assert.match(
      rendered,
      /\$(?:MARIADB_ROOT_PASSWORD|POSTGRES_USER)/,
      'container environment variables should remain for runtime expansion',
    );
  }
});
