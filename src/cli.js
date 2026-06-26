#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { readCompose, composeHash } from './compose.js';
import { token } from './util.js';

const program = new Command();
program.name('launchpad').description('Portable VPS Launch Pad').version('0.1.0');
const cfgPath = () => process.env.LAUNCHPAD_CONFIG || path.join(process.cwd(), '.launchpad.json');
async function loadCfg() { try { return JSON.parse(await fs.readFile(cfgPath(), 'utf8')); } catch { return {}; } }
async function saveCfg(c) { await fs.writeFile(cfgPath(), JSON.stringify(c, null, 2)); }
async function request(method, route, body, multipart = false) {
  const c = await loadCfg(); const base = process.env.LAUNCHPAD_CONTROL_URL || c.controlUrl || 'http://localhost:8080'; const tok = process.env.LAUNCHPAD_TOKEN || c.operatorToken;
  const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
  if (!multipart) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, { method, headers, body: multipart ? body : body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.json();
}
function sh(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function runLocal(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}
function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stderr || ''}`);
  return result.stdout;
}
function remoteHost(sshTarget) { return sshTarget.replace(/^[^@]+@/, '').split(':')[0]; }
function assertHttps(url, allowHttp) {
  if (!allowHttp && !String(url).startsWith('https://')) throw new Error(`${url} must use https:// outside local development (pass --http-only-dev to override)`);
}
function preflightRemote(target, { controlUrl } = {}) {
  const checks = [
    ['docker.version', 'docker version >/dev/null', 'Install Docker Engine and ensure the SSH user can access it.'],
    ['docker.compose.version', 'docker compose version >/dev/null', 'Install Docker Compose v2.'],
    ['paths', 'mkdir -p /opt/launchpad-preflight /var/lib/launchpad-preflight /etc/launchpad && test -w /opt/launchpad-preflight && test -w /var/lib/launchpad-preflight && test -w /etc/launchpad', 'Ensure /opt, /var/lib, and /etc/launchpad are writable by the installer.']
  ];
  if (controlUrl) checks.push(['control.reachable', `curl -fsS ${sh(controlUrl)}/healthz >/dev/null`, 'Verify DNS/firewall/TLS for the control URL from the node.']);
  const script = `set -e
${checks.map(([name, cmd, fix]) => `echo "preflight: ${name}"; (${cmd}) || { echo "FAILED ${name}: ${fix}" >&2; exit 20; }`).join('\n')}
`;
  runLocal('ssh', [target, script]);
}
async function transferLaunchpadImage(target, imageTag) {
  const archive = path.join(os.tmpdir(), `launchpad-image-${Date.now()}.tar.gz`);
  runLocal('docker', ['build', '-t', imageTag, '.']);
  runLocal('bash', ['-lc', `docker save ${sh(imageTag)} | gzip > ${sh(archive)}`]);
  runLocal('scp', [archive, `${target}:/tmp/launchpad-image.tar.gz`]);
  runLocal('ssh', [target, 'gzip -dc /tmp/launchpad-image.tar.gz | docker load && rm -f /tmp/launchpad-image.tar.gz']);
  await fs.rm(archive, { force: true });
}
async function waitForDeployment(deploymentId, timeoutSeconds = 300) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const deployment = await request('GET', `/api/v1/deployments/${encodeURIComponent(deploymentId)}`);
    if (['succeeded', 'failed', 'build_failed', 'cancelled'].includes(deployment.state)) {
      if (deployment.state !== 'succeeded') throw new Error(`deployment ${deploymentId} ${deployment.state}${deployment.error_message ? `: ${deployment.error_message}` : ''}`);
      return deployment;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for deployment ${deploymentId}`);
}

program.command('init').option('--control-url <url>', 'control API URL', 'http://localhost:8080').option('--token <token>', 'operator token').option('--project <name>', 'project name', 'site').action(async (o) => {
  const operatorToken = o.token || process.env.LAUNCHPAD_TOKEN || token('lpo');
  await saveCfg({ controlUrl: o.controlUrl, operatorToken, project: o.project });
  console.log(`wrote ${cfgPath()}`);
});

program.command('node:register').description('register a node with the control plane').requiredOption('--name <name>').option('--address <addr>').option('--public-address <addr>').action(async (o) => {
  const r = await request('POST', '/api/v1/nodes/register', { name: o.name, address: o.address, publicAddress: o.publicAddress });
  console.log(JSON.stringify(r, null, 2));
});
program.command('node:rotate-registry-token <name>').description('issue a new registry pull token for a node, invalidating the old one').action(async (name) => {
  console.log(JSON.stringify(await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/rotate-registry-token`, {}), null, 2));
});
program.command('node:revoke-registry-token <name>').description('revoke a node\'s registry pull token, blocking future pulls until rotated').action(async (name) => {
  console.log(JSON.stringify(await request('POST', `/api/v1/nodes/${encodeURIComponent(name)}/revoke-registry-token`, {}), null, 2));
});

