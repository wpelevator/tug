#!/usr/bin/env node
import { Command, Option } from 'commander';
import { openAsBlob } from 'node:fs';
import {
  applyConfigDefaults,
  integerOption,
  normalizeControlUrl,
  nodeSettings,
  resolveCliConfig,
  writeInitConfig,
} from './cli-config.ts';
import {
  dockerRunSnippet,
  enrollmentCloudInit,
  shellQuote as sh,
  HOST_NETWORK_FLAG,
  MESH_RUN_FLAGS,
  CONTROL_CONTAINER,
  controlPortCheck,
  localImageBuildArgs,
  meshPortCheck,
} from './cli-install.ts';
import { createSourceArchive, prepareLocalImages } from './cli-build.ts';
import { saveImageArchive } from './artifacts.ts';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeHash } from './compose.ts';
import { normalizeCompose } from './normalize.ts';
import { errMessage, loadTemplate } from './util.ts';
import { createTransport } from './agent-credential.ts';
import { decodeCredential, writeFileDurable } from './pki.ts';
import { backupCheckProblems } from './backup-check.ts';
import { PROJECT_NAME_PATTERN, ROLES, CREDENTIAL_NAME_PATTERN } from './credentials.ts';
import { packageVersion, resolveImage } from './image.ts';
import { TERMINAL_DEPLOYMENT_STATES } from './protocol.ts';
import type {
  DeploymentState,
  EnrollmentCredentialResponse,
  JoinKey,
  IdentityResponse,
} from './protocol.ts';
import { CliLiveError, parseLiveRequest, runCliLive } from './cli-live.ts';
import type { LiveInput, LiveRequest } from './cli-live.ts';
import { createCliLiveTransport } from './cli-live-transport.ts';

// Templates live next to this file: src/templates in dev (`node src/cli.ts`), dist/templates in the
// built image (`node dist/cli.js`; tools/scripts/copy-templates.js puts them there).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, 'templates');

interface DeploymentRecord {
  id: string;
  state: DeploymentState;
  error_message?: string | null;
}
interface CommandRecord {
  state: string;
  result_json?: string | null;
}
interface DeployResponse {
  deployment: DeploymentRecord;
  desiredState?: unknown;
}
interface CommonOpts {
  project?: string;
}
interface WaitOpts {
  wait: boolean;
  timeout: string;
}
interface InstallOpts {
  buildLocalImage?: boolean;
  image?: string;
  installDocker?: boolean;
}

const CONFIG_HELP =
  'CLI config file, YAML or JSON (default: TUG_CONFIG, else tug.yml, tug.yaml, tug.json or .tug.json)';

const program = new Command();
program
  .name('tug')
  .description('Portable VPS deployments with Docker Compose')
  .version(packageVersion())
  .enablePositionalOptions()
  .option('--config <file>', CONFIG_HELP)
  .option(
    '--control-url <url>',
    'connect target for the control API (the credential still verifies its own public URL)',
  )
  .option(
    '--credential <file>',
    'credential file (overrides TUG_CREDENTIAL, TUG_CREDENTIAL_FILE and config)',
  )
  .option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)');
