import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  canonicalSecrets,
  composeErrors,
  composeHash,
  composeSecretErrors,
  declarationSecret,
  describeBuildSecret,
  serviceBuildSecrets,
  serviceSecretNames,
  usedBuildSecrets,
} from './compose.ts';
import { composeConfigArgs, normalizeCompose } from './normalize.ts';
import type { ComposeFile } from '../protocol.ts';

const withSecrets = (
  secrets: Record<string, unknown>,
  entries: unknown[] = Object.keys(secrets),
): ComposeFile =>
  ({
    services: { web: { build: { context: '.', secrets: entries } } },
    secrets,
  }) as unknown as ComposeFile;

const secretOf = (declaration: unknown, key = 'npm_token') =>
  declarationSecret(key, declaration).secret;

test('a declaration maps to a tug secret by x-tug.secret, then the external name, then environment, then its key', () => {
  assert.equal(secretOf({}), 'npm_token', 'with nothing else the declaration key is the secret');
  assert.equal(secretOf(null), 'npm_token', 'an empty declaration is the key');
  assert.equal(secretOf({ environment: 'GH_TOKEN' }), 'GH_TOKEN', 'environment names the secret');
  assert.equal(
    secretOf({ external: true, name: 'ghcr_pat', environment: 'GH_TOKEN' }),
    'ghcr_pat',
    'the name of an external secret wins over environment',
  );
  assert.equal(
    secretOf({ external: false, name: 'ignored', environment: 'GH_TOKEN' }),
    'GH_TOKEN',
    'a name counts only when the secret is external',
  );
  assert.equal(
    secretOf({
      'x-tug': { secret: 'chosen' },
      external: true,
      name: 'ghcr_pat',
      environment: 'GH_TOKEN',
      file: './x',
    }),
    'chosen',
    'x-tug.secret wins over every other rule',
  );
});

test('build.secrets entries resolve through the declarations, with the key as the default BuildKit id', () => {
  const compose = withSecrets(
    {
      npm_token: { file: './secrets/npm_token' },
      composer_auth: { environment: 'COMPOSER_AUTH' },
      ghcr: { external: true, name: 'ghcr_pat' },
    },
    ['npm_token', { source: 'composer_auth', target: 'auth' }, { source: 'ghcr' }],
  );
  assert.deepEqual(
    serviceBuildSecrets(compose, 'web'),
    [
      {
        secret: 'npm_token',
        id: 'npm_token',
        declaration: 'npm_token',
        ignoredSource: 'file ./secrets/npm_token',
      },
      {
        secret: 'COMPOSER_AUTH',
        id: 'auth',
        declaration: 'composer_auth',
        ignoredSource: 'environment COMPOSER_AUTH',
      },
      { secret: 'ghcr_pat', id: 'ghcr', declaration: 'ghcr' },
    ],
    'the short and long forms resolve to the mapped secret, the BuildKit id and the ignored source',
  );
  assert.deepEqual(
    serviceBuildSecrets(compose, 'missing-service'),
    [],
    'a service with no build secrets uses none',
  );
  assert.deepEqual(
    usedBuildSecrets(withSecrets({ a: {}, b: {} }, ['a', 'a', 'b'])).map((u) => u.declaration),
    ['a', 'b'],
    'a declaration used twice is listed once',
  );
});

test('the deploy report line shows the mapping and the local source tug ignores', () => {
  assert.equal(
    describeBuildSecret({
      declaration: 'npm_token',
      secret: 'npm_token',
      id: 'npm_token',
      ignoredSource: 'file ./secrets/npm_token',
    }),
    'npm_token → secret npm_token (file ./secrets/npm_token ignored)',
    'a file source is reported as ignored',
  );
  assert.equal(
    describeBuildSecret({ declaration: 'ghcr', secret: 'ghcr_pat', id: 'ghcr' }),
    'ghcr → secret ghcr_pat',
    'a declaration with no local source has nothing to ignore',
  );
});

