import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMtlsControl } from '../tests/helpers.ts';
import { createCsr, generateKeyPair } from './pki.ts';
import { defaultImage } from './image.ts';
import yaml from 'js-yaml';

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
  const cli = (...args: string[]) =>
    execFileAsync(process.execPath, [cliEntry, ...args], { env, cwd: dir });
  try {
    await cli(
      'control-install',
      'root@control.test',
      '--port',
      '9099',
      '--public-url',
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
    assert.match(script, /TUG_MESH: "false"/, 'control-install leaves the mesh off by default');
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
      '--public-url',
      'https://bare.test:8443',
      '--credential-out',
      path.join(dir, 'root.out.json'),
    );
    script = await fs.readFile(ssh.log, 'utf8');
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
    await cli(
      'control-install',
      'root@mesh.test',
      '--mesh',
      '--public-url',
      'https://mesh.test:8443',
      '--credential-out',
      path.join(dir, 'root.out.json'),
    );
    assert.match(
      await fs.readFile(ssh.log, 'utf8'),
      /TUG_MESH: "true"/,
      'control-install --mesh should enable the mesh on control',
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
    assert.doesNotMatch(script, /NET_ADMIN|TUG_MESH/, 'agents join no mesh unless asked');
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
          'node-enroll',
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

    await fs.rm(ssh.log);
    await cli('node-install', 'root@node2.test', '--name', 'n-mesh', '--mesh', '--no-wait');
    script = await fs.readFile(ssh.log, 'utf8');
    assert.ok(script.includes('TUG_MESH=true'), '--mesh sets TUG_MESH in agent.env');
    assert.match(
      script,
      /--network host --cap-add NET_ADMIN/,
      '--mesh runs the agent with host networking and NET_ADMIN',
    );
    assert.ok(
      script.includes('tugwgtest type wireguard') && script.includes('udp.51820.free'),
      '--mesh adds WireGuard kernel and UDP port preflight checks',
    );
    assert.ok(
      script.includes('docker inspect --format') && script.includes('tug-agent'),
      "the UDP check must let this node's own running Tug agent keep its WireGuard port, so an install can be repeated",
    );
    assert.doesNotMatch(script, unrenderedVariable, 'no unrendered template variables');

    const enroll = await cli('node-enroll', '--name', 'n-enr', '--mesh');
    assert.ok(
      enroll.stdout.includes(`'${defaultImage()}' agent`),
      'node-enroll prints a docker run with the published image for the CLI version',
    );
    assert.match(
      enroll.stdout,
      /--network host --cap-add NET_ADMIN -e TUG_MESH=true/,
      'node-enroll --mesh prints a mesh-capable docker run',
    );

    const cloud = await cli(
      'node-enroll',
      '--name',
      'n-cloud',
      '--install-docker',
      '--mesh',
      '--json',
    );
    const payload = JSON.parse(cloud.stdout);
    assert.match(
      payload.command,
      /--network host --cap-add NET_ADMIN/,
      'JSON enrollment should contain the directly usable agent command',
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
