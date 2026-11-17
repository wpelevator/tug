import assert from 'node:assert/strict';
import test from 'node:test';
import { LAZY_COMMANDS } from './program.ts';
import { cliOutcome, execCli } from '../../tests/cli-inprocess.ts';

const topLevel = (help: string): string[] =>
  [
    ...(/\nCommands:\n([\s\S]*?)(?:\n\n|\n*$)/.exec(help)?.[1] ?? '').matchAll(
      /^ {2}([a-z][a-z-]*)/gm,
    ),
  ]
    .map((m) => m[1])
    .filter((name) => name !== 'help');

test('runCli returns the exit code instead of exiting the process', async () => {
  const help = await cliOutcome(['--help']);
  assert.equal(help.code, 0, 'help should exit 0');
  assert.match(help.stdout, /Usage: tug/, 'help should go to stdout');
  assert.equal((await cliOutcome(['--version'])).code, 0, '--version should exit 0');
  const unknown = await cliOutcome(['no-such-command']);
  assert.equal(unknown.code, 1, 'an unknown command should exit 1');
  assert.match(unknown.stderr, /unknown command 'no-such-command'/, 'and say which command');
  const subcommand = await cliOutcome(['credential', 'create']);
  assert.equal(
    subcommand.code,
    1,
    'a missing argument of a subcommand should exit 1, not end the process',
  );
});

test('every top-level command is reachable by name alone, so loading only it keeps it working', async () => {
  const { stdout } = await execCli(['--help']);
  const names = topLevel(stdout);
  assert.ok(names.length >= 25, `the full help should list every command (found ${names.length})`);
  assert.deepEqual(
    [...LAZY_COMMANDS].sort(),
    [...names].sort(),
    'every command in the help must be registered for lazy loading, and nothing else',
  );
  for (const name of names) {
    const own = await cliOutcome([name, '--help']);
    assert.equal(own.code, 0, `tug ${name} --help should work when only that command is loaded`);
    assert.match(
      own.stdout,
      new RegExp(`Usage: tug ${name}\\b`),
      `${name} should print its own usage`,
    );
  }
});

test('root options before the command name still select that command', async () => {
  const result = await cliOutcome([
    '--project',
    'other',
    '--config=none.json',
    'credential',
    '--help',
  ]);
  assert.equal(
    result.code,
    0,
    'root options with values should be skipped when finding the command',
  );
  assert.match(
    result.stdout,
    /Usage: tug credential/,
    'the named command should be the one loaded',
  );
});

test('execCli restores the environment, working directory and exit code after a run', async () => {
  const before = { env: { ...process.env }, cwd: process.cwd() };
  await cliOutcome(['no-such-command'], { env: { ONLY_THIS: '1' }, cwd: '/' });
  assert.deepEqual({ ...process.env }, before.env, 'the process environment should be restored');
  assert.equal(process.cwd(), before.cwd, 'the working directory should be restored');
  assert.equal(
    process.exitCode,
    undefined,
    'a failed command should not leave an exit code on the test process',
  );
});
