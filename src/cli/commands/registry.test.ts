import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../../tests/helpers.ts';
import { cliOutcome, execCli } from '../../../tests/cli-inprocess.ts';

test('registry login reads the token from stdin, prints no token, and refuses a terminal or empty stdin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-registry-cli-'));
  const control = await startMtlsControl(dir);
  try {
    const env = { ...process.env, ...control.env, TUG_CREDENTIAL: '', CI: '1' };
    const login = (host: string, input: string | undefined, tty = false) =>
      cliOutcome(['registry', 'login', host, '--username', 'octo', '--project', 'shop'], {
        cwd: dir,
        env,
        input,
        tty,
      });
    const ok = await login('ghcr.io', 'ghp_secret_token\n');
    assert.equal(ok.code, 0, 'a piped token is accepted');
    assert.ok(
      !ok.stdout.includes('ghp_secret_token') && !ok.stderr.includes('ghp_secret_token'),
      'the token is never printed',
    );
    assert.deepEqual(JSON.parse(ok.stdout).hosts, ['ghcr.io'], 'the host is listed');
    const more = await login('registry.example.com', 'second');
    assert.deepEqual(
      JSON.parse(more.stdout).hosts,
      ['ghcr.io', 'registry.example.com'],
      'a second login keeps the first host',
    );
    const names = JSON.parse(
      (await execCli(['secret', 'list', '--project', 'shop'], { cwd: dir, env })).stdout,
    );
    assert.deepEqual(
      names.secrets.map((s: { name: string }) => s.name),
      ['TUG_REGISTRY_AUTH'],
      'the credentials are one project secret',
    );
    const empty = await login('ghcr.io', undefined);
    assert.notEqual(empty.code, 0, 'empty stdin fails');
    assert.match(empty.stderr, /stdin was empty/, 'the failure says what to pipe');
    const tty = await login('ghcr.io', undefined, true);
    assert.notEqual(tty.code, 0, 'a terminal is refused so the token is not typed into history');
    assert.match(tty.stderr, /pipe the token in/, 'the failure shows the piped form');
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
