#!/usr/bin/env node
// Prototype: prove the cloud-init enrollment path on a real first boot, locally, with QEMU.
//
//   node tools/scripts/qemu-first-boot.js --image <cloud-image.qcow2> [--work <dir>] [--name app1] [--keep]
//     [--ssh-user <user>] [--agent-image <tag>] [--block-docker-seconds N] [--timeout <seconds>]
//
// It runs a throwaway control on this machine, mints user-data with `tug node enroll --install-docker`, boots a cloud
// image with that user-data as a NoCloud seed (a real first boot, not a `cloud-init clean` replay) and watches until the
// node reports to control, printing a timeline. QEMU user networking reaches this machine at 10.0.2.2, so control
// advertises https://10.0.2.2:<port> and the guest reaches it without any bridge or root privileges. The agent image is
// pulled from the registry by the guest, so the guest needs outbound internet.
//
// Requirements: macOS on Apple Silicon with Homebrew `qemu` and `xorriso` (it boots arm64 guests with HVF and the
// edk2 firmware under /opt/homebrew), an arm64 cloud image that ships cloud-init with the NoCloud datasource, and
// the publisher's checksum file next to the image (SHA256SUMS, a *CHECKSUM file or <image>.sha256/.sha512).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
    'usage: qemu-first-boot.js --image <cloud image> [--work dir] [--name node] [--ssh-user user] [--keep] [--block-docker-seconds N]',
  );
  process.exit(2);
}
// The default login of the common cloud images, from the file name; override with --ssh-user.
const sshUser = opt(
  'ssh-user',
  /fedora/i.test(image) ? 'fedora' : /alpine/i.test(image) ? 'alpine' : 'ubuntu',
);
// sudo on most images, doas on Alpine.
const asRoot = sshUser === 'alpine' ? 'doas' : 'sudo -n';
const work = path.resolve(opt('work', path.join(repo, '.qemu-work')));
const nodeName = opt('name', 'app1');
const port = Number(opt('port', '8443'));
const sshPort = Number(opt('ssh-port', '2222'));
const timeoutSeconds = Number(opt('timeout', '900'));
const agentImage = opt('agent-image');
const blockSeconds = Number(opt('block-docker-seconds', '0'));
const hostAddress = '10.0.2.2';
const controlUrl = `https://${hostAddress}:${port}`;
const start = Date.now();
const stamp = () => `[${((Date.now() - start) / 1000).toFixed(0).padStart(4)}s]`;
const log = (message) => console.log(`${stamp()} ${message}`);
const children = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
process.on('exit', cleanup);
// `exit` does not fire on signals, so a cancelled run would orphan qemu and control and hold their ports.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
])
  process.on(signal, () => process.exit(code));

/** The expected digest for the image from the publisher's checksum file beside it, in the formats these images ship. */
function expectedDigest() {
  const dir = path.dirname(image);
  const name = path.basename(image);
  for (const algorithm of ['sha256', 'sha512']) {
    const file = path.join(dir, `${name}.${algorithm}`);
    const hash =
      fs.existsSync(file) && /^([0-9a-f]{64,128})\b/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
    if (hash) return { algorithm, hash };
  }
  for (const file of fs
    .readdirSync(dir)
    .filter((entry) => /(^|[-_.])(SHA256SUMS|CHECKSUM)$/.test(entry))) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      // "<hash> *<name>" (coreutils) or "SHA256 (<name>) = <hash>" (BSD, as Fedora publishes).
      const gnu = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line);
      if (gnu && gnu[2] === name) return { algorithm: 'sha256', hash: gnu[1] };
      const bsd = /^SHA256 \((.+)\) = ([0-9a-f]{64})$/.exec(line);
      if (bsd && bsd[1] === name) return { algorithm: 'sha256', hash: bsd[2] };
    }
  }
  return undefined;
}

