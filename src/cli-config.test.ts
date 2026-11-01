import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { writeCredentialFile } from '../tests/helpers.ts';
import {
  CONFIG_NAMES,
  COMMAND_SETTINGS,
  NODE_SETTINGS,
  applyConfigDefaults,
  localConfigPath,
  nodeSettings,
  resolveCliConfig,
  writeInitConfig,
} from './cli-config.ts';

const exec = promisify(execFile);
const entry = path.resolve('src/cli.ts');

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-config-file-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const YAML = `# tracked
controlUrl: https://control.test
project: shop
file: compose/prod.yml
buildLocal: true
wait: false
nodeDefaults:
  installDocker: true
  mesh: true
  wgPort: 51821
  label: [base]
  image: ghcr.io/example/tug:test
nodes:
  app1:
    ssh: root@203.0.113.7
    publicAddress: 203.0.113.7
    label: [web, ingress]
  app2:
    ssh: root@203.0.113.8
    address: 10.0.0.8
`;

test('a YAML config and the same content as JSON resolve to the same settings, and YAML may carry comments', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'tug.yml'), YAML);
    const fromYaml = await resolveCliConfig({}, {}, dir);
    const json = path.join(dir, 'other.json');
    const body = (await import('js-yaml')).default.load(YAML);
    await fs.writeFile(json, JSON.stringify(body));
    const fromJson = await resolveCliConfig({ config: json }, {}, dir);
    assert.deepEqual(
      { ...fromYaml, file: '', localFile: '' },
      { ...fromJson, file: '', localFile: '' },
      'the same settings written as YAML or JSON should resolve identically',
    );
    assert.equal(fromYaml.project, 'shop', 'tug.yml should be discovered without --config');
    assert.equal(
      fromYaml.nodes.app1.ssh,
      'root@203.0.113.7',
      'node entries should be parsed from the nodes mapping',
    );
  });
});

test('the default config is found by name in order and more than one candidate is an error', async () => {
  await withDir(async (dir) => {
    for (const name of CONFIG_NAMES.slice().reverse()) {
      await fs.rm(path.join(dir, name), { force: true });
    }
    await fs.writeFile(path.join(dir, 'tug.json'), '{"project":"from-json"}');
    assert.equal(
      (await resolveCliConfig({}, {}, dir)).project,
      'from-json',
      'tug.json should be discovered when it is the only candidate',
    );
    await fs.writeFile(path.join(dir, 'tug.yaml'), 'project: from-yaml');
    await assert.rejects(
      resolveCliConfig({}, {}, dir),
      /more than one config file \(tug\.yaml, tug\.json\)/,
      'two default config files should be reported instead of silently preferring one',
    );
    assert.equal(
      (await resolveCliConfig({ config: 'tug.yaml' }, {}, dir)).project,
      'from-yaml',
      'selecting a file explicitly should bypass discovery',
    );
  });
});

test('the credential path is accepted only from the untracked overlay, the environment or a flag', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'tug.yml'), 'credential: committed.json\n');
    await assert.rejects(
      resolveCliConfig({}, {}, dir),
      /credential must not be set in a tracked file; put it in .*tug\.local\.yml/,
      'a credential path in the tracked file should be rejected with the overlay name',
    );
    await fs.writeFile(path.join(dir, 'tug.yml'), 'project: shop\n');
    const overlay = await writeCredentialFile(
      path.join(dir, 'overlay.json'),
      'https://overlay.test:8443',
    );
    await writeCredentialFile(path.join(dir, 'env.json'), 'https://env.test:8443');
    await writeCredentialFile(path.join(dir, 'flag.json'), 'https://flag.test:8443');
    await fs.writeFile(
      path.join(dir, 'tug.local.yml'),
      'credential: overlay.json\nproject: mine\n',
    );
    const local = await resolveCliConfig({}, {}, dir);
    assert.deepEqual(local.credential, overlay, 'the overlay should supply the credential');
    assert.equal(
      local.controlUrl,
      'https://overlay.test:8443',
      'the control URL defaults to the credential public URL',
    );
    assert.equal(local.project, 'mine', 'the overlay should override tracked values per key');
    assert.equal(
      (await resolveCliConfig({}, { TUG_CREDENTIAL_FILE: 'env.json' }, dir)).credential?.url,
      'https://env.test:8443',
      'TUG_CREDENTIAL_FILE should override the overlay',
    );
    assert.equal(
      (
        await resolveCliConfig(
          { credential: 'flag.json' },
          { TUG_CREDENTIAL_FILE: 'env.json' },
          dir,
        )
      ).credential?.url,
      'https://flag.test:8443',
      '--credential should override the environment',
    );
    const inline = await fs.readFile(path.join(dir, 'env.json'), 'utf8');
    await assert.rejects(
      resolveCliConfig({}, { TUG_CREDENTIAL: inline, TUG_CREDENTIAL_FILE: 'env.json' }, dir),
      /only one of TUG_CREDENTIAL and TUG_CREDENTIAL_FILE/,
      'conflicting environment credentials should be rejected',
    );
    const override = await resolveCliConfig({ controlUrl: 'https://127.0.0.1:18082' }, {}, dir);
    assert.equal(
      override.controlUrl,
      'https://127.0.0.1:18082',
      'an address override changes the connect target',
    );
    assert.equal(
      override.credential?.url,
      'https://overlay.test:8443',
      'the verified public URL stays in the credential',
    );
  });
});

