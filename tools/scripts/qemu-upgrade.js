#!/usr/bin/env node
// End-to-end upgrade rehearsal on a real VM, locally, with QEMU: install control and a node with a published release
// (state in host directories, control run by Docker Compose), then upgrade the same host with this checkout:
// `tug control migrate`, `tug node migrate`, `tug control setup` (control started with `docker run`, with the Compose
// plugin removed from the guest) and a deploy that reads the Compose file natively.
//
//   node tools/scripts/qemu-upgrade.js --image <arm64 cloud image> [--work <dir>] [--legacy 1.2.0] [--keep]
//
// Requirements are those of qemu-first-boot.js (macOS on Apple Silicon, Homebrew qemu and xorriso, an arm64 cloud
// image with cloud-init), plus Docker on this machine (the local image build and the legacy deploy use it), and
// outbound internet for the guest (Docker packages, ghcr.io, Docker Hub) and for this machine (npm).
// The guest is reached through an `ssh` shim on PATH (key, port and host-key options), so the CLI runs unmodified.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const image = opt('image');
if (!image) {
  console.error(
    'usage: qemu-upgrade.js --image <arm64 cloud image> [--work dir] [--legacy 1.2.0] [--keep]',
  );
  process.exit(2);
}
const legacyVersion = opt('legacy', '1.2.0');
const work = path.resolve(opt('work', path.join(repo, '.qemu-work')));
const sshPort = Number(opt('ssh-port', '2222'));
const apiPort = Number(opt('api-port', '18443'));
const nodeName = 'app1';
// Clients reach control through the forwarded port; the agent runs in the guest and dials its own loopback.
const clientUrl = `https://127.0.0.1:${apiPort}`;
const agentUrl = 'https://127.0.0.1:8443';
const target = 'root@127.0.0.1';
const start = Date.now();
const log = (m) => console.log(`[${((Date.now() - start) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const children = [];
const checks = [];

function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
process.on('exit', cleanup);
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
])
  process.on(signal, () => process.exit(code));

function check(ok, message) {
  checks.push({ ok, message });
  log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) throw new Error(`check failed: ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, probe, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

fs.mkdirSync(work, { recursive: true, mode: 0o700 });
fs.chmodSync(work, 0o700);
const keyPath = path.join(work, 'id_ed25519');
if (!fs.existsSync(keyPath))
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'inherit' });

// The shims make `ssh root@127.0.0.1` and `scp` reach the guest without touching ~/.ssh.
const bin = path.join(work, 'bin');
fs.mkdirSync(bin, { recursive: true });
const sshOptions = `-i '${keyPath}' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o ServerAliveInterval=15`;
fs.writeFileSync(
  path.join(bin, 'ssh'),
  `#!/bin/sh\nexec /usr/bin/ssh -p ${sshPort} ${sshOptions} "$@"\n`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(bin, 'scp'),
  `#!/bin/sh\nexec /usr/bin/scp -P ${sshPort} ${sshOptions} "$@"\n`,
  { mode: 0o755 },
);

const env = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  TUG_CONFIG: path.join(work, 'tug-config.json'),
  TUG_CREDENTIAL_FILE: '',
  CI: '1',
};
delete env.TUG_CONTROL_URL;
fs.rmSync(env.TUG_CONFIG, { force: true });

/** Runs a command; `fail: true` expects a non-zero exit and returns the result either way. */
function run(command, args, { cwd = work, fail, input, quiet } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!quiet) {
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .trim()
      .split('\n')
      .slice(-6)
      .join('\n');
    if (out) console.log(out.replace(/^/gm, '    | '));
  }
  if (fail === undefined && result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
  return result;
}
const legacy = (args, options) =>
  run('npx', ['-y', `@wpelevator/tug@${legacyVersion}`, ...args], options);
const current = (args, options) => run('node', [path.join(repo, 'src/cli.ts'), ...args], options);
const guest = (script, options = {}) =>
  run('ssh', ['--', target, script], { quiet: true, ...options });
const guestOut = (script) => guest(script).stdout.trim();

