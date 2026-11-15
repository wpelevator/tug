import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl } from '../../tests/helpers.ts';
import { discoverAddresses, hostHasDocker, remoteHostname } from './commands/host.ts';
import { runCapture, runLocal, runStep, SshHostKeyError, sshHostKeyHint } from './process.ts';

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve('src/cli.ts');
const REFUSAL = 'Host key verification failed.';

test('sshHostKeyHint names the host and the ssh-keygen -R remedy only for a host key refusal', () => {
  const hint = sshHostKeyHint('ssh', ['--', 'root@203.0.113.9', 'true'], `\n${REFUSAL}\n`);
  assert.match(
    hint ?? '',
    /ssh-keygen -R 203\.0\.113\.9/,
    'the remedy names the host without user@',
  );
  assert.match(hint ?? '', /did not fail/, 'the hint says the connection itself did not fail');
  assert.match(
    hint ?? '',
    /never edits known_hosts or turns off host key checking/,
    'the hint states that tug leaves known_hosts and host key checking alone',
  );
  assert.match(
    sshHostKeyHint('ssh', ['--', 'ops@[2001:db8::1]', 'true'], REFUSAL) ?? '',
    /ssh-keygen -R 2001:db8::1\b/,
    'an IPv6 target loses its brackets',
  );
  assert.match(
    sshHostKeyHint('scp', ['-q', '--', '/tmp/a.tar', 'root@203.0.113.9:/tmp/a.tar'], REFUSAL) ?? '',
    /ssh-keygen -R 203\.0\.113\.9\b/,
    'an scp transfer names its host, not the path',
  );
  assert.equal(
    sshHostKeyHint('ssh', ['--', 'root@h', 'true'], 'Connection refused'),
    undefined,
    'other ssh failures get no host key hint',
  );
  assert.equal(
    sshHostKeyHint('docker', ['build'], REFUSAL),
    undefined,
    'only ssh and scp output is explained',
  );
});

async function withFakeSsh<T>(
  script: string,
  run: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-hostkey-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ssh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  try {
    return await run(dir, { ...process.env, PATH: process.env.PATH });
  } finally {
    process.env.PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const REFUSE = `echo '${REFUSAL}' >&2; exit 255`;

test('runStep, runCapture and runLocal explain a host key refusal and keep other ssh failures as they are', async () => {
  await withFakeSsh(REFUSE, async () => {
    const args = ['--', 'root@203.0.113.9', 'true'];
    for (const [name, run] of [
      ['runStep', () => runStep('ssh', args)],
      ['runCapture', () => runCapture('ssh', args)],
      ['runLocal', () => runLocal('ssh', args)],
    ] as const) {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(
        error instanceof SshHostKeyError,
        `${name} should throw an SshHostKeyError on a host key refusal`,
      );
      assert.match(
        (error as Error).message,
        /ssh-keygen -R 203\.0\.113\.9/,
        `${name} should print the ssh-keygen -R remedy`,
      );
    }
  });
  await withFakeSsh(`echo 'Connection refused' >&2; exit 255`, async () => {
    const error = await runCapture('ssh', ['--', 'root@h', 'true']).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    assert.ok(
      error && !(error instanceof SshHostKeyError) && !/ssh-keygen/.test(error.message),
      'a refused connection must not be described as a host key problem',
    );
  });
});

test('host probes stop on a host key refusal instead of reading it as no Docker or no answer', async () => {
  await withFakeSsh(REFUSE, async () => {
    for (const [name, probe] of [
      ['hostHasDocker', () => hostHasDocker('root@203.0.113.9')],
      ['remoteHostname', () => remoteHostname('root@203.0.113.9')],
      ['discoverAddresses', () => discoverAddresses('root@203.0.113.9')],
    ] as const)
      assert.throws(
        probe,
        /ssh-keygen -R 203\.0\.113\.9/,
        `${name} should raise the host key explanation`,
      );
  });
  await withFakeSsh('exit 1', async () => {
    assert.equal(
      hostHasDocker('root@h'),
      false,
      'a host without Docker still reads as false, not as an error',
    );
  });
});

test('every command that runs ssh prints the ssh-keygen -R remedy and never touches known_hosts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-hostkey-cli-'));
  const control = await startMtlsControl(path.join(dir, 'data'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ssh'), `#!/bin/sh\n${REFUSE}\n`, { mode: 0o755 });
  const home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  const knownHosts = path.join(home, '.ssh', 'known_hosts');
  await fs.writeFile(knownHosts, '203.0.113.9 ssh-ed25519 AAAAstale\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...control.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TUG_CONFIG: path.join(dir, 'cfg.json'),
  };
  await fs.writeFile(env.TUG_CONFIG as string, '{}');
  const target = 'root@203.0.113.9';
  // Registered by an earlier add, as for any host that is already a node.
  await control.registerNode('n1');
  const cli = (...args: string[]) =>
    execFileAsync(process.execPath, [cliEntry, ...args], { env, cwd: dir });
  try {
    for (const args of [
      ['node', 'add', target, '--name', 'n1', '--no-wait'],
      ['node', 'replace', 'n1', target, '--no-wait'],
      ['node', 'repair', 'n1', target, '--no-wait'],
      ['node', 'upgrade', 'n1', target, '--no-wait'],
      ['node', 'migrate', 'n1', target, '--no-wait'],
      ['node', 'remove', 'n1', target, '--teardown', '-y'],
      [
        'control',
        'setup',
        target,
        '--install-docker',
        '-y',
        '--no-import',
        '--credential-out',
        path.join(dir, 'c'),
      ],
      ['control', 'upgrade', target, '-y'],
      ['control', 'migrate', target],
      ['control', 'stop', target, '-y'],
      ['control', 'restart', target, '-y'],
    ]) {
      const label = `tug ${args.slice(0, 2).join(' ')}`;
      const failure = await cli(...args).then(
        () => undefined,
        (e: unknown) => e as { stderr: string; stdout: string },
      );
      assert.ok(failure, `${label} should fail when ssh refuses the host key`);
      assert.match(
        `${failure.stderr}${failure.stdout}`,
        /ssh-keygen -R 203\.0\.113\.9/,
        `${label} should name the ssh-keygen -R remedy`,
      );
    }
    assert.equal(
      await fs.readFile(knownHosts, 'utf8'),
      '203.0.113.9 ssh-ed25519 AAAAstale\n',
      'tug must leave known_hosts as it found it',
    );
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