test('overlay path puts .local before the extension, including for dotfiles', () => {
  assert.equal(localConfigPath('/a/tug.yml'), '/a/tug.local.yml', 'tug.yml overlay name');
  assert.equal(localConfigPath('/a/.tug.json'), '/a/.tug.local.json', '.tug.json overlay name');
  assert.equal(localConfigPath('/a/x.yaml'), '/a/x.local.yaml', 'custom file overlay name');
});

test('unknown keys, wrong types and bad values fail naming the file and the key', async () => {
  await withDir(async (dir) => {
    const bad: [string, RegExp, string][] = [
      ['colour: red', /colour is not a known setting/, 'unknown top-level key'],
      ['wait: "no"', /wait must be true or false/, 'non-boolean for a boolean setting'],
      [
        'nodes:\n  a:\n    wgPort: 70000',
        /nodes\.a\.wgPort must be an integer from 1 to 65535/,
        'port out of range',
      ],
      ['nodes:\n  a:\n    sshh: x', /nodes\.a\.sshh is not a known setting/, 'unknown node key'],
      ['nodes:\n  a b:\n    ssh: x', /nodes\.a b must be a node name/, 'node name with a space'],
      [
        'nodes:\n  a:\n    label: [ok, 3]',
        /nodes\.a\.label\[1\] must be a nonempty single-line string/,
        'non-string list item',
      ],
      [
        'nodeDefaults:\n  ssh: root@h',
        /nodeDefaults\.ssh is not a known setting/,
        'node-specific key in nodeDefaults',
      ],
      [
        'nodeDefaults:\n  address: 10.0.0.1',
        /nodeDefaults\.address is not a known setting/,
        'address in nodeDefaults',
      ],
      ['- a\n- b', /expected a mapping of settings/, 'a list at the top level'],
    ];
    for (const [content, pattern, what] of bad) {
      await fs.writeFile(path.join(dir, 'tug.yml'), content);
      await assert.rejects(
        resolveCliConfig({}, {}, dir),
        (error: Error) => pattern.test(error.message) && error.message.includes('tug.yml'),
        `${what} should be rejected with the file and key in the message`,
      );
    }
  });
});

test('nodeDefaults sit under each node key by key, a node list replaces a default list, and the overlay merges per node', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'tug.yml'), YAML);
    await fs.writeFile(
      path.join(dir, 'tug.local.yml'),
      'nodes:\n  app1:\n    address: 10.0.0.1\n  app3:\n    ssh: root@h3\n',
    );
    const config = await resolveCliConfig({}, {}, dir);
    const app1 = nodeSettings(config, 'app1');
    assert.equal(app1.installDocker, true, 'a node should inherit nodeDefaults');
    assert.equal(app1.wgPort, '51821', 'a numeric port should be normalized to the option string');
    assert.deepEqual(
      app1.label,
      ['web', 'ingress'],
      'a label list on the node should replace the default list, not append to it',
    );
    assert.equal(app1.address, '10.0.0.1', 'the overlay should add keys to a tracked node');
    assert.equal(app1.ssh, 'root@203.0.113.7', 'overlay merging should keep the tracked keys');
    assert.deepEqual(
      nodeSettings(config, 'app2').label,
      ['base'],
      'a node without its own label should use the default list',
    );
    assert.equal(
      nodeSettings(config, 'app3').ssh,
      'root@h3',
      'the overlay may declare a node the tracked file lacks',
    );
    assert.equal(
      nodeSettings(config, 'unlisted').mesh,
      true,
      'nodeDefaults should apply to a node that is not declared',
    );
  });
});