test('declarations tug cannot honor are refused with the key named', () => {
  const errors = (compose: ComposeFile) => composeSecretErrors(compose).join('\n');
  assert.match(
    errors(withSecrets({ a: {} }, ['b'])),
    /web: build\.secrets refers to b, which is not declared under secrets/,
    'a reference to an undeclared key is refused, as Compose refuses it',
  );
  assert.match(
    errors(withSecrets({ a: { content: 'inline' } })),
    /secrets\.a: content is not supported/,
    'inline content is refused',
  );
  assert.match(
    errors(withSecrets({ a: { driver: 'x' } })),
    /secrets\.a: driver is not supported \(supported: file, environment, external, name, x-tug\)/,
    'an unknown declaration field is refused with the supported list',
  );
  assert.match(
    errors(withSecrets({ a: { external: true, name: '${TOKEN_NAME}' } })),
    /secrets\.a: name must not use a variable reference/,
    'a templated name is refused',
  );
  assert.match(
    errors(withSecrets({ a: { 'x-tug': { secret: 'TUG_REGISTRY_AUTH' } } })),
    /secrets\.a: maps to TUG_REGISTRY_AUTH, which is reserved/,
    'the registry credential cannot be mounted into a build',
  );
  assert.match(
    errors(withSecrets({ 'a b': {} })),
    /secrets\.a b: the key must be/,
    'a key that is not a Compose name is refused',
  );
  assert.match(
    errors(withSecrets({ a: { environment: 'not-valid' } })),
    /secrets\.a: the tug secret name "not-valid" must be letters, digits and underscores/,
    'a mapped name that is not a tug secret name is refused, with the way out',
  );
  const service = {
    services: { web: { image: 'x', secrets: ['a'] } },
    secrets: { a: {} },
  } as unknown as ComposeFile;
  assert.match(
    composeErrors(service, [], { normalized: false }).join('\n'),
    /web: secrets \(file mounts under \/run\/secrets\) are not built yet.*docs\/workload-secrets\.md/,
    'a service-level secrets: says file mounts are not built and links the page',
  );
});

test('an unused declaration is allowed, releases nothing to a node, and is dropped from the deployed file', () => {
  const compose = {
    services: {
      web: {
        image: 'x',
        build: { context: '.', secrets: ['npm_token'] },
        environment: ['A=@@tug:secret:DB_PASSWORD@@'],
      },
      worker: { image: 'y' },
    },
    secrets: {
      npm_token: { file: './secrets/npm_token' },
      unused: { environment: 'UNUSED_SECRET' },
    },
  } as unknown as ComposeFile;
  assert.deepEqual(composeSecretErrors(compose), [], 'an unused declaration is not an error');
  assert.deepEqual(
    canonicalSecrets(compose).secrets,
    { npm_token: { 'x-tug': { secret: 'npm_token' } } },
    'only used declarations remain, reduced to the tug secret they map to',
  );
  assert.deepEqual(
    [...serviceSecretNames(canonicalSecrets(compose), ['web', 'worker'])],
    ['DB_PASSWORD'],
    'a node is released the secrets a service references, never a build secret or an unused declaration',
  );
  assert.equal(
    'secrets' in
      canonicalSecrets({
        services: { web: { image: 'x' } },
        secrets: { a: {} },
      } as unknown as ComposeFile),
    false,
    'with nothing built from a declaration, no secrets key is deployed',
  );
});

const COMPOSE = [
  'services:',
  '  web:',
  '    build:',
  '      context: .',
  '      secrets:',
  '        - npm_token',
  '        - composer_auth',
  'secrets:',
  '  npm_token:',
  '    file: ./secrets/npm_token',
  '  composer_auth:',
  '    environment: COMPOSER_AUTH',
  '',
].join('\n');

