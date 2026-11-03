import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  inferNodeName,
  isPrivateIPv4,
  parseAddressCandidates,
  sortCandidates,
} from './cli-onboarding.ts';
import { choose, confirm, type Prompter } from './cli-prompt.ts';
import { commandPath } from './cli-config.ts';
import { formatNodes } from './cli-status.ts';

const exec = promisify(execFile);
const entry = path.resolve(import.meta.dirname, 'cli.ts');

const answers =
  (...given: string[]): Prompter =>
  async () =>
    given.shift() ?? '';

test('inferNodeName uses the first DNS label and refuses IP addresses', () => {
  assert.equal(inferNodeName('root@app1.example.com'), 'app1', 'the first label names the node');
  assert.equal(inferNodeName('app1'), 'app1', 'a bare host is its own name');
  assert.equal(inferNodeName('root@app1:2222'), 'app1', 'a port is not part of the name');
  assert.equal(inferNodeName('root@203.0.113.7'), undefined, 'an IPv4 address suggests no name');
  assert.equal(inferNodeName('root@[2001:db8::1]'), undefined, 'an IPv6 address suggests no name');
});

test('isPrivateIPv4 covers RFC 1918 and carrier-grade NAT only', () => {
  for (const address of ['10.0.0.7', '172.16.0.1', '172.31.255.1', '192.168.1.5', '100.64.0.9'])
    assert.ok(isPrivateIPv4(address), `${address} should be private`);
  for (const address of ['203.0.113.7', '172.32.0.1', '100.128.0.1', '8.8.8.8'])
    assert.ok(!isPrivateIPv4(address), `${address} should be public`);
});

test('parseAddressCandidates reads ip output and sortCandidates puts private addresses first', () => {
  const output = [
    '2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0',
    '3: eth1    inet 10.0.0.7/24 brd 10.0.0.255 scope global eth1',
    'garbage',
  ].join('\n');
  const candidates = parseAddressCandidates(output);
  assert.deepEqual(
    candidates.map((c) => c.address),
    ['203.0.113.7', '10.0.0.7'],
    'every global IPv4 line is parsed and other lines are ignored',
  );
  assert.deepEqual(
    sortCandidates(candidates).map((c) => [c.interface, c.private]),
    [
      ['eth1', true],
      ['eth0', false],
    ],
    'the private address is offered first',
  );
});

test('confirm takes the default on an empty answer and retries on nonsense', async () => {
  assert.equal(await confirm('ok?', true, answers('')), true, 'empty takes the yes default');
  assert.equal(await confirm('ok?', false, answers('')), false, 'empty takes the no default');
  assert.equal(await confirm('ok?', false, answers('maybe', 'YES')), true, 'invalid input re-asks');
  assert.equal(await confirm('ok?', true, answers('n')), false, 'n declines');
});

test('choose returns the picked index, the default on empty and re-asks on out of range', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await choose('which?', ['a', 'b'], 1, answers('')), 1, 'empty takes the default');
    assert.equal(
      await choose('which?', ['a', 'b'], 0, answers('2')),
      1,
      'a number picks the option',
    );
    assert.equal(
      await choose('which?', ['a', 'b'], 0, answers('9', 'x', '1')),
      0,
      'bad input re-asks',
    );
  } finally {
    console.error = original;
  }
});

test('commandPath joins group names and resolves the setup shortcut', () => {
  const program = new Command();
  const node = program.command('node');
  const add = node.command('add');
  const setup = program.command('setup');
  const deploy = program.command('deploy');
  assert.equal(commandPath(add), 'node add', 'a grouped verb is space-joined');
  assert.equal(commandPath(deploy), 'deploy', 'a top-level command is its own name');
  assert.equal(commandPath(setup), 'control setup', 'setup is the control setup shortcut');
});

test('formatNodes prints an aligned table, flags disabled nodes and handles none', () => {
  assert.equal(formatNodes([]), 'No nodes', 'no nodes says so');
  const table = formatNodes([
    {
      name: 'b',
      status: 'healthy',
      address: '10.0.0.2',
      ingress: 1,
      labels: ['x', 'y'],
      last_seen_at: 't',
    },
    {
      name: 'a',
      status: 'healthy',
      address: null,
      ingress: 0,
      labels: [],
      last_seen_at: null,
      disabled_at: 'd',
    },
  ]);
  const lines = table.split('\n');
  assert.match(lines[0], /^NODE\s+STATUS\s+ADDRESS\s+INGRESS/, 'a header row comes first');
  assert.match(
    lines[1],
    /^a\s+disabled\s+-\s+no\s+-\s+never$/,
    'nodes are sorted and disabled shows',
  );
  assert.match(lines[2], /^b\s+healthy\s+10\.0\.0\.2\s+yes\s+x,y\s+t$/, 'ingress and labels show');
});

test('the CLI is grouped: setup mirrors control setup, node add needs a name for an IP, old names are gone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-groups-'));
  const env = { ...process.env, TUG_CONFIG: path.join(dir, 'cfg.json'), CI: '1' };
  await fs.writeFile(env.TUG_CONFIG, '{}');
  const run = (...args: string[]) => exec(process.execPath, [entry, ...args], { env, cwd: dir });
  try {
    const flags = (help: string) => [...help.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(
      flags((await run('setup', '--help')).stdout),
      flags((await run('control', 'setup', '--help')).stdout),
      'setup should take the same options as control setup',
    );
    const nodeHelp = (await run('node', '--help')).stdout;
    for (const verb of ['add', 'list', 'replace', 'repair', 'remove', 'disable', 'ingress'])
      assert.match(nodeHelp, new RegExp(`^  ${verb}\\b`, 'm'), `node help should list ${verb}`);
    await assert.rejects(
      run('node', 'add', 'root@203.0.113.7'),
      /needs --name.*IP address/,
      'an IP address should not become a node name',
    );
    await assert.rejects(
      run('control', 'setup', 'root@host', '--no-import'),
      /--no-import needs --credential-out/,
      'skipping the import without saving the credential would lose it',
    );
    for (const legacy of ['control-install', 'node-install', 'secret-set', 'credential-list'])
      await assert.rejects(run(legacy), /unknown command/, `${legacy} should no longer exist`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