test('paths in the file resolve relative to the file, not the working directory', async () => {
  await withDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'infra'));
    await fs.writeFile(path.join(dir, 'infra', 'tug.yml'), YAML);
    const config = await resolveCliConfig({ config: 'infra/tug.yml' }, {}, dir);
    assert.equal(
      config.commandDefaults.file,
      path.join(dir, 'infra', 'compose', 'prod.yml'),
      'the compose file path should be relative to the config file',
    );
    assert.equal(
      config.nodeDefaults.image,
      'ghcr.io/example/tug:test',
      'node defaults should keep their configured values',
    );
  });
});

function demoCommand(
  name: string,
  source: string[] = [],
): { command: Command; opts: Record<string, unknown> } {
  const program = new Command().exitOverride();
  const command = program
    .command(name)
    .option('-f, --file <file>', 'compose file', 'docker-compose.yml')
    .option('--build-local')
    .option('--no-wait')
    .option('--mesh')
    .option('--label <label>', 'label', (v: string, a: string[]) => [...a, v], [] as string[])
    .option('--wg-port <port>', 'port', '51820')
    .action(() => {});
  program.parse([name, ...source], { from: 'user' });
  return { command, opts: command.opts() };
}

test('config values are defaults that never override a flag, and only reach commands that list the key', async () => {
  const defaults = {
    file: '/abs/prod.yml',
    buildLocal: true,
    wait: false,
    mesh: true,
    label: ['web'],
    wgPort: '51821',
  };
  const fromConfig = demoCommand('deploy');
  applyConfigDefaults(fromConfig.command, fromConfig.opts, defaults);
  assert.equal(fromConfig.opts.file, '/abs/prod.yml', 'file should replace the option default');
  assert.equal(fromConfig.opts.buildLocal, true, 'buildLocal: true should enable --build-local');
  assert.equal(fromConfig.opts.wait, false, 'wait: false should behave like --no-wait');
  assert.equal(fromConfig.opts.mesh, undefined, 'a key deploy does not list should be ignored');
  assert.equal(fromConfig.opts.wgPort, '51820', 'a node key should not reach deploy');

  const fromFlags = demoCommand('deploy', ['-f', 'cli.yml', '--no-wait']);
  applyConfigDefaults(fromFlags.command, fromFlags.opts, { ...defaults, wait: true });
  assert.equal(fromFlags.opts.file, 'cli.yml', 'a flag should win over the config file');
  assert.equal(fromFlags.opts.wait, false, 'an explicit --no-wait should win over wait: true');

  const node = demoCommand('node-install', ['--wg-port', '60000']);
  applyConfigDefaults(node.command, node.opts, defaults);
  assert.equal(node.opts.mesh, true, 'a node key should apply to node-install');
  assert.deepEqual(
    node.opts.label,
    ['web'],
    'label from the file should replace the empty default',
  );
  assert.equal(node.opts.wgPort, '60000', 'a flag should win over a node setting');
  assert.equal(
    node.opts.file,
    'docker-compose.yml',
    'a project key should not apply to node-install',
  );
});

