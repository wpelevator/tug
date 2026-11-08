import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl } from '../../../tests/helpers.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

test('domain commands reach the control over mTLS and report its answers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-domain-cli-'));
  const control = await startMtlsControl(dir);
  const run = (...args: string[]) =>
    exec(process.execPath, [entry, 'domain', ...args], {
      cwd: dir,
      env: { ...process.env, ...control.env, TUG_CREDENTIAL: '', TUG_PROJECT: 'site' },
      timeout: 10000,
    });
  try {
    assert.deepEqual(
      JSON.parse((await run('list')).stdout),
      { domains: [] },
      'a project with no mapped domains lists none',
    );
    await assert.rejects(
      run('add', 'mapped.example.org', '--service', 'web'),
      (error: Error & { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1, 'a refused mapping exits with code 1');
        assert.match(
          error.stderr ?? '',
          /409.*no current deployment/s,
          "the CLI shows control's reason: there is no deployment to serve the domain on",
        );
        return true;
      },
      'a domain cannot be mapped before the project has a deployment',
    );
    await assert.rejects(
      run('add', 'mapped.example.org'),
      (error: Error & { code?: number; stderr?: string }) => {
        assert.match(error.stderr ?? '', /--service/, 'the missing option is named');
        return true;
      },
      'the service is required, because a domain has to be served by some route',
    );
    await assert.rejects(
      run('remove', 'mapped.example.org'),
      (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? '', /404/, 'removing an unknown domain is a 404');
        return true;
      },
      'removing a domain that is not mapped fails',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
