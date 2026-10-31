#!/usr/bin/env node
import { Command } from 'commander';
import { openAsBlob } from 'node:fs';
import { resolveCliConfig, integerOption, normalizeControlUrl } from './cli-config.ts';
import { dockerRunSnippet, enrollmentCloudInit, shellQuote as sh, MESH_RUN_FLAGS, meshPortCheck } from './cli-install.ts';
import { createSourceArchive, prepareLocalImages } from './cli-build.ts';
import { saveImageArchive } from './artifacts.ts';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCompose, composeHash } from './compose.ts';
import { errMessage, token, loadTemplate } from './util.ts';
import { packageVersion, resolveImage } from './image.ts';
import { TERMINAL_DEPLOYMENT_STATES } from './protocol.ts';
import type { DeploymentState, EnrollTokenResponse, JoinKey, RegisterResponse } from './protocol.ts';

// Templates live next to this file: src/templates in dev (`node src/cli.ts`), dist/templates in the
// built image (`node dist/cli.js`; tools/scripts/copy-templates.js puts them there).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, 'templates');

interface Config { controlUrl?: string; operatorToken?: string; project?: string }
interface DeploymentRecord { id: string; state: DeploymentState; error_message?: string | null }
interface CommandRecord { state: string; result_json?: string | null }
interface DeployResponse { deployment: DeploymentRecord; desiredState?: unknown }
interface CommonOpts { project?: string }
interface WaitOpts { wait: boolean; timeout: string }
interface InstallOpts { buildLocalImage?: boolean; image?: string; installDocker?: boolean }

const program = new Command();
program.name('tug').description('Portable VPS deployments with Docker Compose').version(packageVersion()).enablePositionalOptions()
  .option('--config <file>', 'CLI JSON config file (default: TUG_CONFIG or .tug.json)')
  .option('--control-url <url>', 'control API URL (overrides TUG_CONTROL_URL and config)')
  .option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)');