program.command('control:token').description('print local dev operator token if available').action(async()=> console.log((await fs.readFile('./data/operator.token','utf8')).trim()));

const control = program.command('control');
control.command('install <sshTarget>')
  .description('install the control plane on a Docker-capable host over SSH')
  .option('--image <tag>', 'local/remote image tag', 'launchpad:local')
  .option('--token <token>', 'operator token')
  .option('--port <port>', 'published API port for --http-only-dev', '8080')
  .option('--registry <host>', 'registry host used in desired images')
  .option('--domain <domain>', 'production control-plane HTTPS domain')
  .option('--registry-domain <domain>', 'production registry HTTPS domain')
  .option('--email <email>', 'ACME email for Caddy')
  .option('--http-only-dev', 'allow plaintext HTTP install for local/private development')
  .option('--no-transfer-image', 'skip docker build/save/scp/load')
  .action(async (sshTarget, o) => {
    const operatorToken = o.token || process.env.LAUNCHPAD_TOKEN || token('lpo');
    preflightRemote(sshTarget);
    if (!o.httpOnlyDev && (!o.domain || !o.registryDomain || !o.email)) throw new Error('production install requires --domain, --registry-domain, and --email (or pass --http-only-dev)');
    if (o.transferImage) await transferLaunchpadImage(sshTarget, o.image);
    const registryHost = o.registry || o.registryDomain || 'localhost:5000';
    const compose = o.httpOnlyDev ? `services:\n  registry:\n    image: registry:3.1.1\n    restart: unless-stopped\n    ports:\n      - \"5000:5000\"\n    volumes:\n      - /var/lib/launchpad-registry:/var/lib/registry\n  control:\n    image: ${o.image}\n    restart: unless-stopped\n    command: node src/control.js\n    environment:\n      PORT: 8080\n      LAUNCHPAD_DB: /data/launchpad.db\n      LAUNCHPAD_MASTER_KEY_FILE: /data/master.key\n      LAUNCHPAD_OPERATOR_TOKEN: ${operatorToken}\n      LAUNCHPAD_REGISTRY: ${registryHost}\n    ports:\n      - \"${o.port}:8080\"\n    volumes:\n      - /var/lib/launchpad-control:/data\n      - /var/run/docker.sock:/var/run/docker.sock\n` : `services:\n  caddy:\n    image: caddy:2-alpine\n    restart: unless-stopped\n    ports:\n      - \"80:80\"\n      - \"443:443\"\n    volumes:\n      - /opt/launchpad-control/Caddyfile:/etc/caddy/Caddyfile:ro\n      - /var/lib/launchpad-caddy/data:/data\n      - /var/lib/launchpad-caddy/config:/config\n    depends_on: [control, registry]\n  registry:\n    image: registry:3.1.1\n    restart: unless-stopped\n    volumes:\n      - /var/lib/launchpad-registry:/var/lib/registry\n  control:\n    image: ${o.image}\n    restart: unless-stopped\n    command: node src/control.js\n    environment:\n      PORT: 8080\n      LAUNCHPAD_DB: /data/launchpad.db\n      LAUNCHPAD_MASTER_KEY_FILE: /data/master.key\n      LAUNCHPAD_OPERATOR_TOKEN: ${operatorToken}\n      LAUNCHPAD_REGISTRY: ${registryHost}\n    volumes:\n      - /var/lib/launchpad-control:/data\n      - /var/run/docker.sock:/var/run/docker.sock\n`;
    const caddyfile = o.httpOnlyDev ? '' : `{\n\temail ${o.email}\n}\n${o.domain} {\n\treverse_proxy control:8080\n}\n${o.registryDomain} {\n\treverse_proxy registry:5000\n}\n`;
    const remote = `set -euo pipefail
mkdir -p /opt/launchpad-control /var/lib/launchpad-control /var/lib/launchpad-registry /var/lib/launchpad-caddy/data /var/lib/launchpad-caddy/config
cat > /opt/launchpad-control/docker-compose.yml <<'YAML'
${compose}YAML
cat > /opt/launchpad-control/Caddyfile <<'CADDY'
${caddyfile}CADDY
docker compose -f /opt/launchpad-control/docker-compose.yml up -d
install -m 0600 /dev/null /var/lib/launchpad-control/operator.token
printf %s ${sh(operatorToken)} > /var/lib/launchpad-control/operator.token
`;
    runLocal('ssh', [sshTarget, remote]);
    console.log(JSON.stringify({ ok: true, sshTarget, operatorToken, url: o.httpOnlyDev ? `http://${remoteHost(sshTarget)}:${o.port}` : `https://${o.domain}`, registry: registryHost, tls: !o.httpOnlyDev }, null, 2));
  });

