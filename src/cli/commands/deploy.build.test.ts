import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../../tests/helpers.ts';
import { execCli } from '../../../tests/cli-inprocess.ts';
import { composeErrors, ignoredBuildKeys, selectBuilds } from '../../compose/compose.ts';
import type { ComposeFile } from '../../protocol.ts';

interface BuildCall {
  secrets?: Record<string, string>;
  imageRef: string;
  service: string;
  buildSpec: unknown;
}

async function withControl(
  run: (ctx: {
    dir: string;
    builds: BuildCall[];
    tug: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  }) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-build-cli-'));
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
        builds.push({
          imageRef: options.imageRef,
          service: options.service,
          buildSpec: options.buildSpec,
          secrets: options.secrets,
        });
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
    await run({
      dir,
      builds,
      tug: (args) =>
        execCli(args, {
          cwd: dir,
          env: { ...process.env, ...control.env, TUG_CREDENTIAL: '', CI: '1', ...env },
        }),
    });
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const BOTH = ['services:', '  web:', '    image: ghcr.io/acme/web:v1', '    build: .', ''].join(
  '\n',
);

const deployJson = async (
  tug: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  args: string[] = [],
) => JSON.parse((await tug(['deploy', '--no-wait', '--json', ...args])).stdout);

test('a service with build: and image: deploys its image and does not build, and says so', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), BOTH);
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    const result = await tug(['deploy', '--no-wait', '--json', '--project', 'shop']);
    const deployed = JSON.parse(result.stdout);
    assert.equal(
      deployed.desiredState.services.web.image,
      'ghcr.io/acme/web:v1',
      'the image as written is what runs',
    );
    assert.equal(deployed.desiredState.services.web.build, null, 'nothing is marked for build');
    assert.deepEqual(builds, [], 'control built nothing, and no source was uploaded');
    assert.match(
      result.stderr,
      /note: web has build: and image:, so Tug deploys ghcr\.io\/acme\/web:v1 and does not build it/,
      'the deploy explains why it did not build',
    );
  });
});

test('--build builds a service that has both keys for that deploy, and x-tug.build: true always does', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), BOTH);
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    const forced = await deployJson(tug, ['--project', 'shop', '--build']);
    assert.equal(builds.length, 1, '--build builds the service');
    assert.match(
      forced.desiredState.services.web.image,
      /^tug-build\/shop\/web:/,
      'the deployed image is the one control built',
    );
    await fs.writeFile(path.join(dir, 'compose.yaml'), `${BOTH}    x-tug:\n      build: true\n`);
    await deployJson(tug, ['--project', 'shop2']);
    assert.equal(builds.length, 2, 'x-tug.build: true builds without --build');
  });
});

test('a service with only build: still builds', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    build: .\n');
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    const deployed = await deployJson(tug, ['--project', 'shop']);
    assert.equal(builds.length, 1, 'build: alone builds as before');
    assert.match(deployed.desiredState.services.web.image, /^tug-build\/shop\/web:/, 'built image');
  });
});

test('selectBuilds sets aside build: only where image: is also named and nothing asks for the build', () => {
  const compose = {
    services: {
      both: { image: 'a:1', build: '.' },
      forced: { image: 'b:1', build: '.', 'x-tug': { build: true } },
      only: { build: '.' },
      image: { image: 'c:1' },
    },
  } as unknown as ComposeFile;
  const plain = selectBuilds(compose);
  assert.deepEqual(plain.published, ['both'], 'only the service with both keys is set aside');
  assert.equal(plain.compose.services.both.build, undefined, 'its build section is dropped');
  assert.ok(plain.compose.services.forced.build, 'x-tug.build: true keeps the build');
  assert.ok(plain.compose.services.only.build, 'a build-only service keeps the build');
  assert.ok(compose.services.both.build, 'the input is not modified');
  const forced = selectBuilds(compose, true);
  assert.deepEqual(forced.published, [], '--build sets nothing aside');
  assert.ok(forced.compose.services.both.build, '--build keeps every build');
});

test('x-tug.build is a boolean that needs a build: section', () => {
  const errors = (service: object) =>
    composeErrors({ services: { web: service } } as unknown as ComposeFile, [], {
      normalized: false,
    });
  assert.deepEqual(
    errors({ image: 'a:1', build: '.', 'x-tug': { build: true } }),
    [],
    'x-tug.build: true with a build section is valid',
  );
  assert.match(
    errors({ image: 'a:1', 'x-tug': { build: true } }).join('\n'),
    /web: x-tug\.build: true needs a build: section/,
    'x-tug.build: true without build: is rejected',
  );
  assert.match(
    errors({ image: 'a:1', build: '.', 'x-tug': { build: 'yes' } }).join('\n'),
    /web: x-tug\.build must be true or false/,
    'a non-boolean is rejected',
  );
});

test('the project defaults to the Compose name, and deploy -f follows the file it deploys', async () => {
  await withControl(async ({ dir, tug }) => {
    await fs.writeFile(
      path.join(dir, 'compose.yaml'),
      'name: rootname\nservices:\n  a:\n    image: a:1\n',
    );
    await fs.mkdir(path.join(dir, 'Blog'));
    await fs.writeFile(path.join(dir, 'Blog', 'compose.yaml'), 'services:\n  b:\n    image: b:1\n');
    const root = await deployJson(tug);
    assert.equal(root.desiredState.project, 'rootname', 'the Compose name: is the project');
    const nested = await deployJson(tug, ['-f', 'Blog/compose.yaml']);
    assert.equal(
      nested.desiredState.project,
      'blog',
      'a file without name: names the project after its directory, as Compose does',
    );
  });
});

