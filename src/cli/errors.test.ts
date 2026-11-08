import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { findConfigInParents } from './config.ts';

const exec = promisify(execFile);
const entry = path.resolve(import.meta.dirname, '../cli.ts');

async function failure(args: string[], cwd: string): Promise<string> {
  try {
    await exec(process.execPath, [entry, ...args], {
      cwd,
      env: { ...process.env, TUG_CONFIG: '', TUG_CREDENTIAL: '', TUG_CREDENTIAL_FILE: '', CI: '' },
      timeout: 15000,
    });
  } catch (error) {
    return (error as { stderr: string }).stderr;
  }
  assert.fail(`tug ${args.join(' ')} should have failed`);
}

test('the usage footer only follows mistakes in arguments, not failures of a command that ran', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-errors-'));
  try {
    assert.match(
      await failure(['status', '--port', 'x', '--name', 'bad name'], dir),
      /unknown option/,
      'commander reports unknown options itself',
    );
    assert.match(
      await failure(['node', 'add', '--name', 'bad name', 'root@host'], dir),
      /--name must contain only[\s\S]*Run tug <command> --help for usage\./,
      'rejected arguments should point at the help',
    );
    const unreachable = await failure(
      ['node', 'add', 'root@host.invalid', '--name', 'app1', '-y'],
      dir,
    );
    assert.ok(
      !unreachable.includes('--help for usage'),
      'a failure after a command began its work (here: no credential for node add) is not a usage mistake',
    );
    const runtime = await failure(['status'], dir);
    assert.match(runtime, /no credential/, 'a missing credential is reported');
    assert.ok(
      !runtime.includes('--help for usage'),
      'an error from a command that already ran must not suggest reading the help',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing config names the nearest parent directory that has one', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-parent-')));
  try {
    const child = path.join(root, 'sites', 'blog');
    await fs.mkdir(child, { recursive: true });
    assert.equal(
      await findConfigInParents(child),
      undefined,
      'no parent config means nothing to suggest',
    );
    await fs.writeFile(path.join(root, 'tug.yml'), 'project: blog\n');
    assert.equal(
      await findConfigInParents(child),
      path.join(root, 'tug.yml'),
      'the nearest parent config is found',
    );
    const stderr = await failure(['status'], child);
    assert.match(
      stderr,
      new RegExp(`but ${path.join(root, 'tug.yml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exists`),
      'the credential error should say where the config is',
    );
    assert.match(stderr, /run tug from .* or pass --config/, 'and how to use it');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
