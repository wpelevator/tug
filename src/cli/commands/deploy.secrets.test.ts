import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../../tests/helpers.ts';
import { execCli } from '../../../tests/cli-inprocess.ts';

interface BuildCall {
  secrets?: { id: string; value: string }[];
}

type Tug = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function withControl(
  run: (ctx: { dir: string; builds: BuildCall[]; tug: Tug }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-secrets-cli-'));
  const builds: BuildCall[] = [];
  const bytes = Buffer.from('saved image gzip');
  const info = {
    imageId: `sha256:${'a'.repeat(64)}`,
    platform: 'linux/amd64',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  const control = await startMtlsControl(dir, {
    images: {
      build: async (options) => {
        builds.push({ secrets: options.secrets });
      },
      save: async (_ref, file) => {
        await fs.writeFile(file, bytes);
        return info;
      },
      inspect: async (ref) => ({
        imageId: `sha256:${createHash('sha256').update(String(ref)).digest('hex')}`,
        platform: info.platform,
      }),
    },
  });
  try {
    assert.equal(((await control.registerNode('n1')) as { status: number }).status, 200, 'a node');
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    await run({
      dir,
      builds,
      tug: (args) =>
        execCli([...args, '--project', 'shop'], {
          cwd: dir,
          env: { ...process.env, ...control.env, TUG_CREDENTIAL: '', CI: '1' },
        }),
    });
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const compose = (secrets: string[], declarations: string[]) =>
  [
    'services:',
    '  web:',
    '    build:',
    '      context: .',
    '      secrets:',
    ...secrets.map((entry) => `        ${entry}`),
    ...declarations,
    '',
  ].join('\n');

const FILE_SOURCE = compose(
  ['- npm_token'],
  ['secrets:', '  npm_token:', '    file: ./secrets/npm_token'],
);

const write = (dir: string, text: string) => fs.writeFile(path.join(dir, 'compose.yaml'), text);
const deploy = (tug: Tug, extra: string[] = []) => tug(['deploy', '--no-wait', '--json', ...extra]);

test('a file: source is never read: the tug secret is what the build mounts, under the key as its id', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await fs.mkdir(path.join(dir, 'secrets'));
    await fs.writeFile(path.join(dir, 'secrets', 'npm_token'), 'value-from-the-file');
    await write(dir, FILE_SOURCE);
    await tug(['secret', 'set', 'npm_token', '--value', 'value-from-control']);
    const result = await deploy(tug);
    assert.deepEqual(
      builds[0].secrets,
      [{ id: 'npm_token', value: 'value-from-control' }],
      'control mounts its own value, not the contents of the local file',
    );
    const deployed = JSON.parse(result.stdout);
    assert.deepEqual(
      deployed.desiredState.compose.secrets,
      { npm_token: { 'x-tug': { secret: 'npm_token' } } },
      'the deployed file carries the resolved mapping and no local path',
    );
    for (const text of [result.stdout, result.stderr, (await tug(['status', '--json'])).stdout]) {
      assert.ok(
        !text.includes('value-from-control') && !text.includes('value-from-the-file'),
        'no secret value appears in the deploy output or the deployment record',
      );
    }
  });
});

test('the mapping follows the resolution order and the long form sets the BuildKit id', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await write(
      dir,
      compose(
        ['- composer_auth', '- source: ghcr', '  target: registry', '- chosen'],
        [
          'secrets:',
          '  composer_auth:',
          '    environment: COMPOSER_AUTH',
          '  ghcr:',
          '    external: true',
          '    name: ghcr_pat',
          '  chosen:',
          '    environment: IGNORED_BY_RULE_ONE',
          '    x-tug:',
          '      secret: explicit_secret',
        ],
      ),
    );
    for (const name of ['COMPOSER_AUTH', 'ghcr_pat', 'explicit_secret'])
      await tug(['secret', 'set', name, '--value', `v-${name}`]);
    await deploy(tug);
    assert.deepEqual(
      builds[0].secrets,
      [
        { id: 'composer_auth', value: 'v-COMPOSER_AUTH' },
        { id: 'registry', value: 'v-ghcr_pat' },
        { id: 'chosen', value: 'v-explicit_secret' },
      ],
      'environment, external name and x-tug.secret each pick the tug secret, and target is the id',
    );
  });
});

test('a missing secret fails the deploy with the exact command, using the file path when there is one', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await write(dir, FILE_SOURCE);
    await assert.rejects(
      deploy(tug),
      /npm_token → secret npm_token \(file \.\/secrets\/npm_token ignored\).*tug secret set npm_token --from-file \.\/secrets\/npm_token/s,
      'the error prints the fix with the local path',
    );
    await write(
      dir,
      compose(
        ['- composer_auth'],
        ['secrets:', '  composer_auth:', '    environment: COMPOSER_AUTH'],
      ),
    );
    await assert.rejects(
      deploy(tug),
      /Run tug secret set COMPOSER_AUTH$/m,
      'without a file source the fix is tug secret set NAME',
    );
    assert.deepEqual(builds, [], 'nothing was built');
  });
});

