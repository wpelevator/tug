import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCommand, buildImage } from './build.ts';
import type { BuildSecretValue, BuildSpec } from './build.ts';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-build-options-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const command = (dir: string, buildSpec: BuildSpec | string, secrets?: BuildSecretValue[]) =>
  buildCommand({
    contextDir: dir,
    service: 'web',
    buildSpec,
    imageRef: 'tug-build/p/web:1',
    secrets,
    env: {},
  });

test('build args and target become --build-arg and --target, in either Compose syntax', async () => {
  await withDir(async (dir) => {
    const mapping = command(dir, {
      context: '.',
      target: 'production',
      args: { NODE_VERSION: '22', EMPTY: '', UNSET: null as unknown as string },
    }).args;
    assert.deepEqual(
      mapping,
      [
        '--target',
        'production',
        '--build-arg',
        'NODE_VERSION=22',
        '--build-arg',
        'EMPTY=',
        '-t',
        'tug-build/p/web:1',
        dir,
      ],
      'args and target are passed to docker build; an arg without a value is dropped',
    );
    assert.deepEqual(
      command(dir, { args: ['A=1', 'B', 'C=x=y'] }).args.filter((arg) => arg.includes('=')),
      ['A=1', 'C=x=y'],
      'the list syntax splits on the first = and drops a bare name',
    );
  });
});

test('build secrets reach docker through the environment and never through the arguments', async () => {
  await withDir(async (dir) => {
    const built = command(dir, {}, [
      { id: 'NPM_TOKEN', value: 'npm-secret-value' },
      { id: 'gh', value: 'gh-secret-value' },
    ]);
    assert.deepEqual(
      built.args.slice(0, 4),
      [
        '--secret',
        'id=NPM_TOKEN,env=TUG_BUILD_SECRET_0',
        '--secret',
        'id=gh,env=TUG_BUILD_SECRET_1',
      ],
      'each secret is mounted under its id from its own variable',
    );
    assert.ok(
      !built.args.join(' ').includes('secret-value'),
      'no secret value appears in the process arguments',
    );
    assert.equal(
      built.env.TUG_BUILD_SECRET_0,
      'npm-secret-value',
      'the value travels in the environment',
    );
    assert.equal(
      built.env.DOCKER_BUILDKIT,
      '1',
      'BuildKit is requested because only it has --secret',
    );
    assert.deepEqual(
      command(dir, { secrets: ['npm_token'] }).args.filter((arg) => arg === '--secret'),
      [],
      'the names in build.secrets alone mount nothing: only the secrets control resolved are passed',
    );
  });
});

test('additional_contexts become --build-context, and a path cannot leave the uploaded source', async () => {
  await withDir(async (dir) => {
    const built = command(dir, {
      additional_contexts: {
        shared: './shared',
        base: 'docker-image://alpine:3.20',
        repo: 'https://github.com/acme/lib.git',
      },
    }).args;
    assert.deepEqual(
      built.filter((arg) => arg.includes('=')),
      [
        `shared=${path.join(dir, 'shared')}`,
        'base=docker-image://alpine:3.20',
        'repo=https://github.com/acme/lib.git',
      ],
      'a relative path is resolved inside the source and images and URLs are passed through',
    );
    assert.throws(
      () => command(dir, { additional_contexts: { up: '../outside' } }),
      /build\.additional_contexts up of web escapes the uploaded root/,
      'a path outside the uploaded source is refused',
    );
    assert.throws(
      () => command(dir, { additional_contexts: { other: 'service:api' } }),
      /points at another service/,
      'a service: context is refused with the alternative',
    );
  });
});

/** A `docker` that records its arguments and the secret variables it was given, then fails with the secret in its output. */
async function fakeDocker(dir: string, options: { buildx: boolean; fail?: boolean }) {
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const log = path.join(dir, 'docker.log');
  await fs.writeFile(
    path.join(bin, 'docker'),
    [
      '#!/bin/sh',
      `echo "$@" >> ${log}`,
      `[ "$1" = buildx ] && [ "$2" = version ] && exit ${options.buildx ? 0 : 1}`,
      `echo "TUG_BUILD_SECRET_0=$TUG_BUILD_SECRET_0" >> ${log}`,
      options.fail ? 'echo "RUN printed $TUG_BUILD_SECRET_0" >&2; exit 3' : 'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
}

test('a failed build never shows a secret value, even when the Dockerfile printed it', async () => {
  await withDir(async (dir) => {
    const docker = await fakeDocker(dir, { buildx: true, fail: true });
    await assert.rejects(
      buildImage({
        contextDir: dir,
        service: 'web',
        buildSpec: {},
        imageRef: 'tug-build/p/web:1',
        env: docker.env,
        secrets: [{ id: 'TOKEN', value: 'hunter2-value' }],
      }),
      (error: Error) => {
        assert.ok(
          !error.message.includes('hunter2-value'),
          'the secret value is redacted from the error',
        );
        assert.match(error.message, /RUN printed \*\*\*/, 'the rest of the output is kept');
        return true;
      },
      'the build failure is reported',
    );
    assert.match(
      await fs.readFile(docker.log, 'utf8'),
      /^build --secret id=TOKEN,env=TUG_BUILD_SECRET_0 -t tug-build\/p\/web:1 /m,
      'a plain build uses docker build without buildx',
    );
  });
});

test('additional_contexts use docker buildx and fail clearly when it is missing', async () => {
  await withDir(async (dir) => {
    const missing = await fakeDocker(dir, { buildx: false });
    await assert.rejects(
      buildImage({
        contextDir: dir,
        service: 'web',
        buildSpec: { additional_contexts: { base: 'docker-image://alpine' } },
        imageRef: 'tug-build/p/web:1',
        env: missing.env,
      }),
      /web: build\.additional_contexts needs docker buildx, which is not installed where the image is built/,
      'a host without buildx explains what to install or remove',
    );
    assert.ok(
      !(await fs.readFile(missing.log, 'utf8')).includes('--build-context'),
      'docker is not asked to build without buildx',
    );
  });
  await withDir(async (dir) => {
    const present = await fakeDocker(dir, { buildx: true });
    await buildImage({
      contextDir: dir,
      service: 'web',
      buildSpec: { additional_contexts: { base: 'docker-image://alpine' } },
      imageRef: 'tug-build/p/web:1',
      env: present.env,
    });
    assert.match(
      await fs.readFile(present.log, 'utf8'),
      /^buildx build --load --build-context base=docker-image:\/\/alpine -t tug-build\/p\/web:1 /m,
      'with buildx the image is built with docker buildx build --load',
    );
  });
});