const node = program.command('node');
node.command('install <sshTarget>')
  .description('register and install an agent container on a Docker-capable host over SSH')
  .requiredOption('--name <name>')
  .option('--address <addr>')
  .option('--public-address <addr>')
  .option('--control-url <url>', 'URL agents use to reach control')
  .option('--registry <host>', 'registry host for docker login')
  .option('--http-only-dev', 'allow plaintext HTTP control URL for local/private development')
  .option('--image <tag>', 'local/remote image tag', 'launchpad:local')
  .option('--no-transfer-image', 'skip docker build/save/scp/load')
  .action(async (sshTarget, o) => {
    const cfg = await loadCfg();
    const controlUrl = o.controlUrl || cfg.controlUrl || process.env.LAUNCHPAD_CONTROL_URL || 'http://localhost:8080';
    assertHttps(controlUrl, o.httpOnlyDev);
    preflightRemote(sshTarget, { controlUrl });
    const registered = await request('POST', '/api/v1/nodes/register', { name: o.name, address: o.address, publicAddress: o.publicAddress });
    if (o.transferImage) await transferLaunchpadImage(sshTarget, o.image);
    const env = `LAUNCHPAD_CONTROL_URL=${controlUrl}\nLAUNCHPAD_NODE_NAME=${o.name}\nLAUNCHPAD_AGENT_TOKEN=${registered.agentToken}\nLAUNCHPAD_STATE_DIR=/var/lib/launchpad\nLAUNCHPAD_APPLY=true\nLAUNCHPAD_POLL_INTERVAL_MS=5000\n`;
    const remote = `set -euo pipefail
mkdir -p /etc/launchpad /var/lib/launchpad
cat > /etc/launchpad/agent.env <<'ENV'
${env}ENV
chmod 0600 /etc/launchpad/agent.env
${o.registry ? `printf %s ${sh(registered.registryToken)} | docker login ${sh(o.registry)} --username ${sh(o.name)} --password-stdin` : 'true'}
docker rm -f launchpad-agent >/dev/null 2>&1 || true
docker run -d --name launchpad-agent --restart unless-stopped --env-file /etc/launchpad/agent.env -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/launchpad:/var/lib/launchpad ${sh(o.image)} node src/agent.js
`;
    runLocal('ssh', [sshTarget, remote]);
    console.log(JSON.stringify({ ok: true, node: registered.node, registryToken: registered.registryToken }, null, 2));
  });