let resolvedConfig: Awaited<ReturnType<typeof resolveCliConfig>> | undefined;
async function loadCfg(): Promise<NonNullable<typeof resolvedConfig>> {
  return resolvedConfig!;
}
const collect = (v: string, a: string[]): string[] => [...a, v];
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
/** The pinned mTLS transport for the resolved credential; an address override only changes the connect target. */
async function transportFor(c: NonNullable<typeof resolvedConfig>) {
  if (!c.credential)
    throw new Error(
      'no credential: run `tug init <credential-file>`, set TUG_CREDENTIAL_FILE or pass --credential',
    );
  return createTransport(c.credential, c.controlUrl);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request<T = any>(
  method: string,
  route: string,
  body?: unknown,
  multipart = false,
): Promise<T> {
  const c = await loadCfg();
  const transport = await transportFor(c);
  const headers: Record<string, string> = {};
  if (!multipart) headers['content-type'] = 'application/json';
  try {
    const res = await transport.http(`${transport.base}${route}`, {
      method,
      headers,
      body: multipart ? (body as FormData) : body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    void transport.close();
  }
}
function runLocal(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0)
    throw new Error(
      `${cmd} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}`,
    );
}
function runCapture(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stderr || ''}`);
  return String(result.stdout);
}
function preflightRemote(
  target: string,
  {
    controlUrl,
    ports = [],
    udpPorts = [],
    minDiskMb = 1024,
    mesh = false,
    compose = false,
  }: {
    controlUrl?: string;
    ports?: number[];
    udpPorts?: number[];
    minDiskMb?: number;
    mesh?: boolean;
    /** Requires the Compose plugin; only the control host runs Compose, nodes need the Docker Engine alone. */
    compose?: boolean;
  } = {},
): void {
  const checks: [string, string, string][] = [
    [
      'docker.version',
      'docker version >/dev/null',
      'Install Docker Engine and ensure the SSH user can access it.',
    ],
    ...(compose
      ? ([
          [
            'docker.compose.version',
            'docker compose version >/dev/null',
            'Install Docker Compose v2.',
          ],
        ] as [string, string, string][])
      : []),
    [
      'paths',
      'mkdir -p /opt/tug-preflight /var/lib/tug-preflight /etc/tug && test -w /opt/tug-preflight && test -w /var/lib/tug-preflight && test -w /etc/tug',
      'Ensure /opt, /var/lib, and /etc/tug are writable by the installer.',
    ],
    [
      'disk.space',
      `[ "$(df -Pm /var/lib | tail -1 | awk '{print $4}')" -ge ${Number(minDiskMb)} ]`,
      `Free at least ${minDiskMb}MB on the filesystem backing /var/lib.`,
    ],
  ];
  for (const port of ports) {
    checks.push([
      `port.${port}.free`,
      controlPortCheck(port),
      `Port ${port} is already in use on the target host by something other than the Tug control container; stop the conflicting service or choose another port.`,
    ]);
  }
  if (mesh) {
    checks.push([
      'wireguard.kernel',
      'ip link add tugwgtest type wireguard && ip link del tugwgtest || modprobe -n wireguard 2>/dev/null',
      'Install WireGuard (kernel 5.6+ has it built in; older kernels need the wireguard-dkms package) and ensure iproute2 is present.',
    ]);
  }
  for (const port of udpPorts) {
    checks.push([
      `udp.${port}.free`,
      meshPortCheck(port),
      `UDP port ${port} is in use by something other than this node's running Tug mesh agent (or the ss tool is missing). Stop the conflicting service, or choose another port with --wg-port and set TUG_WG_PORT on control.`,
    ]);
  }
  if (controlUrl)
    checks.push([
      'control.reachable',
      // TCP reachability only: no credential is copied to the host, and real TLS authorization happens when the agent connects.
      `timeout 5 bash -c ${sh(`exec 3<>/dev/tcp/${new URL(controlUrl).hostname.replace(/^\[|\]$/g, '')}/${new URL(controlUrl).port || 443}`)}`,
      'Verify DNS and the firewall from the node to the control port (control speaks mTLS only, so only TCP reachability is checked here).',
    ]);
  const script = `set -e
${checks.map(([name, cmd, fix]) => `echo "preflight: ${name}"; (${cmd}) || { echo "FAILED ${name}: ${fix}" >&2; exit 20; }`).join('\n')}
`;
  runLocal('ssh', ['--', target, script]);
}
async function transferTugImage(target: string, imageTag: string): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-runtime-'));
  const archive = path.join(directory, 'image.tar.gz');
  const remote = `/tmp/${path.basename(directory)}.tar.gz`;
  try {
    const uname = runCapture('ssh', ['--', target, 'uname -m']);
    runLocal('docker', localImageBuildArgs(imageTag, uname));
    await saveImageArchive(imageTag, archive);
    runLocal('scp', ['--', archive, `${target}:${remote}`]);
    runLocal('ssh', [
      '--',
      target,
      `set -eu\ntrap ${sh(`rm -f ${sh(remote)}`)} EXIT\ndocker load --input ${sh(remote)}`,
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function dockerBootstrap(): Promise<string> {
  return fs.readFile(path.join(templatesDir, 'install-docker.sh'), 'utf8');
}
/** Installs Docker over SSH; `compose` also installs the Compose plugin, which only the control host needs. */
async function bootstrapDocker(target: string, compose = false): Promise<void> {
  runLocal('ssh', [
    '--',
    target,
    `${compose ? 'TUG_INSTALL_COMPOSE=1 ' : ''}sh -eu -c ${sh(await dockerBootstrap())}`,
  ]);
}
async function waitForDeployment(
  deploymentId: string,
  timeoutSeconds = 300,
): Promise<DeploymentRecord> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const deployment = await request<DeploymentRecord>(
      'GET',
      `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
    );
    if ((TERMINAL_DEPLOYMENT_STATES as readonly string[]).includes(deployment.state)) {
      if (deployment.state !== 'succeeded')
        throw new Error(
          `deployment ${deploymentId} ${deployment.state}${deployment.error_message ? `: ${deployment.error_message}` : ''}`,
        );
      return deployment;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for deployment ${deploymentId}`);
}

program
  .command('init [credentialFile]')
  .description(
    'create the config file if missing and import a credential (a file, or - for stdin) into a 0600 user-config file that the git-ignored .local overlay points at',
  )
  .action(async (credentialFile: string | undefined, _o: unknown, command: Command) => {
    const cfg = await loadCfg();
    const { controlUrl, project } = command.optsWithGlobals<{
      controlUrl?: string;
      project?: string;
    }>();
    let text: string | undefined;
    if (credentialFile === '-') text = await readStdin();
    else if (credentialFile) text = await fs.readFile(credentialFile, 'utf8');
    else if (cfg.credential) text = JSON.stringify(cfg.credential);
    if (!text) throw new Error('tug init needs a credential file (or - for stdin)');
    const credential = decodeCredential(text);
    // TUG_CREDENTIALS_DIR keeps scripts and tests out of the real home directory.
    const dir =
      process.env.TUG_CREDENTIALS_DIR ||
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'tug',
        'credentials',
      );
    const source = path.join(
      dir,
      `${new URL(credential.url).host.replace(/[^A-Za-z0-9.-]/g, '_')}.json`,
    );
    await writeFileDurable(source, `${JSON.stringify(credential, null, 2)}\n`, 0o600);
    for (const file of await writeInitConfig(cfg, source, { controlUrl, project }))
      console.log(`wrote ${file}`);
    console.log(`imported credential to ${source}`);
  });

program
  .command('node-register <name>')
  .description(
    'sign a node-generated CSR and print the identity response (the primitive behind node-install; the private key stays with whoever made the CSR)',
  )
  .requiredOption('--csr <file>', 'PEM certificate request generated on the node (- for stdin)')
  .option('--mode <mode>', 'create a new node or replace an existing node key', 'create')
  .option('--address <addr>')
  .option('--public-address <addr>')
  .option('--label <label>', 'node label (repeatable)', collect, [])
  .action(
    async (
      name: string,
      o: { csr: string; mode: string; address?: string; publicAddress?: string; label: string[] },
    ) => {
      if (o.mode !== 'create' && o.mode !== 'replace')
        throw new Error("--mode must be 'create' or 'replace'");
      const csr = o.csr === '-' ? await readStdin() : await fs.readFile(o.csr, 'utf8');
      const r = await request<IdentityResponse>(
        'POST',
        `/api/v1/nodes/${encodeURIComponent(name)}/identity`,
        { csr, mode: o.mode, address: o.address, publicAddress: o.publicAddress, labels: o.label },
      );
      console.log(JSON.stringify(r, null, 2));
    },
  );
program
  .command('node-disable <name>')
  .description(
    "block a node's key immediately without deleting its metadata or placement (no SSH needed); bring it back with node-replace-identity",
  )
  .action(async (name: string) =>
    console.log(
      JSON.stringify(
        await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/disable`, {}),
        null,
        2,
      ),
    ),
  );
program
  .command('node-rotate-wg-key <name>')
  .description(
    'generate a new WireGuard keypair on the node; peers pick up the new public key on their next poll',
  )
  .option('--timeout <seconds>', 'wait timeout', '60')
  .action(async (name: string, o: { timeout: string }) => {
    const created = await request(
      'POST',
      `/api/v1/nodes/${encodeURIComponent(name)}/rotate-wg-key`,
      {},
    );
    const cmd = await waitForCommand(created.commandId, Number(o.timeout));
    if (cmd.state === 'failed')
      throw new Error(JSON.parse(cmd.result_json || '{}').error || 'key rotation failed');
    console.log(
      JSON.stringify({ ok: true, node: name, ...JSON.parse(cmd.result_json || '{}') }, null, 2),
    );
  });
program
  .command('node-remove <name>')
  .description(
    'remove a retired node from control (its agent token, WireGuard peer and queued commands)',
  )
  .option('--force', 'remove even if the agent is still reporting')
  .action(async (name: string, o: { force?: boolean }) => {
    console.log(
      JSON.stringify(
        await request(
          'DELETE',
          `/api/v1/nodes/${encodeURIComponent(name)}${o.force ? '?force=true' : ''}`,
        ),
        null,
        2,
      ),
    );
  });
program
  .command('node-ingress <name>')
  .description(
    'mark a node as an ingress node (managed Caddy on ports 80/443), or remove the role with --disable',
  )
  .option('--disable', 'stop acting as an ingress node')
  .action(async (name: string, o: { disable?: boolean }) => {
    console.log(
      JSON.stringify(
        await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/ingress`, {
          enabled: !o.disable,
        }),
        null,
        2,
      ),
    );
  });
program
  .command('scale <service> <replicas>')
  .description('scale a service to N replicas across matching nodes')
  .action(async (service: string, replicas: string, o: CommonOpts) => {
    const cfg = await loadCfg();
    const project = o.project || cfg.project || 'site';
    if (!/^[1-9]\d*$/.test(replicas)) throw new Error('replicas must be a positive integer');
    console.log(
      JSON.stringify(
        await request('POST', '/api/v1/scale', { project, service, replicas: Number(replicas) }),
        null,
        2,
      ),
    );
  });