let resolvedConfig: Awaited<ReturnType<typeof resolveCliConfig>> | undefined;
const cfgPath = () => resolvedConfig!.file;
async function loadCfg(): Promise<Config> { return resolvedConfig!; }
async function saveCfg(c: Config): Promise<void> { await fs.writeFile(cfgPath(), JSON.stringify(c, null, 2), { mode: 0o600 }); }
async function request<T = any>(method: string, route: string, body?: unknown, multipart = false): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = await loadCfg(); const base = c.controlUrl!; const tok = c.operatorToken;
  const headers: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
  if (!multipart) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, { method, headers, body: multipart ? body as FormData : body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
function runLocal(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}`);
}
function runCapture(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stderr || ''}`);
  return String(result.stdout);
}
function remoteHost(sshTarget: string): string { return sshTarget.replace(/^[^@]+@/, '').split(':')[0]; }
function assertHttps(url: string, allowHttp?: boolean): void {
  if (!allowHttp && !String(url).startsWith('https://')) throw new Error(`${url} must use https:// outside local development (pass --http-only-dev to override)`);
}
function preflightRemote(target: string, { controlUrl, ports = [], udpPorts = [], minDiskMb = 1024, mesh = false }: { controlUrl?: string; ports?: number[]; udpPorts?: number[]; minDiskMb?: number; mesh?: boolean } = {}): void {
  const checks: [string, string, string][] = [
    ['docker.version', 'docker version >/dev/null', 'Install Docker Engine and ensure the SSH user can access it.'],
    ['docker.compose.version', 'docker compose version >/dev/null', 'Install Docker Compose v2.'],
    ['paths', 'mkdir -p /opt/tug-preflight /var/lib/tug-preflight /etc/tug && test -w /opt/tug-preflight && test -w /var/lib/tug-preflight && test -w /etc/tug', 'Ensure /opt, /var/lib, and /etc/tug are writable by the installer.'],
    ['disk.space', `[ "$(df -Pm /var/lib | tail -1 | awk '{print $4}')" -ge ${Number(minDiskMb)} ]`, `Free at least ${minDiskMb}MB on the filesystem backing /var/lib.`]
  ];
  for (const port of ports) {
    checks.push([`port.${port}.free`, `! ( command -v ss >/dev/null 2>&1 && ss -ltn | awk '{print $4}' | grep -qE "[.:]${port}$" )`, `Port ${port} is already in use on the target host; stop the conflicting service or choose another port.`]);
  }
  if (mesh) {
    checks.push(['wireguard.kernel', 'ip link add tugwgtest type wireguard && ip link del tugwgtest || modprobe -n wireguard 2>/dev/null', 'Install WireGuard (kernel 5.6+ has it built in; older kernels need the wireguard-dkms package) and ensure iproute2 is present.']);
  }
  for (const port of udpPorts) {
    checks.push([`udp.${port}.free`, meshPortCheck(port), `UDP port ${port} is in use by something other than this node's running Tug mesh agent (or the ss tool is missing). Stop the conflicting service, or choose another port with --wg-port and set TUG_WG_PORT on control.`]);
  }
  if (controlUrl) checks.push(['control.reachable', `curl -fsS ${sh(controlUrl)}/healthz >/dev/null`, 'Verify DNS/firewall/TLS for the control URL from the node.']);
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
    runLocal('docker', ['build', '-t', imageTag, '.']);
    await saveImageArchive(imageTag, archive);
    runLocal('scp', ['--', archive, `${target}:${remote}`]);
    runLocal('ssh', ['--', target, `set -eu\ntrap ${sh(`rm -f ${sh(remote)}`)} EXIT\ndocker load --input ${sh(remote)}`]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function dockerBootstrap(): Promise<string> { return fs.readFile(path.join(templatesDir, 'install-docker.sh'), 'utf8'); }
async function bootstrapDocker(target: string): Promise<void> { runLocal('ssh', ['--', target, `sh -eu -c ${sh(await dockerBootstrap())}`]); }
async function waitForDeployment(deploymentId: string, timeoutSeconds = 300): Promise<DeploymentRecord> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const deployment = await request<DeploymentRecord>('GET', `/api/v1/deployments/${encodeURIComponent(deploymentId)}`);
    if ((TERMINAL_DEPLOYMENT_STATES as readonly string[]).includes(deployment.state)) {
      if (deployment.state !== 'succeeded') throw new Error(`deployment ${deploymentId} ${deployment.state}${deployment.error_message ? `: ${deployment.error_message}` : ''}`);
      return deployment;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for deployment ${deploymentId}`);
}

program.command('init').option('--token <token>', 'operator token (prefer TUG_TOKEN to avoid process-list exposure)').action(async (o: { token?: string }) => {
  const cfg = await loadCfg();
  const operatorToken = o.token || cfg.operatorToken || token('tug_op');
  await saveCfg({ controlUrl: cfg.controlUrl, operatorToken, project: cfg.project });
  console.log(`wrote ${cfgPath()}`);
});

program.command('node-register <name>').description('register a node with the control plane').option('--address <addr>').option('--public-address <addr>').action(async (name: string, o: { address?: string; publicAddress?: string }) => {
  const r = await request('POST', '/api/v1/nodes/register', { name, address: o.address, publicAddress: o.publicAddress });
  console.log(JSON.stringify(r, null, 2));
});
program.command('node-rotate-registry-token <name>').description('issue a new registry pull token for a node, invalidating the old one').action(async (name: string) => {
  console.log(JSON.stringify(await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/rotate-registry-token`, {}), null, 2));
});
program.command('node-rotate-wg-key <name>').description('generate a new WireGuard keypair on the node; peers pick up the new public key on their next poll').option('--timeout <seconds>', 'wait timeout', '60').action(async (name: string, o: { timeout: string }) => {
  const created = await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/rotate-wg-key`, {});
  const cmd = await waitForCommand(created.commandId, Number(o.timeout));
  if (cmd.state === 'failed') throw new Error(JSON.parse(cmd.result_json || '{}').error || 'key rotation failed');
  console.log(JSON.stringify({ ok: true, node: name, ...JSON.parse(cmd.result_json || '{}') }, null, 2));
});
program.command('node-ingress <name>').description('mark a node as an ingress node (managed Caddy on ports 80/443), or remove the role with --disable').option('--disable', 'stop acting as an ingress node').action(async (name: string, o: { disable?: boolean }) => {
  console.log(JSON.stringify(await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/ingress`, { enabled: !o.disable }), null, 2));
});
program.command('node-revoke-registry-token <name>').description('revoke a node\'s registry pull token, blocking future pulls until rotated').action(async (name: string) => {
  console.log(JSON.stringify(await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/revoke-registry-token`, {}), null, 2));
});

program.command('control-token').description('print local dev operator token if available').action(async()=> console.log((await fs.readFile('./data/operator.token','utf8')).trim()));

program.command('control-install <sshTarget>')
  .description('install the control plane on a Docker-capable host over SSH; front it with your own reverse proxy/TLS if exposing it publicly')
  .option('--image <tag>', 'Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI\'s version>)')
  .option('--install-docker', 'install missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts (root required)')
  .option('--build-local-image', 'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development')
  .option('--token <token>', 'operator token')
  .option('--port <port>', 'published API port', '8080')
  .option('--registry <host>', 'registry host used in desired images; bring your own registry, Tug does not provision one')
  .option('--registry-auth-path <path>', 'container path to an htpasswd file tug-control should manage credentials in, if your registry uses one')
  .option('--registry-container <name>', 'docker container name to restart when a node\'s registry credentials change, if your registry uses an htpasswd file')
  .action(async (sshTarget: string, o: InstallOpts & { token?: string; port: string; registry?: string; registryAuthPath?: string; registryContainer?: string }) => {
    const operatorToken = o.token || process.env.TUG_TOKEN || token('tug_op');
    if (o.installDocker) await bootstrapDocker(sshTarget);
    preflightRemote(sshTarget, { ports: [Number(o.port)], minDiskMb: 2048 });
    const image = resolveImage(o.image, o.buildLocalImage);
    if (o.buildLocalImage) await transferTugImage(sshTarget, image);
    const registryHost = o.registry || '';
    const yamlValue = (value: string) => JSON.stringify(value);
    const compose = await loadTemplate(templatesDir, 'control-compose.yml', {
      IMAGE: yamlValue(image), OPERATOR_TOKEN: yamlValue(operatorToken), REGISTRY_HOST: yamlValue(registryHost), PORT: o.port,
      REGISTRY_AUTH_PATH: yamlValue(o.registryAuthPath || ''),
      REGISTRY_CONTAINER: yamlValue(o.registryContainer || '')
    });
    const remote = await loadTemplate(templatesDir, 'control-install.sh', {
      COMPOSE: compose, OPERATOR_TOKEN_SH: sh(operatorToken)
    });
    runLocal('ssh', ['--', sshTarget, remote]);
    console.log(JSON.stringify({ ok: true, sshTarget, operatorToken, url: `http://${remoteHost(sshTarget)}:${o.port}`, registry: registryHost }, null, 2));
  });

program.command('node-install <sshTarget>')
  .description('register and install an agent container on a Docker-capable host over SSH')
  .requiredOption('--name <name>')
  .option('--address <addr>')
  .option('--public-address <addr>')
  .option('--agent-control-url <url>', 'control URL reachable by the agent (default: resolved operator control URL)')
  .option('--registry <host>', 'registry host for docker login')
  .option('--http-only-dev', 'allow plaintext HTTP control URL for local/private development')
  .option('--mesh', 'join the WireGuard mesh (agent runs with host networking and NET_ADMIN; control needs TUG_MESH=true)')
  .option('--wg-port <port>', 'WireGuard UDP port checked by preflight', '51820')
  .option('--image <tag>', 'Tug image to run (default: ghcr.io/wpelevator/tug:<this CLI\'s version>)')
  .option('--install-docker', 'install missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts (root required)')
  .option('--build-local-image', 'build the image from the current checkout and copy it to the host over SSH (tags it tug:local unless --image is set); for development')
  .action(async (sshTarget: string, o: InstallOpts & { name: string; address?: string; publicAddress?: string; agentControlUrl?: string; registry?: string; httpOnlyDev?: boolean; mesh?: boolean; wgPort: string }) => {
    const cfg = await loadCfg();
    const controlUrl = normalizeControlUrl(o.agentControlUrl ?? cfg.controlUrl!);
    assertHttps(controlUrl, o.httpOnlyDev);
    if (o.installDocker) await bootstrapDocker(sshTarget);
    preflightRemote(sshTarget, { controlUrl, mesh: o.mesh, udpPorts: o.mesh ? [Number(o.wgPort)] : [] });
    const registered = await request<RegisterResponse>('POST', '/api/v1/nodes/register', { name: o.name, address: o.address, publicAddress: o.publicAddress });
    const image = resolveImage(o.image, o.buildLocalImage);
    if (o.buildLocalImage) await transferTugImage(sshTarget, image);
    const env = await loadTemplate(templatesDir, 'agent.env', {
      CONTROL_URL: controlUrl, NODE_NAME: o.name, AGENT_TOKEN: registered.agentToken
    }) + (o.mesh ? 'TUG_MESH=true\n' : '');
    const dockerLogin = o.registry ? `printf %s ${sh(registered.registryToken)} | docker login ${sh(o.registry)} --username ${sh(o.name)} --password-stdin` : 'true';
    const remote = await loadTemplate(templatesDir, 'node-install.sh', {
      ENV: env, DOCKER_LOGIN: dockerLogin, IMAGE_SH: sh(image), RUN_FLAGS: o.mesh ? `${MESH_RUN_FLAGS} ` : ''
    });
    runLocal('ssh', ['--', sshTarget, remote]);
    console.log(JSON.stringify({ ok: true, node: registered.node, registryToken: registered.registryToken }, null, 2));
  });

program.command('node-enroll')
  .description('mint a single-use enrollment key so a fresh host can self-join with one docker run (no SSH)')
  .option('--name <name>', 'pre-bind the node name (default: the agent uses its own hostname)')
  .option('--agent-control-url <url>', 'control URL reachable by the agent (default: resolved operator control URL)')
  .option('--ttl <seconds>', 'enrollment key lifetime', '3600')
  .option('--uses <n>', 'how many hosts may enroll with this key', '1')
  .option('--ca <file>', 'PEM CA cert to embed so agents trust a private/self-signed control')
  .option('--http-only-dev', 'allow a plaintext HTTP control URL for local/private development')
  .option('--image <tag>', 'agent image used in the printed docker run (default: ghcr.io/wpelevator/tug:<this CLI\'s version>)')
  .option('--mesh', 'print a docker run that joins the WireGuard mesh (host networking, NET_ADMIN)')
  .option('--install-docker', 'print cloud-init that installs Docker and starts the agent')
  .option('--json', 'print JSON including the command or cloud-init payload')
  .action(async (o: { name?: string; agentControlUrl?: string; ttl: string; uses: string; ca?: string; httpOnlyDev?: boolean; image?: string; mesh?: boolean; json?: boolean; installDocker?: boolean }) => {
    const cfg = await loadCfg();
    const controlUrl = normalizeControlUrl(o.agentControlUrl ?? cfg.controlUrl!);
    assertHttps(controlUrl, o.httpOnlyDev);
    const ca = o.ca ? await fs.readFile(o.ca, 'utf8') : undefined;
    const minted = await request<EnrollTokenResponse>('POST', '/api/v1/nodes/enroll-token', { name: o.name || null, ttlSeconds: Number(o.ttl), uses: Number(o.uses) });
    const keyPayload: JoinKey = { v: 1, controlUrl, enrollToken: minted.enrollToken };
    if (ca) keyPayload.ca = ca;
    const joinKey = Buffer.from(JSON.stringify(keyPayload)).toString('base64url');
    const command = dockerRunSnippet(resolveImage(o.image), joinKey, o.mesh);
    const cloudInit = o.installDocker ? enrollmentCloudInit(await dockerBootstrap(), command) : undefined;
    if (o.json) { console.log(JSON.stringify({ ...minted, controlUrl, joinKey, command, ...(cloudInit ? { cloudInit } : {}) }, null, 2)); return; }
    if (cloudInit) { process.stdout.write(cloudInit); return; }
    console.log(`# Enrollment key valid until ${minted.expiresAt} (${minted.usesRemaining} use(s)). Run on each fresh host:\n`);
    console.log(command);
  });

program.command('secret-set <name>').option('--value <value>').action(async (name: string, o: CommonOpts & { value?: string }) => {
  const value = o.value ?? await new Promise<string>(resolve => { process.stdout.write(`${name}: `); process.stdin.once('data', d => resolve(String(d).trim())); });
  console.log(await request('POST', '/api/v1/secrets', { project: o.project || (await loadCfg()).project || 'site', name, value }));
});
program.command('secret-list').action(async (o: CommonOpts) => console.log(JSON.stringify(await request('GET', `/api/v1/secrets?project=${encodeURIComponent(o.project || (await loadCfg()).project || 'site')}`), null, 2)));
program.command('secret-remove <name>').action(async (name: string, o: CommonOpts) => console.log(await request('DELETE', `/api/v1/secrets/${encodeURIComponent(name)}?project=${encodeURIComponent(o.project || (await loadCfg()).project || 'site')}`)));

async function makeContext(): Promise<string> {
  const tmp = path.join(os.tmpdir(), `tug-${Date.now()}.tgz`);
  try { await createSourceArchive(process.cwd(), tmp, [cfgPath()]); }
  catch (error) { await fs.rm(tmp, { force: true }); throw error; }
  return tmp;
}
program.command('deploy').option('-f, --file <file>', 'compose file', 'docker-compose.yml').option('--version <version>', 'display version (default: git-<Compose hash>)').option('--build-local', 'build application images locally and upload them without source').option('--no-build-upload', 'deploy published images without uploading source; conflicts with --build-local').option('--no-wait', 'return after desired state is created').option('--timeout <seconds>', 'wait timeout in seconds', '300').action(async (o: CommonOpts & WaitOpts & { file: string; version?: string; buildUpload: boolean; buildLocal?: boolean }) => {
  const cfg = await loadCfg(); const compose = await readCompose(o.file); const project = o.project || cfg.project || 'site'; const version = o.version || `git-${composeHash(compose)}`;
  let response: DeployResponse;
  if (o.buildLocal) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-local-build-'));
    try {
      const form = new FormData();
      const localImages = await prepareLocalImages(compose, process.cwd(), directory);
      for (const { field } of localImages) form.append(field, await openAsBlob(path.join(directory, `${field}.tar.gz`)), `${field}.tar.gz`);
      form.append('payload', JSON.stringify({ project, version, compose, localImages }));
      response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  } else if (o.buildUpload && Object.values(compose.services).some(service => service.build)) {
    const tarball = await makeContext();
    try {
      const form = new FormData(); form.append('payload', JSON.stringify({ project, version, compose }));
      form.append('context', await openAsBlob(tarball), 'context.tgz');
      response = await request<DeployResponse>('POST', '/api/v1/deployments', form, true);
    } finally { await fs.rm(tarball, { force: true }); }
  } else response = await request<DeployResponse>('POST', '/api/v1/deployments', { project, version, compose });
  if (o.wait) response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
  console.log(JSON.stringify(response, null, 2));
});
program.command('status').action(async () => console.log(JSON.stringify(await request('GET', '/api/v1/status'), null, 2)));
program.command('events').option('--limit <n>', 'number of events', '100').action(async (o: CommonOpts & { limit: string }) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project;
  const query = `limit=${encodeURIComponent(o.limit)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
  console.log(JSON.stringify(await request('GET', `/api/v1/events?${query}`), null, 2));
});
program.command('doctor').description('run local and control-plane diagnostics').option('--nodes', 'also queue diagnostics on registered agents').option('--node <name>', 'specific node for agent diagnostics').action(async (o: { nodes?: boolean; node?: string }) => {
  const local: { name: string; ok: boolean; output?: string; error?: string }[] = [];
  for (const [name, cmd, args] of [['node', 'node', ['--version']], ['docker', 'docker', ['version', '--format', '{{.Server.Version}}']], ['docker_compose', 'docker', ['compose', 'version']]] as [string, string, string[]][]) {
    try { local.push({ name, ok: true, output: runCapture(cmd, args).trim() }); }
    catch (e) { local.push({ name, ok: false, error: errMessage(e) }); }
  }
  const controlDiagnostics = await request('GET', '/api/v1/diagnostics');
  const output: { ok: boolean; local: typeof local; control: unknown; nodeDiagnostics?: unknown } = { ok: local.every(c => c.ok) && controlDiagnostics.ok, local, control: controlDiagnostics };
  if (o.nodes || o.node) output.nodeDiagnostics = await request('POST', '/api/v1/diagnostics/nodes', { node: o.node || null });
  console.log(JSON.stringify(output, null, 2));
});
program.command('rollback').option('--force').option('--no-wait', 'return immediately after activating rollback').option('--timeout <seconds>', 'wait timeout', '300').action(async (o: CommonOpts & WaitOpts & { force?: boolean }) => {
  const cfg = await loadCfg();
  const response = await request<DeployResponse>('POST', '/api/v1/rollback', { project: o.project || cfg.project || 'site', force: Boolean(o.force) });
  if (o.wait) response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
  console.log(JSON.stringify(response, null, 2));
});
program.command('deploy-cancel <id>').action(async (id: string) => console.log(JSON.stringify(await request('POST', `/api/v1/deployments/${encodeURIComponent(id)}/cancel`, {}), null, 2)));
program.command('volume-list').action(async (o: CommonOpts) => {
  const cfg = await loadCfg();
  console.log(JSON.stringify(await request('GET', `/api/v1/volumes?project=${encodeURIComponent(o.project || cfg.project || 'site')}`), null, 2));
});
program.command('volume-remove <name>').option('--delete-data', 'delete underlying Docker volume data').action(async (name: string, o: CommonOpts & { deleteData?: boolean }) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project || 'site';
  console.log(JSON.stringify(await request('DELETE', `/api/v1/volumes/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}&deleteData=${Boolean(o.deleteData)}`), null, 2));
});
program.command('control-backup').description('create a control-plane SQLite/master-key backup').action(async () => console.log(JSON.stringify(await request('POST', '/api/v1/control/backups/run', {}), null, 2)));
program.command('control-restore <artifactRef>').description('restore a control-plane backup; requires control restart').option('--confirm').action(async (artifactRef: string, o: { confirm?: boolean }) => console.log(JSON.stringify(await request('POST', '/api/v1/control/restore', { artifactRef, confirm: Boolean(o.confirm) }), null, 2)));
async function waitForCommand(commandId: string, timeoutSeconds = 60): Promise<CommandRecord> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const cmd = await request<CommandRecord | null>('GET', `/api/v1/commands/${commandId}`);
    if (cmd?.state === 'succeeded' || cmd?.state === 'failed') return cmd;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for command ${commandId}`);
}
program.command('restart <service>').option('--timeout <seconds>', 'wait timeout', '60').action(async (svc: string, o: CommonOpts & { timeout: string }) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project || 'site';
  const created = await request('POST', '/api/v1/restart', { project, service: svc });
  const cmd = await waitForCommand(created.commandId, Number(o.timeout));
  if (cmd.state === 'failed') throw new Error(JSON.parse(cmd.result_json || '{}').error || 'restart failed');
  console.log(JSON.stringify(cmd, null, 2));
});
program.command('logs <service>').description('fetch logs from the assigned node agent').option('--tail <n>', 'number of lines', '200').action(async (svc: string, o: CommonOpts & { tail: string }) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project || 'site';
  const created = await request('POST', '/api/v1/logs', { project, service: svc, tail: Number(o.tail) });
  const cmd = await waitForCommand(created.commandId, 60);
  const result = JSON.parse(cmd.result_json || '{}');
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(result.error);
});