async function verifyImage() {
  const expected = expectedDigest();
  if (!expected)
    return log('no publisher checksum found next to the image; skipping the integrity check');
  const hash = createHash(expected.algorithm);
  for await (const chunk of fs.createReadStream(image)) hash.update(chunk);
  if (hash.digest('hex') !== expected.hash)
    throw new Error(`image ${expected.algorithm} checksum mismatch`);
  log(
    `image ${expected.algorithm} checksum verified (integrity only: the checksum file itself is not signature-checked)`,
  );
}

/** A cloud-init multipart document: an operator part (SSH access) beside tug's part, which is the shape users need. */
function mime(parts) {
  const boundary = `==tug-${randomBytes(6).toString('hex')}==`;
  const body = parts
    .map(
      (p) =>
        `--${boundary}\nContent-Type: text/cloud-config; charset="utf-8"\nMIME-Version: 1.0\nContent-Disposition: attachment; filename="${p.name}.yaml"\n\n${p.content}\n`,
    )
    .join('');
  return `Content-Type: multipart/mixed; boundary="${boundary}"\nMIME-Version: 1.0\n\n${body}--${boundary}--\n`;
}

const tug = (args, env = {}, allowFail = false) =>
  run('node', [path.join(repo, 'src/cli.ts'), ...args], {
    allowFail,
    cwd: work,
    env: { ...process.env, TUG_CREDENTIAL_FILE: path.join(work, 'root.credential.json'), ...env },
  });

async function waitFor(label, probe, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The work dir holds a root credential, a private key and a join key.
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
fs.chmodSync(work, 0o700);
await verifyImage();

// 1. Throwaway control whose certificate names the address the guest will use.
const dataDir = path.join(work, 'control-data');
fs.rmSync(dataDir, { recursive: true, force: true });
const controlEnv = {
  ...process.env,
  PORT: String(port),
  TUG_CONTROL_URL: controlUrl,
  TUG_DATA_DIR: dataDir,
};
const credential = run(
  'node',
  [
    path.join(repo, 'src/main.ts'),
    'control',
    'issue-credential',
    '--name',
    'root',
    '--role',
    'admin',
  ],
  { env: controlEnv },
);
fs.writeFileSync(path.join(work, 'root.credential.json'), credential.stdout, { mode: 0o600 });
const controlLog = fs.openSync(path.join(work, 'control.log'), 'w');
const control = spawn('node', [path.join(repo, 'src/main.ts'), 'control'], {
  env: controlEnv,
  stdio: ['ignore', controlLog, controlLog],
});
children.push(control);
await waitFor(
  'control',
  () =>
    tug(['node', 'list', '--json', '--control-url', `https://127.0.0.1:${port}`], {}, true)
      .status === 0,
  60,
).catch(() => {
  throw new Error(`control did not start; see ${path.join(work, 'control.log')}`);
});
log(`control up on ${controlUrl}`);

// 2. User-data exactly as a user would save it, plus an SSH key part so the prototype can inspect the guest.
const keyPath = path.join(work, 'id_ed25519');
if (!fs.existsSync(keyPath)) run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
const enrollArgs = [
  'node',
  'enroll',
  '--name',
  nodeName,
  '--install-docker',
  '--agent-control-url',
  controlUrl,
  '--control-url',
  `https://127.0.0.1:${port}`,
];
if (agentImage) enrollArgs.push('--image', agentImage);
const tugPart = tug(enrollArgs).stdout;
fs.writeFileSync(path.join(work, 'tug-part.yaml'), tugPart, { mode: 0o600 });
// --block-docker-seconds N makes download.docker.com unreachable until N seconds after the early-boot bootcmd (via
// /etc/hosts and a detached sleeper), to exercise the bootstrap's retries. The bootstrap starts some 8 to 20 seconds
// after that point, so a short outage recovers and N above the retry window (about 50 seconds) plus that forces a failure.
let operatorPart = `#cloud-config\nssh_authorized_keys:\n  - ${fs.readFileSync(`${keyPath}.pub`, 'utf8').trim()}\n`;
if (blockSeconds > 0) {
  operatorPart +=
    `bootcmd:\n` +
    `  - echo '127.0.0.1 download.docker.com' >> /etc/hosts\n` +
    // Detached from cloud-init's pipes, or it would wait for the sleeper to exit.
    `  - setsid sh -c "sleep ${blockSeconds}; sed -i '/download.docker.com/d' /etc/hosts" </dev/null >/dev/null 2>&1 &\n`;
  log(`download.docker.com blocked inside the guest for ${blockSeconds}s`);
}
fs.writeFileSync(
  path.join(work, 'user-data'),
  mime([
    { name: 'operator', content: operatorPart },
    { name: 'tug', content: tugPart },
  ]),
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(work, 'meta-data'),
  `instance-id: tug-${randomBytes(4).toString('hex')}\nlocal-hostname: ${nodeName}\n`,
);
log(`user-data minted (${fs.statSync(path.join(work, 'user-data')).size} bytes)`);

// 3. NoCloud seed and a copy-on-write disk, so the base image stays pristine and every run is a first boot.
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
fs.chmodSync(seed, 0o600);
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
  '20G',
]);

