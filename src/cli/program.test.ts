import assert from 'node:assert/strict';
import test from 'node:test';
import { LAZY_COMMANDS } from './program.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cliOutcome, execCli, withDeadline } from '../../tests/cli-inprocess.ts';
import { testRuntime } from '../../tests/cli-runtime.ts';
import { runCli } from './program.ts';

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

test('runs overlap without sharing anything: each reads its own directory, environment and flags', async () => {
  const dirs = await Promise.all(
    ['alpha', 'beta'].map(async (name) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `tug-run-${name}-`));
      // alpha is a valid Compose file; beta has a service with a bad x-tug key.
      await fs.writeFile(
        path.join(dir, 'compose.yml'),
        name === 'alpha'
          ? 'services:\n  web:\n    image: nginx\n'
          : 'services:\n  web:\n    image: nginx\n    x-tug:\n      replicas: many\n',
      );
      return dir;
    }),
  );
  try {
    const [alpha, beta] = await Promise.all(
      dirs.map((cwd) => cliOutcome(['lint', '-f', 'compose.yml', '--json'], { cwd })),
    );
    assert.equal(alpha.code, 0, 'the valid file should lint clean in its own directory');
    assert.deepEqual(JSON.parse(alpha.stdout).errors, [], 'alpha should report no findings');
    assert.equal(
      beta.code,
      1,
      'the invalid file should fail in its own directory, at the same time',
    );
    assert.ok(JSON.parse(beta.stdout).errors.length > 0, 'beta should report its own findings');
  } finally {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  }
});

test('a run leaves no trace on the process or on the next run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-trace-'));
  const before = { env: { ...process.env }, cwd: process.cwd(), exitCode: process.exitCode };
  try {
    await fs.writeFile(path.join(dir, 'compose.yml'), 'services: {}\n');
    const first = testRuntime({ env: { ONLY_THIS: '1' }, cwd: dir });
    await runCli(['--verbose', 'lint', '-f', 'compose.yml'], first.rt);
    assert.equal(first.rt.state.verbose, true, '--verbose should be recorded on its own runtime');
    assert.equal(first.rt.state.workStarted, false, 'lint does no remote work');
    const second = testRuntime();
    assert.equal(second.rt.state.verbose, false, 'the next runtime should not inherit --verbose');
    assert.deepEqual({ ...process.env }, before.env, 'the process environment should be untouched');
    assert.equal(process.cwd(), before.cwd, 'the working directory should be untouched');
    assert.equal(process.exitCode, before.exitCode, 'the process exit code should be untouched');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the exit code a command asks for is returned, not set on the process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-exit-'));
  try {
    // A bad x-tug value makes `lint` ask for exit code 1 by setting rt.exitCode, the way commands do.
    await fs.writeFile(
      path.join(dir, 'bad.yml'),
      'services:\n  web:\n    image: nginx\n    x-tug:\n      replicas: many\n',
    );
    await fs.writeFile(path.join(dir, 'ok.yml'), 'services: {}\n');
    const failing = testRuntime({ cwd: dir });
    assert.equal(
      await runCli(['lint', '-f', 'bad.yml'], failing.rt),
      1,
      'runCli should return the code the command asked for',
    );
    assert.equal(failing.rt.exitCode, 1, 'the command should record its code on the runtime');
    const passing = testRuntime({ cwd: dir });
    assert.equal(await runCli(['lint', '-f', 'ok.yml'], passing.rt), 0, 'a clean file exits 0');
    assert.equal(passing.rt.exitCode, undefined, 'a command that succeeds asks for no code');
    assert.equal(process.exitCode, undefined, 'the test process must not carry either code');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('withDeadline rejects a hung call and passes a finished one through', async () => {
  await assert.rejects(
    withDeadline(new Promise(() => {}), 20, 'stuck'),
    /stuck/,
    'a promise that never settles should be abandoned with the given message',
  );
  assert.equal(
    await withDeadline(Promise.resolve(7), 1000, 'unused'),
    7,
    'a result passes through',
  );
});