program.hook('preAction', async (_root, command) => {
  const options = command.opts();
  for (const [key, min, max] of [['port', 1, 65535], ['wgPort', 1, 65535], ['timeout', 1, 86400], ['ttl', 1, 31536000], ['uses', 1, 1000000], ['limit', 1, 500], ['tail', 1, 1000000]] as const) {
    if (options[key] !== undefined) integerOption(String(options[key]), '--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), min, max);
  }
  if (options.buildLocal && options.buildUpload === false) throw new Error('--build-local and --no-build-upload cannot be combined');
  if ((options.registryAuthPath || options.registryContainer) && !options.registry) throw new Error('--registry-auth-path and --registry-container require --registry');
  if (command.name() === 'control-restore' && !options.confirm) throw new Error('control-restore requires --confirm');
  for (const value of [...command.args, ...Object.values(options), ...Object.values(program.opts())]) if (typeof value === 'string' && /[\r\n\0]/.test(value)) throw new Error('arguments and option values must not contain line breaks or NUL');
  if (options.name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.name)) throw new Error('--name must contain only letters, numbers, dots, underscores or hyphens');
  resolvedConfig = await resolveCliConfig(command.optsWithGlobals(), process.env, process.cwd(), command.name() === 'init');
});
for (const command of program.commands) command
  .option('--config <file>', 'CLI JSON config file (default: TUG_CONFIG or .tug.json)')
  .option('--control-url <url>', 'control API URL (overrides TUG_CONTROL_URL and config)')
  .option('--project <name>', 'project (overrides TUG_PROJECT and config; default: site)');
for (const command of [program, ...program.commands]) command.allowExcessArguments(false);
program.showHelpAfterError();
program.parseAsync().catch((e: unknown) => { console.error(`${errMessage(e)}\nRun tug <command> --help for usage.`); process.exit(1); });
