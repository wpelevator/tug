import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalBuildSnapshot } from '../../src/cli/build.ts';

const exec = promisify(execFile);

test('a local COPY build cannot include excluded Tug credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-local-image-test-'));
  const source = path.join(dir, 'source');
  const staging = path.join(dir, 'staging');
  const output = path.join(dir, 'image-files');
  const tag = `tug-local-snapshot-test:${crypto.randomBytes(8).toString('hex')}`;
  let container: string | undefined;
  try {
    await fs.mkdir(source);
    await fs.mkdir(staging);
    await fs.writeFile(
      path.join(source, 'Dockerfile'),
      'FROM scratch\nCOPY . /app\nCMD ["/missing"]\n',
    );
    await fs.writeFile(path.join(source, 'app.txt'), 'safe application content');
    await fs.writeFile(path.join(source, 'secret.credential.json'), 'dummy secret');
    await fs.writeFile(path.join(source, 'custom.json'), 'dummy custom credential');
    await fs.writeFile(
      path.join(source, '.dockerignore'),
      '!secret.credential.json\n!custom.json\n',
    );
    const snapshot = await createLocalBuildSnapshot(source, staging, [
      path.join(source, 'custom.json'),
    ]);
    await exec('docker', ['build', '-t', tag, snapshot]);
    container = (await exec('docker', ['create', tag])).stdout.trim();
    await exec('docker', ['cp', `${container}:/app`, output]);
    assert.equal(
      await fs.readFile(path.join(output, 'app.txt'), 'utf8'),
      'safe application content',
      'the image must include intended application files',
    );
    for (const name of ['secret.credential.json', 'custom.json'])
      await assert.rejects(
        fs.access(path.join(output, name)),
        { code: 'ENOENT' },
        'the image must not contain excluded credentials',
      );
  } finally {
    if (container) await exec('docker', ['rm', '-f', container]).catch(() => {});
    await exec('docker', ['image', 'rm', tag]).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