test('a Compose secret that exists only as a variable is refused with a hint to use tug secret set', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await write(dir, FILE_SOURCE);
    await tug(['var', 'set', 'npm_token', '--value', 'visible']);
    await assert.rejects(
      deploy(tug),
      /npm_token is a variable, and a Compose secret is always a tug secret.*tug secret set npm_token/s,
      'the CLI refuses a variable and says how to fix it',
    );
    assert.deepEqual(builds, [], 'nothing was built');
  });
});

test('an undeclared reference, content: and a service-level secrets: are each refused', async () => {
  await withControl(async ({ dir, tug }) => {
    await write(dir, compose(['- nope'], ['secrets:', '  npm_token: {}']));
    await assert.rejects(
      deploy(tug),
      /build\.secrets refers to nope, which is not declared under secrets/,
      'an undeclared key is refused',
    );
    await write(dir, compose(['- npm_token'], ['secrets:', '  npm_token:', '    content: inline']));
    await assert.rejects(
      deploy(tug),
      /secrets\.npm_token: content is not supported/,
      'content: is refused',
    );
    await write(
      dir,
      [
        'services:',
        '  web:',
        '    image: nginx',
        '    secrets: [npm_token]',
        'secrets:',
        '  npm_token: {}',
        '',
      ].join('\n'),
    );
    await assert.rejects(
      deploy(tug),
      /web: secrets \(file mounts under \/run\/secrets\) are not built yet/,
      'a service-level secrets: is refused with the reason',
    );
  });
});

test('tug lint reports a declaration field tug cannot honor, offline', async () => {
  await withControl(async ({ dir, tug }) => {
    await write(dir, compose(['- npm_token'], ['secrets:', '  npm_token:', '    driver: other']));
    await assert.rejects(
      tug(['lint']),
      /secrets\.npm_token: driver is not supported/,
      'lint reports an unsupported declaration field without a control connection',
    );
  });
});

test('an unused declaration needs no secret and does not stop a deploy', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await write(
      dir,
      [
        'services:',
        '  web:',
        '    build: .',
        'secrets:',
        '  never_used:',
        '    environment: NEVER_SET_ON_CONTROL',
        '',
      ].join('\n'),
    );
    const deployed = JSON.parse((await deploy(tug)).stdout);
    assert.equal(builds[0].secrets, undefined, 'the build mounts no secret');
    assert.equal(
      'secrets' in deployed.desiredState.compose,
      false,
      'an unused declaration is not deployed, so it releases and restarts nothing',
    );
  });
});

test('deploy --dry-run, the Values report and tug values list each used declaration with its mapping', async () => {
  await withControl(async ({ dir, tug }) => {
    await write(dir, FILE_SOURCE);
    await tug(['secret', 'set', 'npm_token', '--value', 'x']);
    const line = 'npm_token → secret npm_token (file ./secrets/npm_token ignored)';
    const dry = await tug(['deploy', '--dry-run']);
    assert.ok(
      dry.stdout.includes(line),
      'the dry-run table lists the mapping and the ignored file',
    );
    assert.ok(dry.stderr.includes(`Build secret: ${line}`), 'the report on stderr lists it too');
    const values = await tug(['values']);
    assert.ok(values.stdout.includes(line), 'tug values lists the mapping');
    assert.deepEqual(
      JSON.parse((await tug(['values', '--json'])).stdout).buildSecrets.map(
        (row: { declaration: string; secret: string; status: string }) => [
          row.declaration,
          row.secret,
          row.status,
        ],
      ),
      [['npm_token', 'npm_token', 'set']],
      'the JSON output carries the mapping and whether control holds the secret',
    );
  });
});

test('tug values exits 1 and prints the fix while a mapped secret is missing', async () => {
  await withControl(async ({ dir, tug }) => {
    await write(dir, FILE_SOURCE);
    await assert.rejects(
      tug(['values']),
      (error: Error & { stdout: string }) => {
        assert.match(
          error.stdout,
          /tug secret set npm_token --from-file \.\/secrets\/npm_token/,
          'the output says how to set the missing secret',
        );
        return true;
      },
      'a missing Compose secret fails the command',
    );
  });
});

test('--build-local still refuses a service that builds with Compose secrets', async () => {
  await withControl(async ({ dir, tug }) => {
    await write(dir, FILE_SOURCE);
    await tug(['secret', 'set', 'npm_token', '--value', 'x']);
    await assert.rejects(
      tug(['deploy', '--build-local', '--no-wait']),
      /web: build\.secrets are tug project secrets, which only control can read/,
      'a local build cannot read project secrets',
    );
  });
});
