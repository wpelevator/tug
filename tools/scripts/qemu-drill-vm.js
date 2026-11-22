#!/usr/bin/env node
// Boots (or stops) one disposable Ubuntu arm64 VM under QEMU for hand-driven drills, and leaves it running.
//
//   node tools/scripts/qemu-drill-vm.js start --image <arm64 cloud image> --work <dir> [--name vm1] [--ssh-port 2222]
//     [--forward 18443:8443,19000:9000] [--memory 4096] [--cpus 2] [--disk 20G]
//   node tools/scripts/qemu-drill-vm.js stop --work <dir>
//
// `start` makes the work directory private (0700), creates an SSH key, a NoCloud seed that allows root login with it,
// a copy-on-write disk beside the pristine base image, and starts qemu daemonized (HVF, user networking, so the guest
// reaches this machine at 10.0.2.2). It writes `bin/ssh` and `bin/scp` shims that pass the key, port and host-key
// options: put `<work>/bin` first on PATH and `tug setup root@127.0.0.1 ...` reaches the guest without touching ~/.ssh.
// `stop` kills the VM from its pid file and leaves the disk for inspection. Requirements are those of qemu-first-boot.js.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [command, ...argv] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const workOpt = opt('work');
if (!['start', 'stop'].includes(command) || !workOpt) {
  console.error(
    'usage: qemu-drill-vm.js start|stop --work <dir> [start options, see the file header]',
  );
  process.exit(2);
}
const work = path.resolve(workOpt);
const pidFile = path.join(work, 'qemu.pid');

if (command === 'stop') {
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`stopped qemu ${pid}`);
    } catch {
      console.log(`qemu ${pid} was not running`);
    }
  }
  process.exit(0);
}

const image = opt('image');
if (!image) {
  console.error('start needs --image <arm64 cloud image>');
  process.exit(2);
}
const name = opt('name', 'vm1');
const sshPort = Number(opt('ssh-port', '2222'));
const forwards = (opt('forward', '') || '')
  .split(',')
  .filter(Boolean)
  .map((pair) => `hostfwd=tcp:127.0.0.1:${pair.split(':')[0]}-:${pair.split(':')[1]}`);
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr}`);
  return result;
};

fs.mkdirSync(work, { recursive: true, mode: 0o700 });
fs.chmodSync(work, 0o700);
const keyPath = path.join(work, 'id_ed25519');
if (!fs.existsSync(keyPath)) run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
const sshOptions = `-i '${keyPath}' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o IdentitiesOnly=yes -o ServerAliveInterval=15`;
const bin = path.join(work, 'bin');
fs.mkdirSync(bin, { recursive: true });
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

fs.writeFileSync(
  path.join(work, 'user-data'),
  `#cloud-config\ndisable_root: false\nssh_pwauth: false\nssh_authorized_keys:\n  - ${fs.readFileSync(`${keyPath}.pub`, 'utf8').trim()}\n`,
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(work, 'meta-data'),
  `instance-id: tug-${randomBytes(4).toString('hex')}\nlocal-hostname: ${name}\n`,
);
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
  opt('disk', '20G'),
]);

const nic = ['user,model=virtio-net-pci', `hostfwd=tcp:127.0.0.1:${sshPort}-:22`, ...forwards].join(
  ',',
);
run('qemu-system-aarch64', [
  '-machine',
  'virt,accel=hvf',
  '-cpu',
  'host',
  '-smp',
  opt('cpus', '2'),
  '-m',
  opt('memory', '4096'),
  '-bios',
  '/opt/homebrew/share/qemu/edk2-aarch64-code.fd',
  '-drive',
  `file=${disk},if=virtio,format=qcow2`,
  '-drive',
  `file=${seed},if=virtio,format=raw,media=cdrom,readonly=on`,
  '-nic',
  nic,
  '-display',
  'none',
  '-serial',
  `file:${path.join(work, 'serial.log')}`,
  '-monitor',
  'none',
  '-daemonize',
  '-pidfile',
  pidFile,
]);
console.log(`VM ${name} booting (pid ${fs.readFileSync(pidFile, 'utf8').trim()}), waiting for SSH`);

const deadline = Date.now() + 300_000;
for (;;) {
  const probe = spawnSync(
    '/usr/bin/ssh',
    [
      '-p',
      String(sshPort),
      ...sshOptions.replace(/'/g, '').split(' '),
      '-o',
      'ConnectTimeout=3',
      'root@127.0.0.1',
      'cloud-init status --wait',
    ],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) break;
  if (Date.now() > deadline) throw new Error('timed out waiting for SSH');
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`ready: PATH=${bin}:$PATH tug setup root@127.0.0.1 ...  (ssh port ${sshPort})`);