program
  .command('control-install <sshTarget>')
  .description(
    'install the control plane on a Docker-capable host over SSH and issue the root credential into a local 0600 file; it listens for mTLS only, so front it with TCP passthrough rather than a terminating proxy',
  )
  .requiredOption(
    '--public-url <url>',
    'credential-free https origin clients use, including the published port',
  )
  .option(
    '--extra-san <name>',
    'additional DNS name or IP for the server certificate (repeatable)',
    collect,
    [],
  )
  .option(
    '--image <tag>',
    "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
  )
  .option(
    '--install-docker',
    'install missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts (root required)',
  )
  .option(
    '--build-local-image',
    'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development',
  )
  .option('--port <port>', 'published mTLS port', '8443')
  .option(
    '--credential-out <file>',
    'where to write the root credential',
    'tug-root.credential.json',
  )
  .option(
    '--recover-root',
    "replace root's key from the control host without the API (lost credential); other admins are unaffected",
  )
  .option(
    '--mesh',
    'enable the WireGuard mesh on control (TUG_MESH=true); install nodes with --mesh too',
  )
  .action(
    async (
      sshTarget: string,
      o: InstallOpts & {
        publicUrl: string;
        extraSan: string[];
        port: string;
        credentialOut: string;
        recoverRoot?: boolean;
        mesh?: boolean;
      },
    ) => {
      const publicUrl = normalizeControlUrl(o.publicUrl);
      if (o.installDocker) await bootstrapDocker(sshTarget, true);
      preflightRemote(sshTarget, { ports: [Number(o.port)], minDiskMb: 2048, compose: true });
      const image = resolveImage(o.image, o.buildLocalImage);
      if (o.buildLocalImage) await transferTugImage(sshTarget, image);
      const yamlValue = (value: string) => JSON.stringify(value);
      const compose = await loadTemplate(templatesDir, 'control-compose.yml', {
        IMAGE: yamlValue(image),
        PUBLIC_URL: yamlValue(new URL(publicUrl).origin),
        EXTRA_SANS: yamlValue(o.extraSan.join(',')),
        PORT: o.port,
        MESH: yamlValue(o.mesh ? 'true' : 'false'),
      });
      const remote = await loadTemplate(templatesDir, 'control-install.sh', {
        COMPOSE: compose,
        CONTAINER_SH: sh(CONTROL_CONTAINER),
      });
      runLocal('ssh', ['--', sshTarget, remote]);
      // Upgrades never reissue root: fresh installs create it, `--recover-root` replaces its key. Output goes straight to a file.
      const issue = `docker exec ${sh(CONTROL_CONTAINER)} node dist/main.js control issue-credential --name root --role admin${o.recoverRoot ? ' --replace' : ''}`;
      const out = spawnSync('ssh', ['--', sshTarget, issue], { encoding: 'utf8' });
      if (out.status !== 0) {
        if (!o.recoverRoot && /already used/.test(String(out.stderr)))
          console.error(
            'control already has a root credential; upgrade complete (pass --recover-root to replace it)',
          );
        else throw new Error(`issuing the root credential failed: ${String(out.stderr).trim()}`);
      } else {
        decodeCredential(out.stdout);
        await writeFileDurable(o.credentialOut, `${String(out.stdout).trim()}\n`, 0o600);
        console.error(
          `root credential written to ${o.credentialOut}; import it with: tug init ${o.credentialOut}`,
        );
      }
      console.log(JSON.stringify({ ok: true, sshTarget, url: publicUrl }, null, 2));
    },
  );

/** Everything the SSH-assisted node commands share. */
interface NodeIdentityOpts extends InstallOpts {
  name?: string;
  address?: string;
  publicAddress?: string;
  label: string[];
  agentControlUrl?: string;
  mesh?: boolean;
  wgPort: string;
  all?: boolean;
  wait: boolean;
}
const AGENT_STATE = '/var/lib/tug';
function addNodeIdentityOptions(command: Command): Command {
  return command
    .option('--name <name>', 'node name')
    .option(
      '--all',
      'walk every node with an ssh target in the config file, continuing after failures',
    )
    .option(
      '--agent-control-url <url>',
      'connect-only URL the agent dials (for example a private address); the certificate is still verified against the credential URL',
    )
    .option(
      '--mesh',
      'join the WireGuard mesh (agent runs with host networking and NET_ADMIN; control needs TUG_MESH=true)',
    )
    .option('--wg-port <port>', 'WireGuard UDP port checked by preflight', '51820')
    .option(
      '--image <tag>',
      "Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
    )
    .option(
      '--install-docker',
      'install missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts (root required)',
    )
    .option(
      '--build-local-image',
      'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development',
    )
    .option('--no-wait', 'do not wait for the node to report after the install');
}
/**
 * The SSH-assisted flow: the node makes its own key and CSR, an admin credential authorizes the identity at this moment and
 * the certificate is installed back over SSH, so no bootstrap secret travels and the private key never leaves the node.
 */