program.command('secret:set <name>').option('--project <name>').option('--value <value>').action(async (name, o) => {
  const value = o.value ?? await new Promise(resolve => { process.stdout.write(`${name}: `); process.stdin.once('data', d => resolve(String(d).trim())); });
  console.log(await request('POST', '/api/v1/secrets', { project: o.project || (await loadCfg()).project || 'site', name, value }));
});
program.command('secret:list').option('--project <name>').action(async (o) => console.log(JSON.stringify(await request('GET', `/api/v1/secrets?project=${encodeURIComponent(o.project || (await loadCfg()).project || 'site')}`), null, 2)));
program.command('secret:rm <name>').option('--project <name>').action(async (name, o) => console.log(await request('DELETE', `/api/v1/secrets/${encodeURIComponent(name)}?project=${encodeURIComponent(o.project || (await loadCfg()).project || 'site')}`)));

async function makeContext() {
  const tmp = path.join(os.tmpdir(), `launchpad-${Date.now()}.tgz`);
  const ignores = new Set(['.git', 'node_modules', 'data', 'registry-data']);
  try { (await fs.readFile('.dockerignore','utf8')).split(/\r?\n/).map(l=>l.trim()).filter(Boolean).forEach(l=>ignores.add(l)); } catch {}
  await tar.c({ gzip: true, file: tmp, cwd: process.cwd(), filter: p => ![...ignores].some(i => p === i || p.startsWith(`${i}/`)) }, ['.']);
  return tmp;
}
program.command('deploy').option('-f, --file <file>', 'compose file', 'docker-compose.yml').option('--project <name>').option('--version <version>').option('--no-build-upload', 'do not upload source tarball/build context').option('--no-wait', 'return after desired state is created').option('--timeout <seconds>', 'wait timeout', '300').action(async (o) => {
  const cfg = await loadCfg(); const compose = await readCompose(o.file); const project = o.project || cfg.project || 'site'; const version = o.version || `git-${composeHash(compose)}`;
  let response;
  if (o.buildUpload) {
    const form = new FormData(); form.append('payload', JSON.stringify({ project, version, compose }));
    const tarball = await makeContext(); form.append('context', new Blob([await fs.readFile(tarball)]), 'context.tgz');
    response = await request('POST', '/api/v1/deployments', form, true); await fs.rm(tarball, { force: true });
  } else response = await request('POST', '/api/v1/deployments', { project, version, compose });
  if (o.wait) response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
  console.log(JSON.stringify(response, null, 2));
});
program.command('status').action(async () => console.log(JSON.stringify(await request('GET', '/api/v1/status'), null, 2)));
program.command('events').option('--project <name>').option('--limit <n>', 'number of events', '100').action(async (o) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project;
  const query = `limit=${encodeURIComponent(o.limit)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
  console.log(JSON.stringify(await request('GET', `/api/v1/events?${query}`), null, 2));
});
program.command('doctor').description('run local and control-plane diagnostics').option('--nodes', 'also queue diagnostics on registered agents').option('--node <name>', 'specific node for agent diagnostics').action(async (o) => {
  const local = [];
  for (const [name, cmd, args] of [['node', 'node', ['--version']], ['docker', 'docker', ['version', '--format', '{{.Server.Version}}']], ['docker_compose', 'docker', ['compose', 'version']]]) {
    try { local.push({ name, ok: true, output: runCapture(cmd, args).trim() }); }
    catch (e) { local.push({ name, ok: false, error: e.message }); }
  }
  const controlDiagnostics = await request('GET', '/api/v1/diagnostics');
  const output = { ok: local.every(c => c.ok) && controlDiagnostics.ok, local, control: controlDiagnostics };
  if (o.nodes || o.node) output.nodeDiagnostics = await request('POST', '/api/v1/diagnostics/nodes', { node: o.node || null });
  console.log(JSON.stringify(output, null, 2));
});
program.command('rollback').option('--project <name>').option('--force').option('--no-wait', 'return immediately after activating rollback').option('--timeout <seconds>', 'wait timeout', '300').action(async (o) => {
  const cfg = await loadCfg();
  const response = await request('POST', '/api/v1/rollback', { project: o.project || cfg.project || 'site', force: Boolean(o.force) });
  if (o.wait) response.deployment = await waitForDeployment(response.deployment.id, Number(o.timeout));
  console.log(JSON.stringify(response, null, 2));
});
program.command('deploy:cancel <id>').action(async (id) => console.log(JSON.stringify(await request('POST', `/api/v1/deployments/${encodeURIComponent(id)}/cancel`, {}), null, 2)));
program.command('volume:list').option('--project <name>').action(async (o) => {
  const cfg = await loadCfg();
  console.log(JSON.stringify(await request('GET', `/api/v1/volumes?project=${encodeURIComponent(o.project || cfg.project || 'site')}`), null, 2));
});
program.command('volume:rm <name>').option('--project <name>').option('--delete-data', 'delete underlying Docker volume data').action(async (name, o) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project || 'site';
  console.log(JSON.stringify(await request('DELETE', `/api/v1/volumes/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}&deleteData=${Boolean(o.deleteData)}`), null, 2));
});
const backup = program.command('backup');
backup.command('run <target>').option('--project <name>').action(async (target, o) => {
  const cfg = await loadCfg();
  console.log(JSON.stringify(await request('POST', '/api/v1/backups/run', { project: o.project || cfg.project || 'site', target }), null, 2));
});
backup.command('list').option('--project <name>').action(async (o) => {
  const cfg = await loadCfg();
  console.log(JSON.stringify(await request('GET', `/api/v1/backups?project=${encodeURIComponent(o.project || cfg.project || 'site')}`), null, 2));
});
program.command('restore <target>').option('--project <name>').option('--from <backup>', 'backup id or latest', 'latest').action(async (target, o) => {
  const cfg = await loadCfg();
  console.log(JSON.stringify(await request('POST', '/api/v1/restore', { project: o.project || cfg.project || 'site', target, from: o.from }), null, 2));
});
const controlBackup = program.command('control-backup');
controlBackup.command('run').description('create a control-plane SQLite/master-key backup').action(async () => console.log(JSON.stringify(await request('POST', '/api/v1/control/backups/run', {}), null, 2)));
controlBackup.command('restore <artifactRef>').description('restore a control-plane backup; requires control restart').option('--confirm').action(async (artifactRef, o) => console.log(JSON.stringify(await request('POST', '/api/v1/control/restore', { artifactRef, confirm: Boolean(o.confirm) }), null, 2)));
async function waitForCommand(commandId, timeoutSeconds = 60) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const cmd = await request('GET', `/api/v1/commands/${commandId}`);
    if (cmd?.state === 'succeeded' || cmd?.state === 'failed') return cmd;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for command ${commandId}`);
}
program.command('restart <service>').option('--project <name>').option('--timeout <seconds>', 'wait timeout', '60').action(async (svc, o) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project || 'site';
  const created = await request('POST', '/api/v1/restart', { project, service: svc });
  const cmd = await waitForCommand(created.commandId, Number(o.timeout));
  if (cmd.state === 'failed') throw new Error(JSON.parse(cmd.result_json || '{}').error || 'restart failed');
  console.log(JSON.stringify(cmd, null, 2));
});
program.command('logs <service>').description('fetch logs from the assigned node agent').option('--project <name>').option('--tail <n>', 'number of lines', '200').action(async (svc, o) => {
  const cfg = await loadCfg(); const project = o.project || cfg.project || 'site';
  const created = await request('POST', '/api/v1/logs', { project, service: svc, tail: Number(o.tail) });
  const cmd = await waitForCommand(created.commandId, 60);
  const result = JSON.parse(cmd.result_json || '{}');
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(result.error);
});

program.parseAsync().catch(e => { console.error(e.message); process.exit(1); });
