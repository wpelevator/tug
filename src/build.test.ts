import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { buildAndPush, run, unpackContext } from './build.ts';

test('source extraction accepts regular files and rejects symlinks before extraction', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-source-'));
  try {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'Dockerfile'), 'FROM scratch\n');
    const file = path.join(dir, 'context.tgz');
    await tar.c({ file, gzip: true, cwd: source }, ['Dockerfile']);
    await unpackContext(file, target);
    assert.equal(
      await fs.readFile(path.join(target, 'Dockerfile'), 'utf8'),
      'FROM scratch\n',
      'regular source files must extract unchanged',
    );
    await fs.symlink('/etc/passwd', path.join(source, 'outside'));
    await tar.c({ file, gzip: true, cwd: source }, ['Dockerfile', 'outside']);
    await assert.rejects(
      unpackContext(file, target),
      /unsafe entries/,
      'source symlinks must be rejected before they can expose paths outside the uploaded root',
    );
    assert.deepEqual(
      await fs.readdir(target),
      [],
      'unsafe source contexts must not be partially extracted',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('build paths and Dockerfiles cannot escape the uploaded build root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-build-root-'));
  try {
    await assert.rejects(
      buildAndPush({
        contextDir: dir,
        service: 'app',
        buildSpec: '../outside',
        imageRef: 'unused',
        push: false,
      }),
      /context escapes/,
      'build context traversal must fail before invoking Docker',
    );
    await assert.rejects(
      buildAndPush({
        contextDir: dir,
        service: 'app',
        buildSpec: { context: '.', dockerfile: '../Dockerfile' },
        imageRef: 'unused',
        push: false,
      }),
      /Dockerfile escapes/,
      'Dockerfile traversal must fail before invoking Docker',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('missing executable errors reject the runner rather than hanging', async () => {
  await assert.rejects(
    run('tug-deliberately-missing-build-runner', []),
    /ENOENT/,
    'a missing Docker/build executable must reject with its actionable spawn error',
  );
});