// 4. Boot with HVF (Apple Silicon); the serial console is the failure channel a real user would have.
const serial = path.join(work, 'serial.log');
fs.rmSync(serial, { force: true });
const share = '/opt/homebrew/share/qemu';
const vm = spawn(
  'qemu-system-aarch64',
  [
    '-machine',
    'virt,accel=hvf',
    '-cpu',
    'host',
    '-smp',
    '2',
    '-m',
    '2048',
    '-bios',
    path.join(share, 'edk2-aarch64-code.fd'),
    '-drive',
    `file=${disk},if=virtio,format=qcow2`,
    '-drive',
    `file=${seed},if=virtio,format=raw,media=cdrom,readonly=on`,
    '-nic',
    `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
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

const ssh = (remote) =>
  run(
    'ssh',
    [
      '-p',
      String(sshPort),
      '-i',
      keyPath,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'ConnectTimeout=3',
      '-o',
      'LogLevel=ERROR',
      `${sshUser}@127.0.0.1`,
      remote,
    ],
    { allowFail: true },
  );

let sshUp = false;
try {
  await waitFor(
    `node ${nodeName} to report`,
    async () => {
      if (vm.exitCode !== null) throw new Error('the VM exited');
      if (!sshUp && ssh('true').status === 0) {
        sshUp = true;
        log('SSH reachable (cloud-init network stage done)');
      }
      // Once cloud-init has finished with an error there is nothing left to wait for.
      if (sshUp && /status: (error|degraded)/.test(ssh('cloud-init status').stdout)) {
        throw new Error('cloud-init finished with an error');
      }
      const list = tug(
        ['node', 'list', '--json', '--control-url', `https://127.0.0.1:${port}`],
        {},
        true,
      );
      if (list.status !== 0) return false;
      const nodes = JSON.parse(list.stdout);
      const node = (Array.isArray(nodes) ? nodes : (nodes.nodes ?? [])).find(
        (n) => n.name === nodeName,
      );
      if (!node) return false;
      log(`node ${nodeName} enrolled: ${JSON.stringify(node)}`);
      return true;
    },
    timeoutSeconds,
  );
  log('SUCCESS: first-boot cloud-init enrolled the node');
} catch (error) {
  log(`FAILED: ${error.message}`);
  console.log('--- serial console (last 40 lines) ---');
  console.log(
    fs.existsSync(serial)
      ? fs.readFileSync(serial, 'utf8').split('\n').slice(-40).join('\n')
      : '(empty)',
  );
  if (sshUp) {
    console.log('--- cloud-init status / output ---');
    console.log(
      ssh(`cloud-init status --long; ${asRoot} tail -n 40 /var/log/cloud-init-output.log`).stdout,
    );
  }
  process.exitCode = 1;
}

if (sshUp) {
  console.log('--- guest ---');
  console.log(
    ssh(`${asRoot} docker ps --format "{{.Names}} {{.Image}} {{.Status}}"; cloud-init status`)
      .stdout,
  );
}
if (!flag('keep')) cleanup();
else
  log(`left running until Ctrl-C (--keep): ssh -p ${sshPort} -i ${keyPath} ${sshUser}@127.0.0.1`);