test('every config key is the camelCase of the flag it defaults, and every listed command has that flag', async () => {
  const helps = new Map<string, string>();
  const help = async (command: string): Promise<string> => {
    if (!helps.has(command)) {
      const { stdout } = await exec(process.execPath, [entry, command, '--help']);
      helps.set(command, stdout);
    }
    return helps.get(command)!;
  };
  for (const [key, setting] of Object.entries({ ...COMMAND_SETTINGS, ...NODE_SETTINGS })) {
    if (setting.flag.startsWith('<')) {
      assert.equal(key, 'ssh', 'the only positional setting should be the ssh target');
      assert.match(
        await help('node-install'),
        /\[sshTarget\]/,
        'node-install should take [sshTarget]',
      );
      continue;
    }
    const name = setting.flag.replace(/^--(no-)?/, '');
    assert.equal(
      key,
      name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
      `${key} should be the camelCase of ${setting.flag}`,
    );
    for (const command of setting.commands)
      assert.ok(
        (await help(command)).includes(setting.flag),
        `${command} should have the ${setting.flag} option that the ${key} setting defaults`,
      );
  }
});

test('init creates the tracked file once, keeps an existing one untouched, and git-ignores the overlay', async () => {
  await withDir(async (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const resolved = await resolveCliConfig(
      { controlUrl: 'https://c.test', project: 'shop' },
      {},
      dir,
      true,
    );
    const written = await writeInitConfig(resolved, path.join(dir, 'cred1.json'), {});
    assert.deepEqual(
      written.map((file) => path.basename(file)),
      ['tug.yml', 'tug.local.yml'],
      'init should write the tracked file and the overlay',
    );
    const tracked = await fs.readFile(path.join(dir, 'tug.yml'), 'utf8');
    assert.ok(!tracked.includes('cred1.json'), 'the tracked file should never contain the token');
    assert.match(
      tracked,
      /controlUrl: https:\/\/c\.test/,
      'the tracked file should hold the control URL',
    );
    assert.equal(
      (await fs.stat(path.join(dir, 'tug.local.yml'))).mode & 0o777,
      0o600,
      'the overlay should be readable by the owner only',
    );
    assert.equal(
      await fs.readFile(path.join(dir, '.gitignore'), 'utf8'),
      'tug.local.yml\n',
      'the overlay should be added to .gitignore',
    );

    const edited = `# my comment\n${tracked}nodes:\n  app1:\n    ssh: root@h\n`;
    await fs.writeFile(path.join(dir, 'tug.yml'), edited);
    const again = await resolveCliConfig({ controlUrl: 'https://other.test' }, {}, dir, true);
    await writeInitConfig(again, path.join(dir, 'cred2.json'), {
      controlUrl: 'https://other.test',
    });
    assert.equal(
      await fs.readFile(path.join(dir, 'tug.yml'), 'utf8'),
      edited,
      'init should not rewrite an existing tracked file, so its comments and nodes survive',
    );
    assert.equal(
      await fs.readFile(path.join(dir, '.gitignore'), 'utf8'),
      'tug.local.yml\n',
      'init should not add the overlay to .gitignore twice',
    );
    const next = await resolveCliConfig({}, {}, dir, true);
    assert.equal(
      path.basename(next.credentialFile!),
      'cred2.json',
      'init should replace the overlay credential path',
    );
    assert.equal(
      next.controlUrl,
      'https://other.test',
      'a connection flag given to init should be saved in the overlay when the tracked file exists',
    );
  });
});

test('node-install reads the ssh target from the config and reports a missing one by key', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'tug.yml'),
      'controlUrl: https://control.test\nnodes:\n  app1:\n    ssh: root@203.0.113.7\n  app2:\n    publicAddress: x.test\n',
    );
    const run = (...args: string[]) =>
      exec(process.execPath, [entry, ...args], { cwd: dir }).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
      );
    const missing = await run('node-install', '--name', 'app2');
    assert.match(
      missing.stderr,
      /needs an SSH target.*nodes\.app2\.ssh/,
      'a declared node without ssh should name the missing key',
    );
    const undeclared = await run('node-install', '--name', 'ghost');
    assert.match(
      undeclared.stderr,
      /nodes\.ghost\.ssh/,
      'an undeclared node without a positional target should name the key to add',
    );
    const declared = await run(
      'node-install',
      '--name',
      'app1',
      '--agent-control-url',
      'http://plain.test',
    );
    assert.doesNotMatch(
      declared.stderr,
      /needs an SSH target/,
      'a node with ssh in the config should get past target resolution',
    );
    assert.match(
      declared.stderr,
      /must use https/,
      'with the target resolved, the plaintext connect URL check should be the next failure',
    );
  });
});