async function installNodeIdentity(
  sshTarget: string,
  name: string,
  mode: 'create' | 'replace',
  o: NodeIdentityOpts,
  repair = false,
): Promise<void> {
  const cfg = await loadCfg();
  const connectUrl = o.agentControlUrl ? normalizeControlUrl(o.agentControlUrl) : undefined;
  await transportFor(cfg).then((t) => t.close()); // fail before touching the host when there is no credential
  if (o.installDocker) await bootstrapDocker(sshTarget);
  preflightRemote(sshTarget, {
    controlUrl: connectUrl ?? cfg.credential?.url,
    mesh: o.mesh,
    udpPorts: o.mesh ? [Number(o.wgPort)] : [],
  });
  const image = resolveImage(o.image, o.buildLocalImage);
  if (o.buildLocalImage) await transferTugImage(sshTarget, image);
  const started = new Date().toISOString();
  if (repair)
    runLocal('ssh', [
      '--',
      sshTarget,
      `mkdir -p ${AGENT_STATE} && cd ${AGENT_STATE} && for f in agent.json agent-pending.json; do [ -e "$f" ] && mv "$f" "$f.corrupt-$(date +%s)"; done; true`,
    ]);
  const agent = (command: string, interactive = false) =>
    `mkdir -p ${AGENT_STATE} && docker run --rm ${interactive ? '-i ' : ''}-v ${AGENT_STATE}:${AGENT_STATE} ${sh(image)} agent ${command}`;
  const csr = runCapture('ssh', ['--', sshTarget, agent('identity')]);
  const response = await request<IdentityResponse>(
    'POST',
    `/api/v1/nodes/${encodeURIComponent(name)}/identity`,
    { csr, mode, address: o.address, publicAddress: o.publicAddress, labels: o.label },
  );
  runCapture('ssh', ['--', sshTarget, agent('install-cert', true)], {
    input: JSON.stringify(response),
  });
  const env =
    (await loadTemplate(templatesDir, 'agent.env', {
      CONTROL_URL_LINE: connectUrl ? `TUG_CONTROL_URL=${connectUrl}\n` : '',
      NODE_NAME: name,
    })) + (o.mesh ? 'TUG_MESH=true\n' : '');
  const remote = await loadTemplate(templatesDir, 'node-install.sh', {
    ENV: env,
    IMAGE_SH: sh(image),
    RUN_FLAGS: `${o.mesh ? MESH_RUN_FLAGS : HOST_NETWORK_FLAG} `,
  });
  runLocal('ssh', ['--', sshTarget, remote]);
  if (o.wait) {
    // A report from the new identity: wait for a report after the install began, not a replaced node's stale status.
    for (let i = 0; i < 30; i++) {
      const { nodes } = await request<{ nodes: { name: string; last_seen_at: string | null }[] }>(
        'GET',
        '/api/v1/nodes',
      );
      const seen = nodes.find((n) => n.name === name)?.last_seen_at;
      if (seen && seen > started)
        return void console.log(JSON.stringify({ ok: true, node: response.node }, null, 2));
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error(`node ${name} has not reported yet; check \`docker logs tug-agent\` on the host`);
  }
  console.log(JSON.stringify({ ok: true, node: response.node }, null, 2));
}
async function runNodeIdentity(
  sshArgument: string | undefined,
  o: NodeIdentityOpts,
  mode: 'create' | 'replace',
  repair = false,
): Promise<void> {
  const cfg = await loadCfg();
  const verb = repair
    ? 'node-repair-identity'
    : mode === 'create'
      ? 'node-install'
      : 'node-replace-identity';
  if (o.all) {
    const results: { node: string; ok: boolean; error?: string }[] = [];
    for (const [name, settings] of Object.entries(cfg.nodes)) {
      const target = settings.ssh as string | undefined;
      if (!target) continue;
      const merged = { ...o, ...nodeOverrides(settings), name };
      try {
        await installNodeIdentity(target, name, mode, merged, repair);
        results.push({ node: name, ok: true });
      } catch (e) {
        results.push({ node: name, ok: false, error: errMessage(e) });
      }
    }
    console.log(JSON.stringify({ results }, null, 2));
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (!o.name) throw new Error(`${verb} needs --name`);
  const sshTarget = sshArgument ?? (nodeSettings(cfg, o.name).ssh as string | undefined);
  if (!sshTarget)
    throw new Error(
      `${verb} needs an SSH target: pass <ssh-target> or set nodes.${o.name}.ssh in ${cfg.file}`,
    );
  await installNodeIdentity(sshTarget, o.name, mode, o, repair);
}
const nodeOverrides = (settings: Record<string, unknown>) => ({
  ...(settings.address ? { address: settings.address as string } : {}),
  ...(settings.publicAddress ? { publicAddress: settings.publicAddress as string } : {}),
  ...(Array.isArray(settings.label) ? { label: settings.label as string[] } : {}),
  ...(settings.mesh ? { mesh: true } : {}),
});
for (const [verb, description, mode, repair] of [
  [
    'node-install',
    'create a node and install its agent over SSH (the SSH target defaults to nodes.<name>.ssh in the config file); safe to rerun after a partial failure',
    'create',
    false,
  ],
  [
    'node-replace-identity',
    'install a new key on an existing node over SSH: for an expired, lost or suspected key, a disabled node, a CA loss or an older restore',
    'replace',
    false,
  ],
  [
    'node-repair-identity',
    'move aside corrupt agent credential documents on the node (never service volumes) and replace its identity',
    'replace',
    true,
  ],
] as const) {
  const command = program
    .command(`${verb} [sshTarget]`)
    .description(description)
    .option('--address <addr>')
    .option('--public-address <addr>')
    .option('--label <label>', 'node label (repeatable)', collect, []);
  addNodeIdentityOptions(command).action(
    async (sshArgument: string | undefined, o: NodeIdentityOpts) =>
      runNodeIdentity(sshArgument, o, mode, repair),
  );
}

program
  .command('node-prepare-enrollment')
  .description(
    'mint a single-use, name-bound join key so a host you cannot SSH to can self-join with one docker run; a saved cloud-init document contains a credential',
  )
  .requiredOption('--name <name>', 'the node name the key is bound to; mint one key per instance')
  .option(
    '--agent-control-url <url>',
    'connect-only URL the agent dials; the certificate is still verified against the credential URL',
  )
  .option('--ttl <seconds>', 'join key lifetime', '3600')
  .option(
    '--image <tag>',
    "agent image used in the printed docker run (default: ghcr.io/wpelevator/tug:<this CLI's version>)",
  )
  .option('--mesh', 'print a docker run that joins the WireGuard mesh (host networking, NET_ADMIN)')
  .option('--label <label>', 'node label (repeatable)', collect, [])
  .option('--install-docker', 'print cloud-init that installs Docker and starts the agent')
  .option('--json', 'print JSON including the command or cloud-init payload')
  .action(
    async (o: {
      name: string;
      agentControlUrl?: string;
      ttl: string;
      image?: string;
      mesh?: boolean;
      label: string[];
      json?: boolean;
      installDocker?: boolean;
    }) => {
      const connectUrl = o.agentControlUrl ? normalizeControlUrl(o.agentControlUrl) : undefined;
      const minted = await request<EnrollmentCredentialResponse>(
        'POST',
        '/api/v1/nodes/enrollment-credential',
        {
          name: o.name,
          ttlSeconds: Number(o.ttl),
          labels: o.label.length ? o.label : undefined,
        },
      );
      const keyPayload: JoinKey = {
        v: 2,
        credential: minted.credential,
        name: minted.name,
        ...(connectUrl ? { connectUrl } : {}),
      };
      const joinKey = Buffer.from(JSON.stringify(keyPayload)).toString('base64url');
      const command = dockerRunSnippet(resolveImage(o.image), joinKey, o.mesh);
      const cloudInit = o.installDocker
        ? enrollmentCloudInit(await dockerBootstrap(), command)
        : undefined;
      if (o.json) {
        console.log(
          JSON.stringify(
            {
              name: minted.name,
              expiresAt: minted.expiresAt,
              joinKey,
              command,
              ...(cloudInit ? { cloudInit } : {}),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (cloudInit) {
        process.stdout.write(cloudInit);
        return;
      }
      console.log(
        `# Join key for ${minted.name} valid until ${minted.expiresAt}, single use. Run on the fresh host:\n`,
      );
      console.log(command);
    },
  );

program
  .command('secret-set <name>')
  .option('--value <value>')
  .action(async (name: string, o: CommonOpts & { value?: string }) => {
    const value =
      o.value ??
      (await new Promise<string>((resolve) => {
        process.stdout.write(`${name}: `);
        process.stdin.once('data', (d) => resolve(String(d).trim()));
      }));
    console.log(
      await request('POST', '/api/v1/secrets', {
        project: o.project || (await loadCfg()).project || 'site',
        name,
        value,
      }),
    );
  });
program
  .command('secret-list')
  .action(async (o: CommonOpts) =>
    console.log(
      JSON.stringify(
        await request(
          'GET',
          `/api/v1/secrets?project=${encodeURIComponent(o.project || (await loadCfg()).project || 'site')}`,
        ),
        null,
        2,
      ),
    ),
  );
program
  .command('secret-remove <name>')
  .action(async (name: string, o: CommonOpts) =>
    console.log(
      await request(
        'DELETE',
        `/api/v1/secrets/${encodeURIComponent(name)}?project=${encodeURIComponent(o.project || (await loadCfg()).project || 'site')}`,
      ),
    ),
  );

interface BackupRunRecord {
  id: string;
  target: string;
  node_id: string | null;
  trigger: string;
  state: string;
  snapshot_id: string | null;
  size_bytes: number | null;
  added_bytes: number | null;
  finished_at: string | null;
  queued_at: string | null;
  error: string | null;
}
interface BackupListing {
  destinationConfigured: boolean;
  targets: {
    target: string;
    node: string | null;
    schedule: string;
    enabled: boolean;
    nextRunAt: string;
    lastSuccessAt: string | null;
    lastStatus: string | null;
    problem: string | null;
  }[];
  runs: BackupRunRecord[];
}
const formatBytes = (bytes: number | null): string =>
  bytes === null
    ? '-'
    : bytes < 1024 ** 2
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const BACKUP_TERMINAL = ['succeeded', 'failed', 'missed', 'cancelled'];

program
  .command('backup-run [targets...]')
  .description(
    'back up the named services or volumes now, or every backup target of the project; waits and exits nonzero if any backup fails',
  )
  .option('--no-wait', 'return once the backups are queued')
  .option('--timeout <seconds>', 'give up waiting after this many seconds', '3600')
  .action(async (targets: string[], o: { wait: boolean; timeout: string }) => {
    const project = (await loadCfg()).project || 'site';
    const queued = await request<{ runs: { runId: string; target: string }[]; errors: string[] }>(
      'POST',
      '/api/v1/backups/run',
      { project, targets: targets.length ? targets : undefined },
    );
    for (const message of queued.errors) console.error(message);
    for (const run of queued.runs) console.log(`queued ${run.target} as ${run.runId}`);
    let failed = queued.errors.length > 0;
    if (o.wait) {
      const deadline = Date.now() + Number(o.timeout) * 1000;
      const pending = new Set(queued.runs.map((run) => run.runId));
      while (pending.size && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const listing = await request<BackupListing>(
          'GET',
          `/api/v1/backups?project=${encodeURIComponent(project)}&limit=200`,
        );
        for (const run of listing.runs)
          if (pending.has(run.id) && BACKUP_TERMINAL.includes(run.state)) {
            pending.delete(run.id);
            const ok = run.state === 'succeeded';
            failed ||= !ok;
            console.log(
              ok
                ? `${run.target}: snapshot ${run.snapshot_id?.slice(0, 8)}, ${formatBytes(run.added_bytes)} added`
                : `${run.target}: ${run.state}${run.error ? ` (${run.error})` : ''}`,
            );
          }
      }
      if (pending.size) {
        console.error(
          `timed out waiting for ${pending.size} backup(s); they keep running on the node`,
        );
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  });
program
  .command('backup-list')
  .description('show each backup target with its last success and next run, then recent runs')
  .option('--limit <n>', 'number of recent runs to show', '20')
  .option(
    '--check',
    'exit nonzero when a target is stale, or its last run failed or was missed, or there is no destination; for cron and monitors',
  )
  .action(async (o: { limit: string; check?: boolean }) => {
    const project = (await loadCfg()).project || 'site';
    const listing = await request<BackupListing>(
      'GET',
      `/api/v1/backups?project=${encodeURIComponent(project)}&limit=${encodeURIComponent(o.limit)}`,
    );
    if (!listing.destinationConfigured)
      console.error('no backup destination is configured; run tug backup-destination-set');
    if (!listing.targets.length)
      console.log('no backup targets; add x-tug.backup to a database service or volume');
    for (const t of listing.targets)
      console.log(
        `${t.target}\t${t.node ?? '-'}\t${t.schedule}\tlast success ${t.lastSuccessAt ?? 'never'}\tnext ${t.enabled ? t.nextRunAt : 'disabled'}`,
      );
    for (const r of listing.runs)
      console.log(
        `${r.finished_at ?? r.queued_at}\t${r.target}\t${r.trigger}\t${r.state}\t${r.snapshot_id?.slice(0, 8) ?? '-'}\t${formatBytes(r.size_bytes)}${r.error ? `\t${r.error}` : ''}`,
      );
    if (o.check) {
      const problems = backupCheckProblems(listing);
      for (const problem of problems) console.error(`PROBLEM ${problem}`);
      if (problems.length) process.exitCode = 1;
    }
  });
interface RestorePlanView {
  target: string;
  node: string;
  snapshotId: string;
  snapshotTime: string | null;
  mode: string;
  scratchVolume?: string;
  writers: string[];
  safetyBackup: boolean;
}
interface RestoreRecord {
  id: string;
  target: string;
  state: string;
  mode: string;
  snapshot_id: string;
  scratch_volume: string | null;
  error: string | null;
  started_at: string | null;
}

program
  .command('restore <target>')
  .description(
    'restore a service or volume from a backup. Without --confirm it only prints the plan. An in-place restore locks the project, stops the services that write to the target, takes a safety backup, restores, then starts them again',
  )
  .option('--from <id>', 'backup run id, restic snapshot id, or latest', 'latest')
  .option(
    '--scratch',
    'restore a volume into a new volume next to the live one, touching nothing live',
  )
  .option(
    '--no-safety-backup',
    'skip the backup of the current data taken before an in-place restore',
  )
  .option(
    '--writers <service>',
    'service to stop during the restore, instead of discovering them (repeatable)',
    collect,
    [],
  )
  .option('--no-writers', 'restore without stopping any service')
  .option('--confirm', 'perform the restore')
  .option('--timeout <seconds>', 'give up waiting after this many seconds', '3600')
  .action(
    async (
      target: string,
      o: {
        from: string;
        scratch?: boolean;
        safetyBackup: boolean;
        writers: string[] | false;
        confirm?: boolean;
        timeout: string;
      },
    ) => {
      const project = (await loadCfg()).project || 'site';
      const explicit = Array.isArray(o.writers) && o.writers.length > 0 ? o.writers : undefined;
      const result = await request<{
        confirmed: boolean;
        plan: RestorePlanView;
        restoreId?: string;
      }>('POST', '/api/v1/restores', {
        project,
        target,
        from: o.from,
        scratch: o.scratch === true,
        safetyBackup: o.safetyBackup,
        writers: explicit,
        noWriters: o.writers === false,
        confirm: o.confirm === true,
      });
      const plan = result.plan;
      console.log(`target:   ${plan.target} on ${plan.node}`);
      console.log(
        `snapshot: ${plan.snapshotId}${plan.snapshotTime ? ` (${plan.snapshotTime})` : ''}`,
      );
      console.log(
        `mode:     ${plan.mode}${plan.scratchVolume ? ` into new volume ${plan.scratchVolume}` : ''}`,
      );
      if (plan.mode === 'in-place') {
        console.log(`stops:    ${plan.writers.length ? plan.writers.join(', ') : 'nothing'}`);
        console.log(
          `safety:   ${plan.safetyBackup ? 'a backup of the current data is taken first' : 'none (--no-safety-backup)'}`,
        );
      }
      if (!result.confirmed) {
        console.log('\nNothing was changed. Run again with --confirm to restore.');
        return;
      }
      const deadline = Date.now() + Number(o.timeout) * 1000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const { restores } = await request<{ restores: RestoreRecord[] }>(
          'GET',
          `/api/v1/restores?project=${encodeURIComponent(project)}`,
        );
        const restore = restores.find((item) => item.id === result.restoreId);
        if (restore?.state === 'succeeded') {
          if (restore.error) console.error(`warning: ${restore.error}`);
          console.log(
            `restore ${restore.id} completed${restore.scratch_volume ? `; files are in volume ${restore.scratch_volume}` : ''}`,
          );
          return;
        }
        if (restore && ['failed', 'interrupted', 'released'].includes(restore.state)) {
          console.error(`restore ${restore.id} ${restore.state}: ${restore.error ?? ''}`);
          if (restore.state === 'interrupted')
            console.error(
              `the services stay stopped; run tug restore-resume ${restore.id} to try again or tug restore-release ${restore.id} to start them (data may be partly restored)`,
            );
          process.exitCode = 1;
          return;
        }
        if (Date.now() > deadline) {
          console.error(
            `timed out waiting; restore ${result.restoreId} continues on control (tug restore-list)`,
          );
          process.exitCode = 1;
          return;
        }
      }
    },
  );
program
  .command('restore-list')
  .description('show recent restores and their state')
  .action(async () => {
    const project = (await loadCfg()).project || 'site';
    const { restores } = await request<{ restores: RestoreRecord[] }>(
      'GET',
      `/api/v1/restores?project=${encodeURIComponent(project)}`,
    );
    if (!restores.length) console.log('no restores');
    for (const r of restores)
      console.log(
        `${r.started_at}\t${r.id}\t${r.target}\t${r.mode}\t${r.state}\t${r.snapshot_id.slice(0, 8)}${r.error ? `\t${r.error}` : ''}`,
      );
  });
program
  .command('restore-resume <id>')
  .description('run an interrupted restore again; the stopped services stay stopped meanwhile')
  .action(async (id: string) =>
    console.log(
      JSON.stringify(await request('POST', `/api/v1/restores/${encodeURIComponent(id)}/resume`)),
    ),
  );
program
  .command('restore-release <id>')
  .description(
    'start the services an interrupted restore stopped and unlock the project; the data may be partly restored',
  )
  .action(async (id: string) =>
    console.log(
      JSON.stringify(await request('POST', `/api/v1/restores/${encodeURIComponent(id)}/release`)),
    ),
  );
program
  .command('backup-destination-set <url>')
  .description(
    'set where backups go, such as s3:https://s3.example.com/bucket/tug-backups; credentials are stored encrypted on control',
  )
  .option(
    '--env <name>',
    'credential variable for the backend, such as AWS_ACCESS_KEY_ID (repeatable); each value is read from the variable of that name in your environment, else from a line on stdin',
    collect,
    [],
  )
  .action(async (url: string, o: { env: string[] }) => {
    const missing = o.env.filter((name) => process.env[name] === undefined);
    const lines = missing.length
      ? (await readStdin()).split(/\r?\n/).filter((line) => line.length > 0)
      : [];
    if (lines.length < missing.length)
      throw new Error(`expected a value on stdin for ${missing.slice(lines.length).join(', ')}`);
    const env = Object.fromEntries(
      o.env.map((name) => [name, process.env[name] ?? lines[missing.indexOf(name)]]),
    );
    console.log(JSON.stringify(await request('POST', '/api/v1/backup/destination', { url, env })));
  });
program
  .command('backup-destination-show')
  .description(
    'show the backup destination and the names of its credential variables, never values',
  )
  .action(async () =>
    console.log(JSON.stringify(await request('GET', '/api/v1/backup/destination'), null, 2)),
  );
program
  .command('backup-destination-remove')
  .description(
    'remove the backup destination and its stored credentials; existing backups stay in the repository',
  )
  .action(async () =>
    console.log(JSON.stringify(await request('DELETE', '/api/v1/backup/destination'))),
  );
program
  .command('backup-repository-password')
  .description(
    "print the project's repository and its password for offline escrow; anyone holding the password and destination credentials can read the project's backups",
  )
  .action(async () => {
    const c = await loadCfg();
    const project = c.project || 'site';
    console.log(
      JSON.stringify(
        await request(
          'GET',
          `/api/v1/backup/repository-password?project=${encodeURIComponent(project)}`,
        ),
        null,
        2,
      ),
    );
  });

program
  .command('credential-create <name>')
  .description(
    'create a named operator credential for CI or a teammate; it is printed once, control keeps no copy of its private key, and it expires after one year at most',
  )
  .addOption(
    new Option(
      '--role <role>',
      'read: status and listings; deploy: read plus deploy, rollback, cancel, restart, logs; admin: everything',
    )
      .choices(ROLES)
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--project <name>',
      'limit a read or deploy token to this project; repeat for several',
    )
      .default([] as string[], 'all projects')
      .argParser((value: string, previous: string[]) => [...previous, value]),
  )
  .option(
    '--expires-in-days <n>',
    'expire the credential after this many days (default and maximum: 365)',
  )
  .action(async (name: string, o: { role: string; project: string[]; expiresInDays?: string }) => {
    const created = await request('POST', '/api/v1/credentials', {
      name,
      role: o.role,
      projects: o.project.length ? o.project : undefined,
      expiresInSeconds: o.expiresInDays ? Number(o.expiresInDays) * 86400 : undefined,
    });
    console.error(
      'Store this credential now (for example as the TUG_CREDENTIAL secret in CI); it is not shown again. Replace one by creating a new name, verifying it, then revoking the old name.',
    );
    console.log(JSON.stringify(created, null, 2));
  });
program
  .command('credential-list')
  .description(
    'list operator credentials with role, projects, expiry and last use; secrets are never shown',
  )
  .action(async () =>
    console.log(JSON.stringify(await request('GET', '/api/v1/credentials'), null, 2)),
  );
program
  .command('credential-revoke <name>')
  .description(
    'revoke an operator credential immediately; its name stays reserved for the audit trail',
  )
  .action(async (name: string) =>
    console.log(
      JSON.stringify(
        await request('DELETE', `/api/v1/credentials/${encodeURIComponent(name)}`),
        null,
        2,
      ),
    ),
  );

async function makeContext(): Promise<string> {
  const tmp = path.join(os.tmpdir(), `tug-${Date.now()}.tgz`);
  try {
    await createSourceArchive(process.cwd(), tmp, [
      resolvedConfig!.file,
      resolvedConfig!.localFile,
    ]);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return tmp;
}
program
  .command('deploy')
  .option('-f, --file <file>', 'compose file', 'docker-compose.yml')
  .option('--version <version>', 'display version (default: git-<Compose hash>)')
  .option('--build-local', 'build application images locally and upload them without source')
  .option('--no-wait', 'return after desired state is created')
  .option('--timeout <seconds>', 'wait timeout in seconds', '300')
  .action(
    async (o: CommonOpts & WaitOpts & { file: string; version?: string; buildLocal?: boolean }) => {
      const cfg = await loadCfg();
      const project = o.project || cfg.project || 'site';
      // Control secrets are interpolated as sentinels; the agent substitutes the node's released values.
      const { secrets } = await request<{ secrets: { name: string }[] }>(
        'GET',
        `/api/v1/secrets?project=${encodeURIComponent(project)}`,
      );
      const compose = await normalizeCompose(
        o.file,
        secrets.map((secret) => secret.name),
        { project },
      );
      const version = o.version || `git-${composeHash(compose)}`;
      let response: DeployResponse;
      if (o.buildLocal) {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-local-build-'));
        try {
          const form = new FormData();
          const localImages = await prepareLocalImages(compose, process.cwd(), directory);
          for (const { field } of localImages)
            form.append(
              field,
              await openAsBlob(path.join(directory, `${field}.tar.gz`)),
              `${field}.tar.gz`,
            );
          form.append('payload', JSON.stringify({ project, version, compose, localImages }));
          response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      } else if (Object.values(compose.services).some((service) => service.build)) {
        const tarball = await makeContext();
        try {
          const form = new FormData();
          form.append('payload', JSON.stringify({ project, version, compose }));
          form.append('context', await openAsBlob(tarball), 'context.tgz');
          response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
        } finally {
          await fs.rm(tarball, { force: true });
        }
      } else
        response = await request<DeployResponse>('POST', '/api/v1/deployments', {
          project,
          version,
          compose,
        });
      if (o.wait)
        response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
      console.log(JSON.stringify(response, null, 2));
    },
  );
program
  .command('status')
  .action(async () => console.log(JSON.stringify(await request('GET', '/api/v1/status'), null, 2)));
program
  .command('events')
  .description(
    'list recent events with the credential that caused each control action; defaults to the resolved project',
  )
  .option('--limit <n>', 'number of events', '100')
  .option(
    '--all',
    'list events across all projects (limited to your projects for scoped credentials)',
  )
  .action(async (o: CommonOpts & { limit: string; all?: boolean }) => {
    if (o.all && o.project) throw new Error('--all and --project cannot be combined');
    const cfg = await loadCfg();
    const project = o.all ? undefined : o.project || cfg.project;
    const query = `limit=${encodeURIComponent(o.limit)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
    console.log(JSON.stringify(await request('GET', `/api/v1/events?${query}`), null, 2));
  });
program
  .command('doctor')
  .description('run local and control-plane diagnostics')
  .option('--nodes', 'also run diagnostics on every registered agent and wait')
  .option('--node <name>', 'run diagnostics on one agent and wait')
  .option('--timeout <seconds>', 'wait timeout for node diagnostics', '60')
  .action(async (o: { nodes?: boolean; node?: string; timeout: string }) => {
    const local: { name: string; ok: boolean; output?: string; error?: string }[] = [];
    for (const [name, cmd, args] of [
      ['node', 'node', ['--version']],
      ['docker', 'docker', ['version', '--format', '{{.Server.Version}}']],
      ['docker_compose', 'docker', ['compose', 'version']],
    ] as [string, string, string[]][]) {
      try {
        local.push({ name, ok: true, output: runCapture(cmd, args).trim() });
      } catch (e) {
        local.push({ name, ok: false, error: errMessage(e) });
      }
    }
    const controlDiagnostics = await request('GET', '/api/v1/diagnostics');
    const output: {
      ok: boolean;
      local: typeof local;
      control: unknown;
      nodeDiagnostics?: unknown;
    } = {
      ok: local.every((c) => c.ok) && controlDiagnostics.ok,
      local,
      control: controlDiagnostics,
    };
    if (o.nodes || o.node) {
      const queued = await request<{ commands: { commandId: string; nodeId: string }[] }>(
        'POST',
        '/api/v1/diagnostics/nodes',
        { node: o.node || null },
      );
      const commands = [];
      for (const command of queued.commands) {
        const finished = await waitForCommand(command.commandId, Number(o.timeout));
        commands.push({
          nodeId: command.nodeId,
          state: finished.state,
          result: JSON.parse(finished.result_json || '{}'),
        });
      }
      output.nodeDiagnostics = { commands };
      if (commands.some((command) => command.state !== 'succeeded')) output.ok = false;
    }
    console.log(JSON.stringify(output, null, 2));
  });
program
  .command('rollback')
  .option('--force')
  .option('--no-wait', 'return immediately after activating rollback')
  .option('--timeout <seconds>', 'wait timeout', '300')
  .action(async (o: CommonOpts & WaitOpts & { force?: boolean }) => {
    const cfg = await loadCfg();
    const response = await request<DeployResponse>('POST', '/api/v1/rollback', {
      project: o.project || cfg.project || 'site',
      force: Boolean(o.force),
    });
    if (o.wait)
      response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
    console.log(JSON.stringify(response, null, 2));
  });
program
  .command('deploy-cancel <id>')
  .action(async (id: string) =>
    console.log(
      JSON.stringify(
        await request('POST', `/api/v1/deployments/${encodeURIComponent(id)}/cancel`, {}),
        null,
        2,
      ),
    ),
  );
program.command('volume-list').action(async (o: CommonOpts) => {
  const cfg = await loadCfg();
  console.log(
    JSON.stringify(
      await request(
        'GET',
        `/api/v1/volumes?project=${encodeURIComponent(o.project || cfg.project || 'site')}`,
      ),
      null,
      2,
    ),
  );
});
program
  .command('volume-remove <name>')
  .option('--delete-data', 'delete underlying Docker volume data')
  .action(async (name: string, o: CommonOpts & { deleteData?: boolean }) => {
    const cfg = await loadCfg();
    const project = o.project || cfg.project || 'site';
    console.log(
      JSON.stringify(
        await request(
          'DELETE',
          `/api/v1/volumes/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}&deleteData=${Boolean(o.deleteData)}`,
        ),
        null,
        2,
      ),
    );
  });
program
  .command('control-backup')
  .description('create a control-plane SQLite/master-key backup')
  .action(async () =>
    console.log(JSON.stringify(await request('POST', '/api/v1/control/backups/run', {}), null, 2)),
  );
program
  .command('control-restore <artifactRef>')
  .description('restore a control-plane backup; requires control restart')
  .option('--confirm')
  .action(async (artifactRef: string, o: { confirm?: boolean }) =>
    console.log(
      JSON.stringify(
        await request('POST', '/api/v1/control/restore', {
          artifactRef,
          confirm: Boolean(o.confirm),
        }),
        null,
        2,
      ),
    ),
  );
async function waitForCommand(commandId: string, timeoutSeconds = 60): Promise<CommandRecord> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const cmd = await request<CommandRecord | null>('GET', `/api/v1/commands/${commandId}`);
    if (cmd?.state === 'succeeded' || cmd?.state === 'failed') return cmd;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for command ${commandId}`);
}
program
  .command('restart <service>')
  .option('--timeout <seconds>', 'wait timeout', '60')
  .action(async (svc: string, o: CommonOpts & { timeout: string }) => {
    const cfg = await loadCfg();
    const project = o.project || cfg.project || 'site';
    const created = await request('POST', '/api/v1/restart', { project, service: svc });
    const cmd = await waitForCommand(created.commandId, Number(o.timeout));
    if (cmd.state === 'failed')
      throw new Error(JSON.parse(cmd.result_json || '{}').error || 'restart failed');
    console.log(JSON.stringify(cmd, null, 2));
  });
async function runLive(
  operation: LiveRequest['operation'],
  input: Omit<LiveInput, 'project'>,
): Promise<void> {
  const cfg = await loadCfg();
  process.exitCode = await runCliLive(
    parseLiveRequest(operation, { ...input, project: cfg.project || 'site' }),
    createCliLiveTransport(cfg.credential, cfg.controlUrl),
  );
}
program
  .command('exec <service> [command...]')
  .description('execute a command on a service container (default: sh)')
  .option('-i, --interactive', 'forward stdin to the remote command')
  .option('-t, --tty', 'allocate a terminal (requires a local terminal and agent TTY support)')
  .option('--node <name>', 'select the node when a service has multiple placements')
  .action(
    async (
      service: string,
      command: string[],
      o: { interactive?: boolean; tty?: boolean; node?: string },
    ) => {
      await runLive('exec', { service, command, ...o });
    },
  );
program
  .command('run <service> [command...]')
  .description(
    "run a one-off command in a new container from the service: same image, environment, secrets, network and mounts, removed afterwards (for example: tug run web -- wp core update-db). Exits with the command's exit code",
  )
  .option('--node <name>', 'select the node when a service has multiple placements')
  .action(async (service: string, command: string[], o: { node?: string }) => {
    if (!command.length)
      throw new Error('run needs a command, such as: tug run web -- wp core update-db');
    await runLive('exec', { service, command, node: o.node, oneOff: true });
  });
program
  .command('ps')
  .description('print per-container state as JSON')
  .option('--node <name>', 'select one node')
  .action(async (o: { node?: string }) => {
    await runLive('ps', o);
  });
program
  .command('inspect <service>')
  .description('print container details as JSON')
  .option('--node <name>', 'select one node')
  .action(async (service: string, o: { node?: string }) => {
    await runLive('inspect', { service, ...o });
  });
program
  .command('logs <service>')
  .description('fetch logs from the assigned node agent')
  .option('--tail <n>', 'number of lines', '200')
  .option('-f, --follow', 'follow live logs')
  .option('--node <name>', 'select a node for followed logs')
  .action(
    async (svc: string, o: CommonOpts & { tail: string; follow?: boolean; node?: string }) => {
      if (o.follow) {
        await runLive('logs', { service: svc, node: o.node, tail: o.tail });
        return;
      }
      if (o.node) throw new Error('--node requires --follow for logs');
      const cfg = await loadCfg();
      const project = o.project || cfg.project || 'site';
      const created = await request('POST', '/api/v1/logs', {
        project,
        service: svc,
        tail: Number(o.tail),
      });
      const cmd = await waitForCommand(created.commandId, 60);
      const result = JSON.parse(cmd.result_json || '{}');
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) throw new Error(result.error);
    },
  );

program.hook('preAction', async (_root, command) => {
  const options = command.opts();
  for (const [key, min, max] of [
    ['port', 1, 65535],
    ['wgPort', 1, 65535],
    ['timeout', 1, 86400],
    ['ttl', 1, 31536000],
    ['uses', 1, 1000000],
    ['expiresInDays', 1, 3650],
    ['limit', 1, 500],
    ['tail', 0, 1000000],
  ] as const) {
    if (options[key] !== undefined)
      integerOption(
        String(options[key]),
        '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
        min,
        max,
      );
  }
  if (command.name() === 'control-restore' && !options.confirm)
    throw new Error('control-restore requires --confirm');
  const positional = command.name() === 'exec' ? command.args.slice(0, 1) : command.args;
  for (const value of [...positional, ...Object.values(options), ...Object.values(program.opts())])
    if (typeof value === 'string' && /[\r\n\0]/.test(value))
      throw new Error('arguments and option values must not contain line breaks or NUL');
  if (command.name() === 'exec' && command.args.slice(1).some((value) => value.includes('\0')))
    throw new Error('exec command arguments must not contain NUL');
  if (options.name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.name))
    throw new Error('--name must contain only letters, numbers, dots, underscores or hyphens');
  const connection = command.optsWithGlobals();
  if (command.name() === 'credential-create') {
    // --project is repeatable here and scopes the new credential, so it must not also select the connection project.
    if (!CREDENTIAL_NAME_PATTERN.test(command.args[0]))
      throw new Error(
        'credential name must be 1-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number',
      );
    for (const project of options.project as string[])
      if (!PROJECT_NAME_PATTERN.test(project))
        throw new Error(
          '--project must contain only letters, numbers, dots, underscores or hyphens',
        );
    if (options.role === 'admin' && options.project.length)
      throw new Error(
        'admin credentials cannot be limited to projects; use --role read or --role deploy with --project',
      );
    connection.project = undefined;
  }
  resolvedConfig = await resolveCliConfig(
    connection,
    process.env,
    process.cwd(),
    command.name() === 'init',
  );
  // Config values are defaults for options not given on the command line; nodes are only read by the
  // commands that create or register one, never by commands that talk to an existing node.
  const nodeName =
    command.name() === 'node-register'
      ? command.args[0]
      : [
            'node-install',
            'node-replace-identity',
            'node-repair-identity',
            'node-prepare-enrollment',
          ].includes(command.name())
        ? (options.name as string | undefined)
        : undefined;
  applyConfigDefaults(command, options, {
    ...resolvedConfig.commandDefaults,
    ...(command.name().startsWith('node-') ? nodeSettings(resolvedConfig, nodeName) : {}),
  });
});
for (const command of program.commands) {
  command
    .option('--config <file>', CONFIG_HELP)
    .option(
      '--control-url <url>',
      'connect target for the control API (the credential still verifies its own public URL)',
    )
    .option(
      '--credential <file>',
      'credential file (overrides TUG_CREDENTIAL, TUG_CREDENTIAL_FILE and config)',
    );
  if (!command.options.some((option) => option.long === '--project'))
    command.option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)');
}
for (const command of [program, ...program.commands]) command.allowExcessArguments(false);
program.showHelpAfterError();
program.parseAsync().catch((e: unknown) => {
  console.error(`${errMessage(e)}\nRun tug <command> --help for usage.`);
  process.exitCode = e instanceof CliLiveError ? e.exitCode : 1;
});