test('a project set in tug.yml or TUG_PROJECT beats the Compose name', async () => {
  await withControl(
    async ({ dir, tug }) => {
      await fs.writeFile(
        path.join(dir, 'compose.yaml'),
        'name: rootname\nservices:\n  a:\n    image: a:1\n',
      );
      await fs.writeFile(path.join(dir, 'tug.yml'), 'project: pinned\n');
      assert.equal(
        (await deployJson(tug)).desiredState.project,
        'pinned',
        'tug.yml pins the project',
      );
    },
    { TUG_CONFIG: 'tug.yml' },
  );
  await withControl(
    async ({ dir, tug }) => {
      await fs.writeFile(
        path.join(dir, 'compose.yaml'),
        'name: rootname\nservices:\n  a:\n    image: a:1\n',
      );
      assert.equal(
        (await deployJson(tug)).desiredState.project,
        'fromenv',
        'TUG_PROJECT beats the Compose name',
      );
    },
    { TUG_PROJECT: 'fromenv' },
  );
});

const WITH_OPTIONS = [
  'services:',
  '  web:',
  '    build:',
  '      context: .',
  '      target: production',
  '      args:',
  '        NODE_VERSION: "22"',
  '      secrets:',
  '        - NPM_TOKEN',
  '      additional_contexts:',
  '        base: docker-image://alpine:3.20',
  '',
].join('\n');

test('build args, target and secrets reach the build on control, and the secret value is kept out of the deployment', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), WITH_OPTIONS);
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    await tug(['secret', 'set', 'NPM_TOKEN', '--value', 'npm-secret-value', '--project', 'shop']);
    const deployed = await deployJson(tug, ['--project', 'shop']);
    assert.equal(builds.length, 1, 'the service is built on control');
    const spec = builds[0].buildSpec as Record<string, unknown>;
    assert.equal(spec.target, 'production', 'the target stage reaches the build');
    assert.deepEqual(spec.args, { NODE_VERSION: '22' }, 'the build args reach the build');
    assert.deepEqual(spec.secrets, ['NPM_TOKEN'], 'the build names the secret it mounts');
    assert.equal(
      builds[0].secrets?.NPM_TOKEN,
      'npm-secret-value',
      'control decrypts the project secret for the build',
    );
    const record = JSON.stringify(deployed);
    assert.ok(!record.includes('npm-secret-value'), 'the deploy result holds no secret value');
    const fetched = JSON.stringify(
      JSON.parse((await tug(['status', '--json', '--project', 'shop'])).stdout),
    );
    assert.ok(!fetched.includes('npm-secret-value'), 'the stored deployment holds no secret value');
  });
});

test('a build secret that is not a project secret fails the deploy before anything is built', async () => {
  await withControl(async ({ dir, tug, builds }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), WITH_OPTIONS);
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    await assert.rejects(
      tug(['deploy', '--no-wait', '--project', 'shop']),
      /secrets not found in project shop: NPM_TOKEN/,
      'the missing secret is named',
    );
    assert.deepEqual(builds, [], 'no build ran');
  });
});

test('build.secrets cannot be built locally, because only control can read project secrets', async () => {
  await withControl(async ({ dir, tug }) => {
    await fs.writeFile(path.join(dir, 'compose.yaml'), WITH_OPTIONS);
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    await tug(['secret', 'set', 'NPM_TOKEN', '--value', 'x', '--project', 'shop']);
    await assert.rejects(
      tug(['deploy', '--build-local', '--no-wait', '--project', 'shop']),
      /web: build\.secrets are project secrets, which only control can read/,
      'a local build says why it cannot take build secrets',
    );
  });
});

test('build keys Tug does not pass on are reported, and malformed ones fail validation', () => {
  const compose = {
    services: { web: { build: { context: '.', cache_from: ['x'], target: 'a' } } },
  } as unknown as ComposeFile;
  assert.deepEqual(
    ignoredBuildKeys(compose),
    ['web: build.cache_from'],
    'only the keys outside the supported set are listed',
  );
  const errors = (build: object) =>
    composeErrors({ services: { web: { build } } } as unknown as ComposeFile, [], {
      normalized: false,
    }).join('\n');
  assert.match(
    errors({ secrets: 'NPM_TOKEN' }),
    /build\.secrets must be a list/,
    'secrets is a list',
  );
  assert.match(
    errors({ secrets: ['bad-name'] }),
    /build\.secrets entries name a project secret/,
    'a secret name is a valid value name',
  );
  assert.match(
    errors({ target: 3 }),
    /build\.target must be the name of a Dockerfile stage/,
    'target',
  );
  assert.match(errors({ args: 'A=1' }), /build\.args must be a mapping or a list/, 'args');
  assert.equal(
    errors({
      args: { A: '1' },
      secrets: [{ source: 'T', target: 'npm' }],
      additional_contexts: { a: 'b' },
    }),
    '',
    'the supported shapes pass',
  );
});
