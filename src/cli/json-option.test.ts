import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMtlsControl } from '../../tests/helpers.ts';
import { addJsonOption } from './json-option.ts';

const exec = promisify(execFile);
const cliEntry = new URL('../cli.ts', import.meta.url).pathname;

test('addJsonOption gives every result command a --json option and leaves the rest alone', () => {
  const program = new Command('tug');
  const node = program.command('node');
  node.command('list').option('--json', 'its own help');
  node.command('remove');
  program.command('exec [service] [command...]');
  const backup = program.command('backup');
  backup.command('run');
  program.command('deploy').option('--json', 'own').command('cancel');
  addJsonOption(program);
  const has = (command: Command) => command.options.filter((o) => o.long === '--json');
  assert.equal(has(node).length, 0, 'a command that only groups subcommands gets no option');
  assert.equal(
    has(node.commands[0])[0].description,
    'its own help',
    'a declared --json is kept as written',
  );
  assert.equal(has(node.commands[1]).length, 1, 'a command that prints JSON already gets the flag');
  assert.equal(
    has(program.commands[1]).length,
    0,
    'exec passes container output through and takes no --json',
  );
  assert.equal(
    has(backup.commands[0]).length,
    1,
    '`backup run` is not mistaken for the raw-output `run`',
  );
  const deploy = program.commands[3];
  assert.equal(
    has(deploy).length,
    1,
    'a command with subcommands and its own options keeps one --json',
  );
  assert.equal(has(deploy.commands[0]).length, 1, 'its subcommand gets the flag too');
});

/** Every leaf command path of the real CLI, found by following `Commands:` in each --help. */
async function leafCommands(prefix: string[] = []): Promise<{ path: string[]; help: string }[]> {
  const { stdout } = await exec('node', ['src/cli.ts', ...prefix, '--help']);
  const section = /\nCommands:\n([\s\S]*?)(?:\n\n|\n*$)/.exec(stdout)?.[1];
  const children = (section ?? '')
    .split('\n')
    .map((line) => /^ {2}([a-z][a-z-]*)(?:\||\s|$)/.exec(line)?.[1])
    .filter((name): name is string => !!name && name !== 'help');
  if (!children.length) return [{ path: prefix, help: stdout }];
  const nested = await Promise.all(children.map((name) => leafCommands([...prefix, name])));
  // A command with subcommands and its own options (deploy) is a leaf too.
  return [
    ...(prefix.length && /--file|--version/.test(stdout) ? [{ path: prefix, help: stdout }] : []),
    ...nested.flat(),
  ];
}

test('every command that produces a result accepts --json', { timeout: 120_000 }, async () => {
  const leaves = await leafCommands();
  assert.ok(
    leaves.length > 40,
    `the walk should find the whole command tree (found ${leaves.length})`,
  );
  const raw = new Set(['exec', 'run', 'logs']);
  const missing = leaves
    .filter((leaf) => !raw.has(leaf.path.join(' ')) && !/--json\b/.test(leaf.help))
    .map((leaf) => leaf.path.join(' '));
  assert.deepEqual(missing, [], 'these commands print a result but offer no --json');
  for (const name of raw) {
    const leaf = leaves.find((l) => l.path.join(' ') === name);
    assert.ok(
      leaf && !/--json\b/.test(leaf.help),
      `${name} writes container output and takes no --json`,
    );
  }
});

test(
  'result commands print one JSON document with --json against a real control',
  { timeout: 60_000 },
  async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tug-json-'));
    const control = await startMtlsControl(path.join(dir, 'data'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...control.env,
      TUG_CONFIG: path.join(dir, 'cfg.json'),
      TUG_CREDENTIALS_DIR: path.join(dir, 'credentials'),
    };
    await fsp.writeFile(env.TUG_CONFIG as string, '{}');
    const cli = async (...args: string[]) =>
      (await exec(process.execPath, [cliEntry, ...args], { env, cwd: dir })).stdout;
    try {
      const secrets = JSON.parse(await cli('secret', 'list', '--json'));
      assert.ok(Array.isArray(secrets.secrets), 'secret list --json prints the secrets document');
      const restores = JSON.parse(await cli('restore', 'list', '--json'));
      assert.deepEqual(
        restores,
        { restores: [] },
        'restore list --json prints the list, not "no restores"',
      );
      const backups = JSON.parse(await cli('backup', 'list', '--json'));
      assert.ok(
        Array.isArray(backups.targets) && Array.isArray(backups.runs),
        'backup list --json prints the catalog with its targets and runs',
      );
      const init = JSON.parse(await cli('init', control.credentialFile, '--json'));
      assert.equal(init.ok, true, 'init --json reports success as JSON instead of "wrote" lines');
      assert.ok(
        init.credentialFile.startsWith(path.join(dir, 'credentials')),
        'init --json names the credential file it stored',
      );
    } finally {
      await control.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  },
);