// 1. Boot a fresh VM with root SSH.
const meta = `instance-id: tug-${randomBytes(4).toString('hex')}\nlocal-hostname: upgrade\n`;
const userData = `#cloud-config\ndisable_root: false\nssh_pwauth: false\nssh_authorized_keys:\n  - ${fs.readFileSync(`${keyPath}.pub`, 'utf8').trim()}\n`;
fs.writeFileSync(path.join(work, 'user-data'), userData, { mode: 0o600 });
fs.writeFileSync(path.join(work, 'meta-data'), meta);
const seed = path.join(work, 'seed.iso');
fs.rmSync(seed, { force: true });
run('xorriso', [
  '-as',
  'mkisofs',
  '-quiet',
  '-output',
  seed,
  '-volid',
  'cidata',
  '-joliet',
  '-rock',
  path.join(work, 'user-data'),
  path.join(work, 'meta-data'),
]);
const disk = path.join(work, 'disk.qcow2');
fs.rmSync(disk, { force: true });
run('qemu-img', [
  'create',
  '-q',
  '-f',
  'qcow2',
  '-F',
  'qcow2',
  '-b',
  path.resolve(image),
  disk,
  '24G',
]);
const serial = path.join(work, 'serial.log');
fs.rmSync(serial, { force: true });
const vm = spawn(
  'qemu-system-aarch64',
  [
    '-machine',
    'virt,accel=hvf',
    '-cpu',
    'host',
    '-smp',
    '4',
    '-m',
    '4096',
    '-bios',
    '/opt/homebrew/share/qemu/edk2-aarch64-code.fd',
    '-drive',
    `file=${disk},if=virtio,format=qcow2`,
    '-drive',
    `file=${seed},if=virtio,format=raw,media=cdrom,readonly=on`,
    '-nic',
    `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${sshPort}-:22,hostfwd=tcp:127.0.0.1:${apiPort}-:8443`,
    '-display',
    'none',
    '-serial',
    `file:${serial}`,
    '-monitor',
    'none',
  ],
  { stdio: 'ignore' },
);
children.push(vm);
log('VM booting');
try {
  await waitFor(
    'root SSH',
    () => vm.exitCode === null && guest('true', { fail: false }).status === 0,
    300,
  );
  guest('cloud-init status --wait >/dev/null 2>&1 || true');
  log(`VM up: ${guestOut('. /etc/os-release; echo $PRETTY_NAME; uname -m')}`);

  // 2. The old release installs control and a node: host directories, Docker Compose, the published image.
  log(`--- legacy install with @wpelevator/tug@${legacyVersion}`);
  legacy(['control', 'setup', target, '--install-docker', '--control-url', clientUrl, '-y']);
  legacy([
    'node',
    'add',
    target,
    '--name',
    nodeName,
    '--agent-control-url',
    agentUrl,
    '--address',
    '127.0.0.1',
    '-y',
  ]);
  check(
    guest('test -d /var/lib/tug-control && test -s /var/lib/tug/agent.json', { fail: false })
      .status === 0,
    'the legacy install keeps control data and agent state in host directories',
  );
  check(
    guest('docker compose version', { fail: false }).status === 0,
    'the legacy install used the Docker Compose plugin',
  );
  const caBefore = guestOut('sha256sum /var/lib/tug-control/pki/ca.crt | cut -d" " -f1');
  const agentBefore = guestOut('sha256sum /var/lib/tug/agent.json | cut -d" " -f1');
  const nodeIdBefore = JSON.parse(legacy(['node', 'list', '--json'], { quiet: true }).stdout);
  const nodesOf = (v) => (Array.isArray(v) ? v : (v.nodes ?? []));
  check(
    nodesOf(nodeIdBefore).some((n) => n.name === nodeName),
    'control lists the node before the upgrade',
  );

  // 3. A project with data, a secret and a volume, deployed by the old CLI.
  const project = path.join(work, 'app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'compose.yaml'),
    `services:\n  web:\n    image: nginx:1.27-alpine\n    ports: ["8080:80"]\n    environment:\n      API_KEY: \${API_KEY}\n    volumes:\n      - site:/usr/share/nginx/html\n    x-tug:\n      placement:\n        nodes: [${nodeName}]\n      health:\n        type: tcp\n        port: 80\nvolumes:\n  site:\n`,
  );
  legacy(['secret', 'set', 'API_KEY', 'sekret-v1']);
  legacy(['deploy', '--timeout', '300'], { cwd: project });
  legacy([
    'exec',
    'web',
    '--node',
    nodeName,
    '--',
    'sh',
    '-c',
    'echo legacy-data > /usr/share/nginx/html/marker.txt',
  ]);
  check(
    guestOut('curl -fsS localhost:8080/marker.txt').includes('legacy-data'),
    'the legacy deployment serves its data through the published port',
  );

  // 4. The refusals: a legacy host is not installed over.
  log('--- upgrade with this checkout');
  const refused = current(['control', 'setup', target, '--control-url', clientUrl, '-y'], {
    fail: false,
  });
  check(
    refused.status !== 0 && /tug control migrate/.test(refused.stderr),
    'control setup refuses an unmigrated control host and names tug control migrate',
  );
  check(
    guestOut('docker ps --format "{{.Names}}" | grep -c tug-control-control-1') === '1',
    'the refused setup left the old control running',
  );

  // 5. Migrate control, then the node.
  current(['control', 'migrate', target]);
  check(
    guest('docker volume inspect tug-control', { fail: false }).status === 0,
    'control migrate created the tug-control volume',
  );
  check(
    guestOut(
      'docker inspect -f "{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}" tug-control-control-1',
    ).includes('tug-control:/data'),
    'control now mounts the volume at /data',
  );
  check(
    guestOut('docker exec tug-control-control-1 sha256sum /data/pki/ca.crt | cut -d" " -f1') ===
      caBefore,
    'the control CA survived the migration unchanged',
  );
  await waitFor(
    'control to answer the old credential',
    () => current(['node', 'list', '--json'], { fail: false, quiet: true }).status === 0,
    60,
  );
  current([
    'node',
    'migrate',
    nodeName,
    target,
    '--agent-control-url',
    agentUrl,
    '--build-local-image',
  ]);
  check(
    guestOut(
      'docker run --rm --entrypoint sha256sum -v tug-agent:/s tug:local /s/agent.json',
    ).split(' ')[0] === agentBefore,
    'the node key moved into the tug-agent volume unchanged',
  );
  await waitFor(
    'the node to report after migration',
    () => {
      const list = current(['node', 'list', '--json'], { fail: false, quiet: true });
      return (
        list.status === 0 &&
        nodesOf(JSON.parse(list.stdout)).some(
          (n) => n.name === nodeName && /online|connected|ok/i.test(JSON.stringify(n)),
        )
      );
    },
    120,
  );
  check(true, 'the migrated node reports to control with its old identity');

  // 6. Control setup on the migrated host with no Compose plugin: control starts with docker run.
  guest('apt-get remove -y docker-compose-plugin >/dev/null 2>&1');
  check(
    guest('docker compose version', { fail: false }).status !== 0,
    'the Compose plugin is removed from the guest',
  );
  current(['control', 'setup', target, '--build-local-image', '--control-url', clientUrl, '-y']);
  check(
    guestOut('docker inspect -f "{{.Config.Image}}" tug-control-control-1') === 'tug:local' ||
      /tug:local|tug@sha/.test(
        guestOut('docker inspect -f "{{.Config.Image}}" tug-control-control-1'),
      ),
    'control now runs the image built from this checkout',
  );
  check(
    guest('test ! -e /opt/tug-control/docker-compose.yml', { fail: false }).status === 0,
    'the old Compose file is gone',
  );
  check(
    guestOut(
      'docker inspect -f "{{index .Config.Labels \\"com.docker.compose.project\\"}}" tug-control-control-1',
    ) === '',
    'the control container is not a Compose container',
  );
  check(
    guestOut('docker exec tug-control-control-1 sha256sum /data/pki/ca.crt | cut -d" " -f1') ===
      caBefore,
    'control setup kept the CA on the volume',
  );
  await waitFor(
    'control after setup',
    () => current(['node', 'list', '--json'], { fail: false, quiet: true }).status === 0,
    60,
  );

  // 7. What was deployed before is intact, and a new deploy reads the file natively.
  check(
    guestOut('curl -fsS localhost:8080/marker.txt').includes('legacy-data'),
    'the service kept serving and its volume kept its data through the upgrade',
  );
  const secrets = current(['secret', 'list', '--json'], { quiet: true }).stdout;
  check(secrets.includes('API_KEY'), 'the secret survived the upgrade');
  fs.writeFileSync(path.join(project, '.env'), 'GREETING=hello-native\n');
  fs.writeFileSync(
    path.join(project, 'compose.yaml'),
    `services:\n  web:\n    image: nginx:1.27-alpine\n    ports: ["8080:80"]\n    environment:\n      API_KEY: \${API_KEY}\n      GREETING: \${GREETING:-none}\n    env_file: []\n    volumes:\n      - site:/usr/share/nginx/html\n    x-tug:\n      placement:\n        nodes: [${nodeName}]\n      health:\n        type: tcp\n        port: 80\nvolumes:\n  site:\n`,
  );
  current(['deploy', '--timeout', '300'], { cwd: project });
  const greeting = current(
    ['exec', 'web', '--node', nodeName, '--', 'sh', '-c', 'echo $GREETING:$API_KEY'],
    { quiet: true },
  ).stdout;
  check(
    greeting.includes('hello-native:sekret-v1'),
    'the new deploy interpolated .env natively and delivered the migrated secret',
  );
  check(
    guestOut('curl -fsS localhost:8080/marker.txt').includes('legacy-data'),
    'the volume data is still there after the new deployment',
  );
  log(
    'SUCCESS: legacy install upgraded in place with migrate, then control setup and a native deploy',
  );
} catch (error) {
  log(`FAILED: ${error.message}`);
  console.log('--- serial console (last 20 lines) ---');
  console.log(
    fs.existsSync(serial)
      ? fs.readFileSync(serial, 'utf8').split('\n').slice(-20).join('\n')
      : '(empty)',
  );
  const diag = guest(
    'docker ps -a --format "{{.Names}} {{.Image}} {{.Status}}"; docker logs --tail 15 tug-control-control-1 2>&1; docker logs --tail 15 tug-agent 2>&1',
    { fail: false },
  );
  console.log('--- guest containers ---\n' + (diag.stdout ?? ''));
  process.exitCode = 1;
}
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
if (!flag('keep')) cleanup();
else log(`left running (--keep): ssh -p ${sshPort} -i ${keyPath} root@127.0.0.1`);
