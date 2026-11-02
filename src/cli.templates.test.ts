import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl, writeCredentialFile } from '../tests/helpers.ts';
import { createCsr, generateKeyPair } from './pki.ts';
import { defaultImage } from './image.ts';
import { createTransport } from './agent-credential.ts';
import * as yaml from 'js-yaml';

const execFileAsync = promisify(execFile);
// `src/cli.ts` in dev; `CLI_ENTRY=dist/cli.js npm run test:smoke:dist` checks the built output.
const cliEntry = path.resolve(process.env.CLI_ENTRY || 'src/cli.ts');
// Install template variables are upper-case ({{CONTROL_URL}}); Go-template braces such as {{end}} in docker --format strings are not.
const unrenderedVariable = /\{\{[A-Z][A-Z0-9_]*\}\}/;

// A stub `ssh` that records its arguments (the rendered install script is the last one).
async function stubSsh(dir: string) {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'ssh.log');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, 'ssh'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\nprintf '\\n--END--\\n' >> "${log}"\ncase "$*" in\n  *"agent identity"*) cat "$TUG_STUB_CSR" ;;\n  *issue-credential*) cat "$TUG_STUB_CREDENTIAL" ;;\nesac\n`,
    { mode: 0o755 },
  );
  return { bin, log };
}

test('control-install uses config controlUrl, with overlay, environment and flag overrides', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-control-config-'));
  const ssh = await stubSsh(dir);
  const credential = path.join(dir, 'stub.credential.json');
  await writeCredentialFile(credential, 'https://credential.test:8443');
  const config = path.join(dir, 'install.yml');
  const overlay = path.join(dir, 'install.local.yml');
  const env = {
    ...process.env,
    PATH: `${ssh.bin}${path.delimiter}${process.env.PATH}`,
    TUG_CREDENTIAL: '',
    TUG_CREDENTIAL_FILE: credential,
    TUG_STUB_CREDENTIAL: credential,
  };
  let extraEnv: NodeJS.ProcessEnv = {};
  const cli = (...args: string[]) =>
    execFileAsync(process.execPath, [cliEntry, ...args], {
      env: { ...env, ...extraEnv },
      cwd: dir,
    });
  const install = async (expected: string, ...args: string[]) => {
    await fs.rm(ssh.log, { force: true });
    const result = await cli(
      'control-install',
      'root@ssh-alias',
      '--config',
      config,
      '--credential-out',
      path.join(dir, 'root.out.json'),
      ...args,
    );
    assert.equal(
      JSON.parse(result.stdout).url,
      expected,
      'control-install should report the resolved installation address',
    );
    assert.ok(
      (await fs.readFile(ssh.log, 'utf8')).includes(`TUG_CONTROL_URL: ${JSON.stringify(expected)}`),
      'the rendered Compose environment should use the resolved installation address',
    );
    return result;
  };
  try {
    await fs.writeFile(config, 'controlUrl: https://configured.test:9099\n');
    const configured = await install('https://configured.test:9099');
    assert.doesNotMatch(
      configured.stderr,
      /from the SSH target/,
      'an address supplied by config should not produce the SSH-default notice',
    );
    await fs.writeFile(overlay, 'controlUrl: https://overlay.test:9443\n');
    await install('https://flag.test:4433', '--control-url', 'https://flag.test:4433');
    extraEnv = { TUG_CONTROL_URL: 'https://env.test:7443' };
    await install('https://env.test:7443');
    await install('https://flag.test:4433', '--control-url', 'https://flag.test:4433');
    extraEnv = {};
    await install('https://overlay.test:9443');
    await fs.rm(overlay);
    await fs.writeFile(config, '{}\n');
    const fallback = await install('https://ssh-alias:8443');
    assert.match(
      fallback.stderr,
      /control URL: https:\/\/ssh-alias:8443 \(from the SSH target/,
      'a credential alone should not replace the SSH fallback',
    );
    await install('https://ssh-alias:9555', '--port', '9555');
    // nodeDefaults that name control-install options (image, installDocker) are its defaults too.
    await fs.writeFile(
      config,
      'controlUrl: https://configured.test:9099\nnodeDefaults:\n  installDocker: true\n  image: config/image:1\n',
    );
    await install('https://configured.test:9099');
    const defaulted = await fs.readFile(ssh.log, 'utf8');
    assert.ok(defaulted.includes('config/image:1'), 'a configured image should be the default');
    assert.ok(defaulted.includes('download.docker.com'), 'a configured installDocker should apply');
    await install('https://configured.test:9099', '--image', 'cli/image:2');
    const overridden = await fs.readFile(ssh.log, 'utf8');
    assert.ok(
      overridden.includes('cli/image:2') && !overridden.includes('config/image:1'),
      'a command-line image should win over the configured one',
    );
    await fs.writeFile(config, 'controlUrl: http://invalid.test\n');
    await fs.rm(ssh.log);
    await assert.rejects(
      cli('control-install', 'root@ssh-alias', '--config', config),
      /must use https/,
      'an invalid configured control URL should fail before SSH',
    );
    await assert.rejects(
      fs.stat(ssh.log),
      { code: 'ENOENT' },
      'an invalid configured URL should not run any remote operation',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('install commands render the shipped templates (src in dev, dist in the image)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cli-tpl-'));
  const control = await startMtlsControl(path.join(dir, 'data'));
  const ssh = await stubSsh(dir);
  const csrFile = path.join(dir, 'node.csr');
  await fs.writeFile(csrFile, await createCsr((await generateKeyPair()).privateKeyPem));
  const env = {
    ...process.env,
    ...control.env,
    PATH: `${ssh.bin}${path.delimiter}${process.env.PATH}`,
    TUG_CONFIG: path.join(dir, 'cfg.json'),
    TUG_STUB_CSR: csrFile,
    TUG_STUB_CREDENTIAL: control.credentialFile,
  };
  await fs.writeFile(env.TUG_CONFIG, '{}');
  // TUG_CONTROL_URL is the connect target for API commands but the advertised address for control-install, so a shell
  // that exports it for the first would change the second. Keep it away from control-install here.
  const cli = (...args: string[]) => {
    const scoped: NodeJS.ProcessEnv = { ...env };
    if (args[0] === 'control-install') delete scoped.TUG_CONTROL_URL;
    return execFileAsync(process.execPath, [cliEntry, ...args], { env: scoped, cwd: dir });
  };
  try {
    await cli(
      'control-install',
      'root@control.test',
      '--port',
      '9099',
      '--control-url',
      'https://control.test:9099',
      '--credential-out',
      path.join(dir, 'root.out.json'),
    );
    let script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(
      !script.includes('TUG_REGISTRY'),
      'control installation must not configure a build registry',
    );
    assert.ok(script.includes('9099'), 'control-compose.yml rendered with the port');
    assert.doesNotMatch(
      script,
      /TUG_MESH/,
      'control installation should not configure a WireGuard mesh',
    );
    assert.ok(
      script.includes(`image: ${JSON.stringify(defaultImage())}`),
      'control-install defaults to the published image for the CLI version',
    );
    assert.ok(
      !script.includes('docker build'),
      'control-install does not build an image unless --build-local-image is set',
    );
    assert.doesNotMatch(script, unrenderedVariable, 'no unrendered template variables');

    await fs.rm(ssh.log);
    await cli(
      'control-install',
      'root@bare.test',
      '--install-docker',
      '--credential-out',
      path.join(dir, 'root.out.json'),
    );
    script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(
      script.includes('TUG_CONTROL_URL: "https://bare.test:8443"'),
      'without a configured control URL the SSH target host and the default port are used',
    );
    assert.doesNotMatch(
      script,
      /TUG_REGISTRY|registry-auth/,
      'control must have no registry credential wiring',
    );
    assert.ok(
      script.indexOf('download.docker.com') < script.indexOf('preflight: docker.version'),
      'opt-in Docker bootstrap should run before preflight',
    );
    assert.match(
      script,
      /docker-compose-plugin/,
      'bare-host bootstrap should install the Docker Compose plugin',
    );

    await fs.rm(ssh.log);
    await cli('node-install', 'root@node.test', '--name', 'n-tpl', '--no-wait');
    script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(script.includes('TUG_NODE_NAME=n-tpl'), 'agent.env rendered');
    assert.ok(!script.includes('TUG_AGENT_TOKEN'), 'no bearer token reaches the node');
    assert.ok(script.includes('agent install-cert'), 'the certificate is installed over SSH');
    assert.ok(
      !script.includes('BEGIN CERTIFICATE REQUEST'),
      'the CSR travels over stdin, never a command line',
    );
    assert.ok(
      script.includes(defaultImage()),
      'node-install defaults to the published image for the CLI version',
    );
    assert.doesNotMatch(script, unrenderedVariable, 'no unrendered template variables');
    assert.doesNotMatch(
      script,
      /NET_ADMIN|TUG_MESH|wireguard|tugwgtest|udp\.51820\.free/,
      'agent installation should omit WireGuard capabilities, environment and preflight checks',
    );
    assert.match(
      script,
      /docker run -d --name tug-agent [^\n]*--network host /,
      'the agent shares the host network so health checks can reach container IPs on any Docker version',
    );

    await fs.rm(ssh.log);
    const agentControlUrl = 'https://agent-control.test';
    await cli(
      'node-install',
      'root@private.test',
      '--name',
      'n-private',
      '--agent-control-url',
      agentControlUrl,
      '--no-wait',
    );
    script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(
      script.includes(`TUG_CONTROL_URL=${agentControlUrl}`),
      'agent installation should write the separately advertised URL while registration reaches the operator API',
    );
    assert.ok(
      script.includes('/dev/tcp/agent-control.test/443'),
      'node preflight should test TCP reachability of the agent URL',
    );
    const privateEnroll = JSON.parse(
      (
        await cli(
          'node-prepare-enrollment',
          '--name',
          'n-private-enroll',
          '--agent-control-url',
          agentControlUrl,
          '--json',
        )
      ).stdout,
    );
    const joinKey = JSON.parse(Buffer.from(privateEnroll.joinKey, 'base64url').toString());
    assert.equal(joinKey.v, 2, 'join keys carry the bootstrap credential');
    assert.equal(
      joinKey.connectUrl,
      agentControlUrl,
      'join key should use the agent URL as the connect target only',
    );
    assert.equal(
      joinKey.credential.url,
      'https://localhost:8443',
      'the credential keeps the verified public URL',
    );
    assert.equal(joinKey.name, 'n-private-enroll', 'the join key is bound to one node name');

    const enroll = await cli('node-prepare-enrollment', '--name', 'n-enr');
    assert.ok(
      enroll.stdout.includes(`'${defaultImage()}' agent`),
      'node-prepare-enrollment prints a docker run with the published image for the CLI version',
    );
    assert.match(
      enroll.stdout,
      /--network host /,
      'node-prepare-enrollment should print a host-networked docker run for health checks',
    );
    assert.doesNotMatch(
      enroll.stdout,
      /NET_ADMIN|TUG_MESH/,
      'node-prepare-enrollment should not grant WireGuard capabilities or environment',
    );

    const cloud = await cli(
      'node-prepare-enrollment',
      '--name',
      'n-cloud',
      '--address',
      '10.0.0.7',
      '--install-docker',
      '--json',
    );
    const payload = JSON.parse(cloud.stdout);
    assert.match(
      payload.command,
      /TUG_NODE_ADDRESS='10\.0\.0\.7'/,
      'enrollment command should provide the requested node address',
    );
    assert.ok(
      payload.cloudInit.includes("TUG_NODE_ADDRESS='10.0.0.7'"),
      'cloud-init should provide the requested node address',
    );
    assert.match(
      payload.command,
      /--network host /,
      'JSON enrollment should contain a host-networked agent command',
    );
    assert.doesNotMatch(
      payload.command,
      /--cap-add|NET_ADMIN/,
      'JSON enrollment should not grant the agent additional capabilities',
    );
    assert.match(
      payload.cloudInit,
      /^#cloud-config\n/,
      'JSON bare-host enrollment should contain a complete cloud-init document',
    );
    const cloudDocument = yaml.load(payload.cloudInit) as { runcmd: string[][] };
    assert.ok(
      cloudDocument.runcmd[0][3].includes('&& docker run'),
      'cloud-init must start the agent only if Docker installation succeeds',
    );

    const composeFile = path.join(dir, 'app.yml');
    await fs.writeFile(
      composeFile,
      yaml.dump({
        services: {
          web: { image: 'busybox:latest', 'x-tug': { placement: { nodes: ['n-tpl'] } } },
        },
      }),
    );
    await cli('project-policy-set', '--project', 'after-command', '--nodes', 'n-tpl');
    await cli('project-policy-set', '--project', 'before-command', '--nodes', 'n-tpl');
    const policy = JSON.parse(
      (await cli('project-policy-show', '--project', 'before-command')).stdout,
    );
    assert.deepEqual(
      policy.nodes,
      ['n-tpl'],
      'project-policy-show returns the node granted through the CLI',
    );
    const deployment = await cli(
      'deploy',
      '--version',
      'display-version',
      '--project',
      'after-command',
      '--file',
      composeFile,
      '--no-wait',
    );
    assert.equal(
      JSON.parse(deployment.stdout).deployment.version,
      'display-version',
      'deploy --version must reach the API as the display version rather than exit through the global package version option',
    );
    const before = await cli(
      '--project',
      'before-command',
      'deploy',
      '--version',
      'second-display',
      '--file',
      composeFile,
      '--no-wait',
    );
    assert.equal(
      JSON.parse(before.stdout).deployment.project,
      'before-command',
      'shared options before the command must use the same project resolution as shared options after it',
    );
    const packageVersion = await cli('--version');
    assert.match(
      packageVersion.stdout,
      /^\d+\.\d+\.\d+/m,
      'global --version must still print the CLI package version',
    );
  } finally {
    await control.close();
  }
});

test('batch identity commands apply every per-node setting and preserve explicit flags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-node-config-'));
  const control = await startMtlsControl(path.join(dir, 'data'));
  const ssh = await stubSsh(dir);
  const csrFile = path.join(dir, 'node.csr');
  await fs.writeFile(csrFile, await createCsr((await generateKeyPair()).privateKeyPem));
  const env = {
    ...process.env,
    ...control.env,
    PATH: `${ssh.bin}${path.delimiter}${process.env.PATH}`,
    TUG_CONFIG: path.join(dir, 'cfg.json'),
    TUG_STUB_CSR: csrFile,
  };
  const cli = (...args: string[]) =>
    execFileAsync(process.execPath, [cliEntry, ...args], { env, cwd: dir });
  let script: string;
  try {
    const configuredNodes = {
      nodeDefaults: {
        installDocker: true,
        image: 'default-agent:test',
        agentControlUrl: 'https://default-control.test:8443',
        label: ['base'],
      },
      nodes: {
        'config-a': {
          ssh: 'root@config-a',
          address: '10.0.0.1',
          label: [],
          installDocker: false,
          image: 'node-agent:test',
          agentControlUrl: 'https://node-control.test:8443',
        },
        'config-b': { ssh: 'root@config-b' },
        skipped: { label: ['no-ssh'] },
      },
    };
    await fs.writeFile(env.TUG_CONFIG, JSON.stringify(configuredNodes));
    for (const verb of ['node-install', 'node-replace-identity', 'node-repair-identity']) {
      await fs.rm(ssh.log, { force: true });
      const batch = JSON.parse((await cli(verb, '--all', '--no-wait')).stdout);
      assert.deepEqual(
        batch.results,
        [
          { node: 'config-a', ok: true },
          { node: 'config-b', ok: true },
        ],
        `${verb} --all should process each declared SSH node and skip nodes without SSH`,
      );
      const calls = (await fs.readFile(ssh.log, 'utf8')).split('--END--');
      const a = calls.filter((call) => call.includes('root@config-a')).join('\n');
      const b = calls.filter((call) => call.includes('root@config-b')).join('\n');
      assert.match(a, /node-agent:test/, `${verb} should apply the per-node image`);
      assert.match(
        a,
        /TUG_CONTROL_URL=https:\/\/node-control.test:8443/,
        `${verb} should apply the per-node agent URL`,
      );
      assert.doesNotMatch(
        a,
        /download.docker.com/,
        `${verb} should honor a false per-node Docker value`,
      );
      assert.doesNotMatch(
        a,
        /NET_ADMIN|TUG_MESH|wireguard|tugwgtest/,
        `${verb} should omit WireGuard capabilities, environment and preflight checks`,
      );
      assert.match(b, /default-agent:test/, `${verb} should inherit the default image`);
      assert.match(
        b,
        /TUG_CONTROL_URL=https:\/\/default-control.test:8443/,
        `${verb} should inherit the default agent URL`,
      );
      assert.match(b, /download.docker.com/, `${verb} should inherit Docker installation`);
      assert.match(b, /--network host /, `${verb} should retain host networking for health checks`);
    }
    await fs.rm(ssh.log, { force: true });
    const metadataTransport = createTransport(control.root, control.url);
    const nodeMetadata = async () => {
      const response = await metadataTransport.http(`${metadataTransport.base}/api/v1/nodes`);
      assert.equal(response.status, 200, 'the node list should expose registered metadata');
      return (await response.json()) as {
        nodes: {
          name: string;
          address: string | null;
          labels: string[];
        }[];
      };
    };
    try {
      const { nodes } = await nodeMetadata();
      const a = nodes.find((node) => node.name === 'config-a')!;
      const b = nodes.find((node) => node.name === 'config-b')!;
      assert.equal(a.address, '10.0.0.1', 'batch install should register the configured address');
      assert.deepEqual(a.labels, [], 'an empty per-node list should replace inherited labels');
      assert.deepEqual(b.labels, ['base'], 'a node without labels should inherit nodeDefaults');
    } finally {
      await metadataTransport.close();
    }
    await fs.writeFile(
      env.TUG_CONFIG,
      JSON.stringify({
        ...configuredNodes,
        nodes: Object.fromEntries(
          Object.entries(configuredNodes.nodes)
            .filter(([, node]) => 'ssh' in node)
            .map(([name, node]) => [`flag-${name}`, node]),
        ),
      }),
    );
    const overridden = JSON.parse(
      (
        await cli(
          'node-install',
          '--all',
          '--no-wait',
          '--image',
          'flag-agent:test',
          '--agent-control-url',
          'https://flag-control.test',
          '--install-docker',
          '--address',
          '10.0.0.99',
          '--label',
          'cli',
        )
      ).stdout,
    );
    assert.ok(
      overridden.results.every((result: { ok: boolean }) => result.ok),
      'batch installation should succeed with explicit flags',
    );
    script = await fs.readFile(ssh.log, 'utf8');
    assert.doesNotMatch(
      script,
      /node-agent:test|default-agent:test|node-control.test|default-control.test/,
      'explicit flags should override every per-node and inherited connection setting',
    );
    for (const host of ['root@config-a', 'root@config-b']) {
      const calls = script
        .split('--END--')
        .filter((call) => call.includes(host))
        .join('\n');
      assert.match(calls, /flag-agent:test/, 'an explicit image should apply to every node');
      assert.match(
        calls,
        /TUG_CONTROL_URL=https:\/\/flag-control.test/,
        'an explicit agent URL should apply to every node',
      );
      assert.match(
        calls,
        /download.docker.com/,
        'an explicit Docker flag should override a false per-node value',
      );
      assert.match(
        calls,
        /--network host /,
        'every explicitly configured agent should retain host networking for health checks',
      );
      assert.doesNotMatch(
        calls,
        /NET_ADMIN|TUG_MESH/,
        'explicit connection settings should not add WireGuard capabilities or environment',
      );
    }
    const flagTransport = createTransport(control.root, control.url);
    try {
      const response = await flagTransport.http(`${flagTransport.base}/api/v1/nodes`);
      const { nodes } = (await response.json()) as {
        nodes: {
          name: string;
          address: string | null;
          labels: string[];
        }[];
      };
      const overridden = nodes.filter((node) => node.name.startsWith('flag-'));
      assert.equal(
        overridden.length,
        2,
        'both batch nodes should be installed with explicit metadata',
      );
      for (const node of overridden) {
        assert.equal(
          node.address,
          '10.0.0.99',
          'explicit addresses should override per-node values',
        );
        assert.deepEqual(
          node.labels,
          ['cli'],
          'explicit label lists should replace per-node and default lists',
        );
      }
    } finally {
      await flagTransport.close();
    }
  } finally {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
