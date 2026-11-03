import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startMtlsControl } from '../tests/helpers.ts';

const exec = promisify(execFile);

test('whole-document stdin commands and HTTP commands exit after completing their work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-stdin-exit-'));
  const control = await startMtlsControl(dir);
  const env = {
    ...process.env,
    ...control.env,
    TUG_CREDENTIAL: '',
    TUG_PROJECT: 'site',
    TUG_CREDENTIALS_DIR: path.join(dir, 'credentials'),
    TUG_STATE_DIR: path.join(dir, 'agent'),
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
  };
  const run = (entry: string, args: string[], input?: string) => {
    const running = exec(process.execPath, [path.resolve(entry), ...args], {
      cwd: dir,
      env,
      timeout: 10000,
    });
    // Document readers require EOF; other commands must finish with the pipe still open.
    if (input !== undefined) running.child.stdin!.end(input);
    return running;
  };
  const cli = (args: string[], input?: string) => run('src/cli.ts', args, input);
  try {
    const imported = await cli(['init', '-'], JSON.stringify(control.root));
    assert.match(
      imported.stdout,
      /imported credential/,
      'init should import stdin and exit after EOF',
    );

    const identity = await run('src/main.ts', ['agent', 'identity']);
    assert.match(
      identity.stdout,
      /BEGIN CERTIFICATE REQUEST/,
      'agent identity should print its CSR and exit',
    );
    const registered = await cli(['node', 'register', 'app1', '--csr', '-'], identity.stdout);
    assert.equal(
      JSON.parse(registered.stdout).node.name,
      'app1',
      'node register should read the complete CSR and exit after the API response',
    );
    const installed = await run('src/main.ts', ['agent', 'install-cert'], registered.stdout);
    assert.match(
      installed.stdout,
      /installed identity for node app1/,
      'install-cert should exit after installing stdin',
    );

    const destination = await cli(
      [
        'backup',
        'destination',
        'set',
        's3:https://s3.example.com/bucket/tug',
        '--env',
        'AWS_ACCESS_KEY_ID',
        '--env',
        'AWS_SECRET_ACCESS_KEY',
      ],
      'test-access-key\ntest-secret-key\n',
    );
    assert.ok(
      JSON.parse(destination.stdout).ok,
      'backup destination set should read credential lines and exit after EOF and the API response',
    );

    for (const args of [
      ['node', 'list'],
      ['secret', 'list'],
      ['status', '--json'],
      ['events'],
      ['backup', 'destination', 'show'],
      ['backup', 'destination', 'remove'],
    ]) {
      const result = await cli(args);
      assert.ok(
        result.stdout.trim(),
        `${args.join(' ')} should print its result and exit with stdin open`,
      );
    }
    await assert.rejects(
      cli(['secret', 'list', '--project', '_reserved']),
      (error: Error & { code?: number; stderr?: string }) => {
        assert.equal(
          error.code,
          1,
          'an HTTP command failure should exit with code 1 while stdin stays open',
        );
        assert.match(error.stderr ?? '', /400/, 'HTTP failures should retain the API error');
        return true;
      },
      'HTTP error responses should close the transport and allow the CLI to exit',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