test('the same Compose file gives the same Compose hash from two directories', async () => {
  const roots: string[] = [];
  const hashes: string[] = [];
  const seen: string[] = [];
  try {
    for (const name of ['laptop', 'ci-runner-4711']) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `tug-hash-${name}-`));
      roots.push(dir);
      await fs.mkdir(path.join(dir, 'secrets'));
      await fs.writeFile(path.join(dir, 'secrets', 'npm_token'), `value-of-${name}`);
      await fs.writeFile(path.join(dir, 'compose.yaml'), COMPOSE);
      const compose = await normalizeCompose(path.join(dir, 'compose.yaml'), [], {
        project: 'shop',
        onSecrets: (uses) => seen.push(uses.map(describeBuildSecret).join('|')),
      });
      hashes.push(composeHash(compose));
      assert.ok(
        !JSON.stringify(compose).includes(dir),
        'no path of the deploy machine is in the file sent to control',
      );
    }
    assert.equal(hashes[0], hashes[1], 'the version label does not depend on who deploys');
    assert.equal(
      seen[0],
      'npm_token → secret npm_token (file ./secrets/npm_token ignored)|composer_auth → secret COMPOSER_AUTH (environment COMPOSER_AUTH ignored)',
      'the report keeps the local source that was ignored',
    );
  } finally {
    for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
  }
});

test('docker compose config output with absolute paths and prefixed names is made canonical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-config-'));
  try {
    await fs.writeFile(path.join(dir, 'compose.yaml'), COMPOSE);
    const rendered = (root: string) =>
      [
        'name: shop',
        'services:',
        '  web:',
        '    build:',
        `      context: ${root}`,
        '      secrets:',
        '        - source: npm_token',
        '        - source: composer_auth',
        'secrets:',
        '  npm_token:',
        '    name: shop_npm_token',
        `    file: ${root}/secrets/npm_token`,
        '  composer_auth:',
        '    name: shop_composer_auth',
        '    environment: COMPOSER_AUTH',
      ].join('\n');
    const hashes: string[] = [];
    for (const root of ['/home/ana/shop', '/runner/work/shop/shop']) {
      const compose = await normalizeCompose(path.join(dir, 'compose.yaml'), [], {
        project: 'shop',
        composeCli: true,
        runner: async () => ({ out: rendered(root), err: '', code: 0 }) as never,
      });
      assert.ok(
        !JSON.stringify(compose.secrets).includes('/'),
        'the rendered file path is not kept in the declaration',
      );
      assert.deepEqual(
        compose.secrets,
        {
          npm_token: { 'x-tug': { secret: 'npm_token' } },
          composer_auth: { 'x-tug': { secret: 'COMPOSER_AUTH' } },
        },
        'each declaration is rewritten to its resolved form',
      );
      hashes.push(JSON.stringify(compose.secrets));
    }
    assert.equal(
      hashes[0],
      hashes[1],
      'the declarations are identical whichever path was rendered',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a templated secret name is refused even though interpolation would resolve it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-templated-'));
  try {
    await fs.writeFile(
      path.join(dir, 'compose.yaml'),
      [
        'services:',
        '  web:',
        '    build:',
        '      context: .',
        '      secrets: [token]',
        'secrets:',
        '  token:',
        '    external: true',
        '    name: ${TOKEN_NAME:-fallback}',
        '',
      ].join('\n'),
    );
    await assert.rejects(
      normalizeCompose(path.join(dir, 'compose.yaml'), [], { project: 'shop' }),
      /secrets\.token: name must not use a variable reference/,
      'the declaration is checked as written',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const run = promisify(execFile);

test('the fixture is a Compose file that docker compose itself accepts', async (t) => {
  try {
    await run('docker', ['compose', 'version']);
  } catch {
    t.skip('docker compose is not installed');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-docker-config-'));
  try {
    await fs.mkdir(path.join(dir, 'secrets'));
    await fs.writeFile(path.join(dir, 'secrets', 'npm_token'), 'x');
    await fs.writeFile(path.join(dir, 'compose.yaml'), COMPOSE);
    const { stdout } = await run(
      'docker',
      composeConfigArgs(path.join(dir, 'compose.yaml'), 'shop').filter(
        (arg) => arg !== '--no-path-resolution',
      ),
      { env: { ...process.env, COMPOSER_AUTH: '{}' } },
    );
    assert.match(stdout, /secrets:/, 'docker compose renders the top-level secrets');
    assert.match(stdout, /source: npm_token/, 'docker compose renders the build secret reference');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
