#!/usr/bin/env node
// Validates the "verify" claims of docs/private-control-network.md on two disposable Ubuntu arm64 VMs under QEMU.
//
//   node tools/scripts/qemu-tailnet.js [all] --work <dir> [--image <arm64 cloud image>] [--keep]
//   node tools/scripts/qemu-tailnet.js up|install|check <name>|down --work <dir>
//
// Checks: boot-race (Docker before tailscaled, restart policy), boot-order (the tug-after drop-in, tailscaled Type,
// the address wait), userspace (no tailscale0 and no route from --network host containers), serve (tailscale serve
// syntax, persistence and the source address a loopback-published container sees) and coordination (Headscale down).
// Each check prints PASS/FAIL/INCONCLUSIVE lines and writes its raw transcript to <work>/logs/<check>.log.
//
// Network: VM a (10.77.0.1) runs Headscale, VM b (10.77.0.2) joins it. Both have a user-mode NIC for internet and a
// second NIC wired point to point through a `-netdev socket` on 127.0.0.1, so no root and no multicast are needed and
// peers reach each other directly (Headscale's DERP is off). Both run Ubuntu's docker.io and Tailscale from
// pkgs.tailscale.com. The client dials Headscale on its LAN address, so this does not exercise DERP relaying or
// Tailscale's hosted coordination server.
//
// Requirements are those of qemu-first-boot.js (Homebrew qemu, qemu-img, xorriso, an arm64 Ubuntu cloud image) plus
// internet access from the guests. `all` creates the VMs, runs every check and, unless --keep is given, stops them.
// `up` leaves them running with state in <work>/vms.json, so `check` and `down` can run later.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const command = positional[0] ?? 'all';
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const workOpt = opt('work');
if (!['all', 'up', 'install', 'check', 'down'].includes(command) || !workOpt) {
  console.error(
    'usage: qemu-tailnet.js [all|up|install|check <name>|down] --work <dir> [--image <img>] [--keep]',
  );
  process.exit(2);
}
const work = path.resolve(workOpt);
const image = path.resolve(
  opt('image', path.join(os.homedir(), 'images/ubuntu-24.04-server-cloudimg-arm64.img')),
);
const keep = argv.includes('--keep');
const firmware = '/opt/homebrew/share/qemu/edk2-aarch64-code.fd';
const stateFile = path.join(work, 'vms.json');
const logDir = path.join(work, 'logs');
const TS_IP = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
};

// ---- VMs --------------------------------------------------------------------------------------------------------
const vmDefs = {
  a: { sshPort: 2231, lan: '10.77.0.1', mac: '52:54:00:aa:00:01', lanMac: '52:54:00:aa:77:01' },
  b: { sshPort: 2232, lan: '10.77.0.2', mac: '52:54:00:bb:00:01', lanMac: '52:54:00:bb:77:01' },
};
const LAN_PORT = 41777;
let key;
const sshArgs = (vm) => [
  '-p',
  String(vmDefs[vm].sshPort),
  '-i',
  key,
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'BatchMode=yes',
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'ConnectTimeout=5',
  '-o',
  'ServerAliveInterval=10',
];

// Runs a command in the guest, returns { status, out } with stderr merged. Never throws on a non-zero exit.
function sh(vm, cmd, { timeout = 600 } = {}) {
  const r = spawnSync('/usr/bin/ssh', [...sshArgs(vm), 'root@127.0.0.1', cmd], {
    encoding: 'utf8',
    timeout: timeout * 1000,
  });
  return { status: r.status ?? 255, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd() };
}

function bootVm(vm) {
  const def = vmDefs[vm];
  const dir = path.join(work, vm);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-data'),
    `#cloud-config\ndisable_root: false\nssh_pwauth: false\nssh_authorized_keys:\n  - ${fs.readFileSync(`${key}.pub`, 'utf8').trim()}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'meta-data'),
    `instance-id: tailnet-${vm}\nlocal-hostname: tn-${vm}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'network-config'),
    `version: 2\nethernets:\n  wan:\n    match: {macaddress: "${def.mac}"}\n    dhcp4: true\n  lan:\n    match: {macaddress: "${def.lanMac}"}\n    addresses: [${def.lan}/24]\n`,
  );
  const seed = path.join(dir, 'seed.iso');
  fs.rmSync(seed, { force: true });
  local('xorriso', [
    '-as',
    'mkisofs',
    '-quiet',
    '-output',
    seed,
    '-volid',
    'cidata',
    '-joliet',
    '-rock',
    path.join(dir, 'user-data'),
    path.join(dir, 'meta-data'),
    path.join(dir, 'network-config'),
  ]);
  const disk = path.join(dir, 'disk.qcow2');
  fs.rmSync(disk, { force: true });
  local('qemu-img', ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', image, disk, '12G']);
  const lanNet = vm === 'a' ? `listen=127.0.0.1:${LAN_PORT}` : `connect=127.0.0.1:${LAN_PORT}`;
  local('qemu-system-aarch64', [
    '-machine',
    'virt,accel=hvf',
    '-cpu',
    'host',
    '-smp',
    '2',
    '-m',
    '2048',
    '-bios',
    firmware,
    '-drive',
    `file=${disk},if=virtio,format=qcow2`,
    '-drive',
    `file=${seed},if=virtio,format=raw,media=cdrom,readonly=on`,
    '-nic',
    `user,model=virtio-net-pci,mac=${def.mac},hostfwd=tcp:127.0.0.1:${def.sshPort}-:22`,
    '-netdev',
    `socket,id=lan,${lanNet}`,
    '-device',
    `virtio-net-pci,netdev=lan,mac=${def.lanMac}`,
    '-display',
    'none',
    '-serial',
    `file:${path.join(dir, 'serial.log')}`,
    '-monitor',
    'none',
    '-daemonize',
    '-pidfile',
    path.join(dir, 'qemu.pid'),
  ]);
}

async function waitSsh(vm, seconds = 300, gone = false) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = sh(vm, 'cloud-init status --wait >/dev/null 2>&1; echo ok', { timeout: 120 });
    if (r.out.endsWith('ok') !== gone) return;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ssh on ${vm}`);
}

async function reboot(vm) {
  const before = sh(vm, 'cat /proc/sys/kernel/random/boot_id').out;
  sh(vm, 'systemctl reboot', { timeout: 20 });
  const deadline = Date.now() + 300_000;
  await sleep(8000);
  while (Date.now() < deadline) {
    const r = sh(vm, 'cat /proc/sys/kernel/random/boot_id', { timeout: 15 });
    if (r.status === 0 && r.out !== before) return;
    await sleep(2000);
  }
  throw new Error(`${vm} did not come back after reboot`);
}

function stopAll() {
  for (const vm of Object.keys(vmDefs)) {
    const pidFile = path.join(work, vm, 'qemu.pid');
    if (!fs.existsSync(pidFile)) continue;
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
    } catch {
      /* already gone */
    }
    fs.rmSync(pidFile, { force: true });
  }
}

// ---- Reporting --------------------------------------------------------------------------------------------------
let currentLog;
const results = [];
function log(text) {
  fs.appendFileSync(currentLog, `${text}\n`);
}
// Runs a command, writes "$ cmd" and its output to the check transcript, returns the output.
function run(vm, cmd, options) {
  const r = sh(vm, cmd, options);
  log(`[${vm}] $ ${cmd}\n${r.out}${r.out ? '\n' : ''}(exit ${r.status})`);
  return r;
}
function verdict(name, ok, message) {
  const tag = ok === null ? 'INCONCLUSIVE' : ok ? 'PASS' : 'FAIL';
  const line = `${tag} ${name}: ${message}`;
  results.push(line);
  console.log(line);
  log(line);
}

// ---- Provisioning -----------------------------------------------------------------------------------------------
async function install() {
  currentLog = path.join(logDir, 'install.log');
  fs.writeFileSync(currentLog, '');
  const common = `
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates docker.io socat python3 >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
apt-get update -qq
apt-get install -y -qq tailscale >/dev/null
docker pull -q alpine >/dev/null
docker pull -q curlimages/curl >/dev/null
`;
  for (const vm of ['a', 'b']) {
    const r = run(vm, common);
    if (r.status !== 0) throw new Error(`install failed on ${vm}, see ${currentLog}`);
  }
  const headscale = `
set -e
url=$(curl -fsSL https://api.github.com/repos/juanfont/headscale/releases/latest | python3 -c 'import json,sys; print([a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith("linux_arm64.deb")][0])')
echo "$url"
curl -fsSL "$url" -o /root/headscale.deb
apt-get install -y -qq /root/headscale.deb >/dev/null
sed -i 's|^server_url:.*|server_url: http://10.77.0.1:8080|; s|^listen_addr:.*|listen_addr: 0.0.0.0:8080|' /etc/headscale/config.yaml
systemctl enable headscale
systemctl restart headscale
for i in $(seq 30); do headscale users list >/dev/null 2>&1 && break; sleep 1; done
headscale users create tug 2>&1 || true
`;
  const hs = run('a', headscale);
  if (hs.status !== 0) throw new Error(`headscale install failed, see ${currentLog}`);
}

// Pre-auth key from Headscale. Newer releases want a numeric user id; older ones take the name.
function preauthKey(extra = '') {
  const id = sh(
    'a',
    'headscale users list -o json | python3 -c \'import json,sys; print(json.load(sys.stdin)[0]["id"])\'',
  ).out;
  const r = sh(
    'a',
    `headscale preauthkeys create --user ${id} --expiration 1h ${extra} -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])'`,
  );
  if (r.status !== 0) throw new Error(`preauthkey failed: ${r.out}`);
  return r.out;
}

async function join() {
  currentLog = path.join(logDir, 'join.log');
  fs.writeFileSync(currentLog, '');
  for (const vm of ['a', 'b']) {
    const k = preauthKey();
    const r = run(
      vm,
      `umask 077; printf %s '${k}' > /root/authkey; systemctl enable --now tailscaled; tailscale up --login-server http://10.77.0.1:8080 --auth-key=file:/root/authkey --hostname tn-${vm} --accept-dns=false; tailscale ip -4`,
    );
    if (r.status !== 0) throw new Error(`join failed on ${vm}: ${r.out}`);
    TS_IP[vm] = r.out.split('\n').pop().trim();
  }
  log(`tailscale addresses ${JSON.stringify(TS_IP)}`);
}

function tsIps() {
  for (const vm of ['a', 'b']) TS_IP[vm] = sh(vm, 'tailscale ip -4').out.split('\n').pop().trim();
}

// ---- Checks -----------------------------------------------------------------------------------------------------
const put = (vm, file, text) =>
  run(
    vm,
    `mkdir -p $(dirname ${file}) && echo ${Buffer.from(text).toString('base64')} | base64 -d > ${file}`,
  );
const waitFor = async (vm, cmd, seconds) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (sh(vm, cmd, { timeout: 20 }).status === 0) return true;
    await sleep(3000);
  }
  return false;
};
const DOCKER_DIR = '/etc/systemd/system/docker.service.d';
const TS_DIR = '/etc/systemd/system/tailscaled.service.d';
const AFTER = '[Unit]\nAfter=tailscaled.service\nWants=tailscaled.service\n';
// Waits for tailscale0 to hold an IPv4 address, with a timeout, and never fails the unit.
const WAIT = [
  '[Service]',
  `ExecStartPre=/bin/sh -c 'for i in $$(seq 1 60); do ip -4 -o addr show dev tailscale0 2>/dev/null | grep -q "inet " && exit 0; sleep 1; done; exit 0'`,
  '',
].join('\n');
const SLOW_TAILSCALED = '[Service]\nExecStartPre=/bin/sleep 40\n';

// Recreates the probe container (published on the tailnet address, restart policy unless-stopped) while the
// address exists, applies the drop-ins, reboots and reports what the host looks like once boot has settled.
async function bootScenario(label, { after = false, wait = false, slow = false }) {
  const ip = TS_IP.a;
  log(`\n=== scenario: ${label}`);
  run('a', `rm -f ${DOCKER_DIR}/tug-*.conf ${TS_DIR}/slow.conf`);
  if (after) put('a', `${DOCKER_DIR}/tug-after.conf`, AFTER);
  if (wait) put('a', `${DOCKER_DIR}/tug-wait.conf`, WAIT);
  if (slow) put('a', `${TS_DIR}/slow.conf`, SLOW_TAILSCALED);
  run('a', 'systemctl daemon-reload; systemctl restart docker; sleep 3');
  run(
    'a',
    `docker rm -f probe >/dev/null 2>&1; docker run -d --name probe --restart unless-stopped -p ${ip}:8443:8443 probe-img socat TCP-LISTEN:8443,fork,reuseaddr SYSTEM:'echo hi'; docker ps --format '{{.Names}} {{.Status}} [{{.Ports}}]'`,
  );
  await reboot('a');
  await waitFor('a', 'tailscale ip -4 >/dev/null 2>&1', 120);
  await sleep(15);
  const r = run(
    'a',
    `echo "state: $(docker inspect probe -f '{{.State.Status}} restarts={{.RestartCount}} networks={{len .NetworkSettings.Networks}} published={{len .NetworkSettings.Ports}}')"; ` +
      `echo "error: $(docker inspect probe -f '{{.State.Error}}' | grep -o 'failed to bind.*')"; ` +
      `journalctl -b -o short-precise --no-pager | grep -E 'Started (tailscaled|docker)\\.service|Switching ipn state Starting -> Running|failed to start container' | cut -c1-130; systemctl show tailscaled -p Type; ip -4 -o addr show dev tailscale0 | cut -c1-60`,
  );
  const state = /state: (\S+) restarts=(\d+) networks=(\d+) published=(\d+)/.exec(r.out);
  // The peer path can take a few seconds to re-establish after the reboot, so retry before calling it unreachable.
  const reachable = await waitFor(
    'b',
    `[ "$(timeout 5 socat - TCP:${ip}:8443 </dev/null)" = hi ]`,
    30,
  );
  log(`[${label}] reachable from the peer: ${reachable}`);
  return {
    label,
    state: state?.[1],
    restarts: state?.[2],
    published: state?.[4],
    reachable,
    out: r.out,
  };
}

const checks = {
  // Claims 1 and 2: Docker before tailscaled, the restart policy, the drop-in and the wait.
  // PASS means the proposal's statement held, FAIL that it did not.
  async 'boot-race'() {
    run(
      'a',
      "printf 'FROM alpine\\nRUN apk add --no-cache socat\\n' | docker build -q -t probe-img - 2>&1 | tail -1",
    );
    const natural = [
      await bootScenario('natural boot 1', {}),
      await bootScenario('natural boot 2', {}),
    ];
    const slow = await bootScenario('tailscaled delayed 40s, no drop-in', { slow: true });
    const all = [...natural, slow];
    const broken = all.filter((s) => !s.reachable).length;
    verdict(
      'boot-race.container-not-published',
      broken > 0,
      `${broken} of 3 boots without a drop-in left the bound container unreachable: ${all.map((s) => `${s.state}/published=${s.published}`).join(', ')}`,
    );
    verdict(
      'boot-race.docker-does-not-retry',
      !slow.reachable && slow.restarts === '0',
      `with tailscaled delayed the container was ${slow.state} (restarts=${slow.restarts}) after the address appeared, so unless-stopped did not retry it`,
    );
    // A failed start leaves the container without a network, so even a manual start later publishes nothing.
    const healed = run(
      'a',
      "docker start probe >/dev/null 2>&1; sleep 1; echo \"after a manual start: networks=$(docker inspect probe -f '{{len .NetworkSettings.Networks}}') published=$(docker inspect probe -f '{{len .NetworkSettings.Ports}}')\"",
    );
    verdict('boot-race.manual-start-stays-unpublished', null, healed.out.split('\n')[0]);
    const afterOnly = [
      await bootScenario('After= drop-in, boot 1', { after: true }),
      await bootScenario('After= drop-in, boot 2', { after: true }),
      await bootScenario('After= drop-in, tailscaled delayed', { after: true, slow: true }),
    ];
    verdict(
      'boot-order.after-dropin',
      afterOnly.every((s) => s.reachable),
      `bound container reachable after reboot with After=/Wants=: ${afterOnly.map((s) => s.reachable).join(', ')} (natural, natural, delayed)`,
    );
    verdict(
      'boot-order.type-notify-not-address',
      null,
      `tailscaled ${/Type=\w+/.exec(afterOnly[0].out)?.[0]}; compare Started tailscaled.service with Starting -> Running in the transcript`,
    );
    const waited = [
      await bootScenario('After= plus address wait, boot 1', { after: true, wait: true }),
      await bootScenario('After= plus address wait, boot 2', { after: true, wait: true }),
      await bootScenario('After= plus address wait, tailscaled delayed', {
        after: true,
        wait: true,
        slow: true,
      }),
    ];
    verdict(
      'boot-order.address-wait',
      waited.every((s) => s.reachable),
      `bound container reachable with the ExecStartPre wait: ${waited.map((s) => s.reachable).join(', ')} (natural, natural, delayed)`,
    );
    run(
      'a',
      `rm -f ${DOCKER_DIR}/tug-*.conf ${TS_DIR}/slow.conf; systemctl daemon-reload; docker rm -f probe`,
    );
  },

  // Claim 4: userspace networking.
  async userspace() {
    run('b', '(nohup python3 -m http.server 8000 --bind 0.0.0.0 >/tmp/http.log 2>&1 &); sleep 1');
    const target = `http://${TS_IP.b}:8000/`;
    const curl = (extra = '') =>
      `docker run --rm --network host curlimages/curl -sS -m 8 ${extra} -o /dev/null -w '%{http_code}' ${target}`;
    const kernel = run('a', curl());
    verdict(
      'userspace.kernel-reaches-peer',
      kernel.out.endsWith('200'),
      `kernel mode, host-network container to ${target}: ${kernel.out.split('\n').pop()}`,
    );
    run(
      'a',
      `echo 'FLAGS="--tun=userspace-networking"' >> /etc/default/tailscaled; systemctl restart tailscaled; sleep 6; tailscale status | head -3`,
    );
    const iface = run('a', 'ip -br link show tailscale0');
    verdict(
      'userspace.no-interface',
      iface.status !== 0,
      `tailscale0 ${iface.status === 0 ? 'exists' : 'is absent'} in userspace mode`,
    );
    const user = run('a', curl());
    verdict(
      'userspace.container-cannot-reach-peer',
      !user.out.endsWith('200'),
      `userspace mode, host-network container to ${target}: ${user.out.split('\n').pop()}`,
    );
    const host = run('a', `curl -sS -m 8 -o /dev/null -w '%{http_code}' ${target}`);
    verdict(
      'userspace.host-process-cannot-reach-peer',
      !host.out.endsWith('200'),
      `userspace mode, plain host process to ${target}: ${host.out.split('\n').pop()}`,
    );
    // Inbound still works (tailscaled forwards to local listeners), only outbound needs the proxy.
    run('a', '(nohup python3 -m http.server 8001 --bind 127.0.0.1 >/tmp/http.log 2>&1 &); sleep 1');
    const inbound = run(
      'b',
      `curl -sS -m 8 -o /dev/null -w '%{http_code}' http://${TS_IP.a}:8001/`,
    );
    verdict(
      'userspace.inbound-reaches-loopback-listener',
      null,
      `peer to a loopback-only service on the userspace node: ${inbound.out.split('\n').pop()}`,
    );
    run(
      'a',
      `sed -i 's|^FLAGS=.*|FLAGS="--tun=userspace-networking --socks5-server=localhost:1055"|' /etc/default/tailscaled; systemctl restart tailscaled; sleep 6`,
    );
    const socks = run('a', curl('-x socks5h://localhost:1055'));
    verdict(
      'userspace.socks-proxy-reaches-peer',
      null,
      `with --socks5-server a client that speaks SOCKS reaches the peer: ${socks.out.split('\n').pop()}`,
    );
    run(
      'a',
      `sed -i 's|^FLAGS=.*|FLAGS=""|' /etc/default/tailscaled; systemctl restart tailscaled; sleep 6; pkill -f 'http.server 8001'; true`,
    );
    const again = run('a', curl());
    verdict(
      'userspace.kernel-restored',
      again.out.endsWith('200'),
      `kernel mode again: ${again.out.split('\n').pop()}`,
    );
  },

  // Claim 5: tailscale serve, its persistence and the source address a container sees.
  async serve() {
    const ip = TS_IP.a;
    run('a', 'tailscale serve --help 2>&1 | sed -n 1,30p');
    run(
      'a',
      "printf 'FROM alpine\\nRUN apk add --no-cache socat\\n' | docker build -q -t probe-img - 2>&1 | tail -1",
    );
    const peer = (target) => `(sleep 2) | socat - TCP:${target}:8443`;
    const startProbe = (publish) =>
      `docker rm -f probe >/dev/null 2>&1; docker run -d --name probe --restart unless-stopped -p ${publish} probe-img socat TCP-LISTEN:8443,fork,reuseaddr SYSTEM:'echo peer=$SOCAT_PEERADDR' >/dev/null; sleep 1`;
    run('a', startProbe('127.0.0.1:8443:8443'));
    const cfg = run(
      'a',
      'tailscale serve --bg --tcp 8443 tcp://127.0.0.1:8443 2>&1; tailscale serve status 2>&1',
    );
    verdict(
      'serve.syntax',
      cfg.status === 0 && cfg.out.includes('tcp://127.0.0.1:8443'),
      `tailscale serve --bg --tcp 8443 tcp://127.0.0.1:8443 exits ${cfg.status} and lists the forward`,
    );
    const through = run('b', peer(ip));
    verdict(
      'serve.reaches-through-tailnet',
      through.out.includes('peer='),
      `peer ${TS_IP.b} through the serve forward got: ${through.out.split('\n')[0]}`,
    );
    verdict(
      'serve.source-address-seen-by-container',
      null,
      `container sees ${through.out.split('\n')[0]} for a connection from ${TS_IP.b} (docker-proxy on the bridge gateway)`,
    );
    await reboot('a');
    await waitFor('a', 'tailscale ip -4 >/dev/null 2>&1', 60);
    const after = run('a', 'tailscale serve status 2>&1');
    const reached = await waitFor('b', `[ -n "$((sleep 2) | socat - TCP:${ip}:8443)" ]`, 60);
    verdict(
      'serve.survives-reboot',
      reached && after.out.includes('127.0.0.1:8443'),
      `serve config after reboot: ${after.out.split('\n').pop()}; peer reaches it: ${reached}`,
    );
    run('a', 'tailscale serve reset');
    // Without serve: the same container published directly on the tailnet address, and on all interfaces.
    run('a', startProbe(`${ip}:8443:8443`));
    const direct = run('b', peer(ip));
    verdict(
      'serve.direct-tailnet-publish-source',
      null,
      `container published on ${ip} sees ${direct.out.split('\n')[0]} for a connection from ${TS_IP.b}`,
    );
    run('a', startProbe('8443:8443'));
    const lan = run('b', peer(vmDefs.a.lan));
    const tailnet = run('b', peer(ip));
    verdict(
      'serve.all-interfaces-publish-source',
      null,
      `container published on all interfaces sees ${lan.out.split('\n')[0]} over the LAN and ${tailnet.out.split('\n')[0]} over the tailnet`,
    );
    run('a', 'docker rm -f probe');
  },

  // Claim 7: a tagged pre-auth key (Headscale half only; Tailscale's own defaults come from its documentation).
  async tags() {
    const key = preauthKey('--tags tag:tug-node');
    run(
      'b',
      `mkdir -p /var/lib/ts2; (nohup tailscaled --tun=userspace-networking --state=/var/lib/ts2/state --socket=/run/ts2.sock --port=0 >/tmp/ts2.log 2>&1 &); sleep 3; umask 077; printf %s '${key}' > /root/tagkey`,
    );
    const up = run(
      'b',
      'timeout 60 tailscale --socket=/run/ts2.sock up --login-server http://10.77.0.1:8080 --auth-key=file:/root/tagkey --hostname tagged1 --timeout 40s 2>&1; echo exit=$?; shred -u /root/tagkey',
      { timeout: 90 },
    );
    const nodes = run(
      'a',
      `headscale nodes list -o json | python3 -c 'import json,sys; [print(json.dumps({k: n.get(k) for k in ["name", "tags", "expiry"]} | {"owner": n["user"]["name"]})) for n in json.load(sys.stdin)]'`,
    );
    const tagged = nodes.out.split('\n').find((l) => l.includes('tagged1')) ?? '';
    verdict(
      'tags.preauth-key-tags-node',
      up.out.includes('exit=0') && tagged.includes('tag:tug-node'),
      `node after joining with a tagged key: ${tagged}`,
    );
    verdict(
      'tags.key-expiry',
      null,
      `Headscale reports expiry null for the tagged node and for untagged nodes alike (${nodes.out.split('\n').filter((l) => l.includes('"expiry": null')).length} of ${nodes.out.split('\n').length} have none): it does not expire node keys unless configured, so the Tailscale default for tagged devices cannot be observed here`,
    );
    run('b', "pkill -f 'tailscaled --tun=userspace-networking --state=/var/lib/ts2'; true");
  },

  // Claim 6: Headscale down.
  async coordination() {
    run('a', '(nohup python3 -m http.server 8002 --bind 0.0.0.0 >/tmp/http2.log 2>&1 &); sleep 1');
    run(
      'b',
      `(nohup sh -c 'while true; do echo "$(date +%T) $(curl -sS -m 3 -o /dev/null -w %{http_code} http://${TS_IP.a}:8002/ 2>&1)"; sleep 5; done' >/tmp/probe.log 2>&1 &); sleep 6; cat /tmp/probe.log`,
    );
    run('a', 'systemctl stop headscale; systemctl is-active headscale');
    await sleep(60);
    const early = run('b', `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://${TS_IP.a}:8002/`);
    verdict(
      'coordination.existing-peers-1min',
      early.out.endsWith('200'),
      `a minute after stopping Headscale, peer-to-peer HTTP: ${early.out.split('\n').pop()}`,
    );
    await sleep(180);
    const long = run(
      'b',
      `curl -sS -m 8 -o /dev/null -w '%{http_code}' http://${TS_IP.a}:8002/; echo; tail -3 /tmp/probe.log; echo "non-200 probes: $(grep -vc 200 /tmp/probe.log)"`,
    );
    verdict(
      'coordination.existing-peers-4min',
      long.out.split('\n')[0].endsWith('200'),
      `about four minutes after stopping Headscale: ${long.out.split('\n')[0]}`,
    );
    // A restart is a different matter: the node needs the coordination server to learn its address and peers again.
    run(
      'b',
      'systemctl restart tailscaled; sleep 15; tailscale status 2>&1 | head -4; ip -4 -o addr show tailscale0 2>&1 | cut -c1-60',
    );
    const restarted = run(
      'b',
      `curl -sS -m 8 -o /dev/null -w '%{http_code}' http://${TS_IP.a}:8002/`,
    );
    verdict(
      'coordination.restarted-node-loses-tailnet',
      !restarted.out.endsWith('200'),
      `tailscaled restarted on b while Headscale is down, peer HTTP afterwards: ${restarted.out.split('\n').pop()} (no address, no peers until Headscale returns)`,
    );
    // A new device cannot join: a second tailscaled on b with its own state, with a key minted before the outage.
    run('a', 'systemctl start headscale; sleep 3');
    const key = preauthKey();
    run('a', 'systemctl stop headscale');
    run(
      'b',
      `mkdir -p /var/lib/ts2; (nohup tailscaled --tun=userspace-networking --state=/var/lib/ts2/state --socket=/run/ts2.sock --port=0 >/tmp/ts2.log 2>&1 &); sleep 3`,
    );
    const down = run(
      'b',
      `timeout 40 tailscale --socket=/run/ts2.sock up --login-server http://10.77.0.1:8080 --auth-key=${key} --hostname newdev --timeout 25s 2>&1; echo exit=$?`,
      { timeout: 90 },
    );
    verdict(
      'coordination.new-device-cannot-join',
      /exit=[1-9]/.test(down.out),
      `new device while Headscale is down: ${down.out.split('\n').pop()}`,
    );
    run('a', 'systemctl start headscale; sleep 5; systemctl is-active headscale');
    const up = run(
      'b',
      `timeout 60 tailscale --socket=/run/ts2.sock up --login-server http://10.77.0.1:8080 --auth-key=${key} --hostname newdev --timeout 40s 2>&1; echo exit=$?`,
      { timeout: 90 },
    );
    verdict(
      'coordination.new-device-joins-after-restore',
      up.out.endsWith('exit=0'),
      `after Headscale returns: ${up.out.split('\n').pop()}`,
    );
    const recovered = await waitFor(
      'b',
      `[ "$(curl -sS -m 5 -o /dev/null -w %{http_code} http://${TS_IP.a}:8002/)" = 200 ]`,
      120,
    );
    verdict(
      'coordination.restarted-node-recovers',
      recovered,
      `the restarted node reaches its peer again once Headscale is back: ${recovered}`,
    );
    run(
      'b',
      `pkill -f 'tailscaled --tun=userspace-networking --state=/var/lib/ts2'; pkill -f 'while true; do echo'; true`,
    );
  },
};
const checkOrder = ['boot-race', 'userspace', 'serve', 'tags', 'coordination'];

// ---- Main -------------------------------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(work, 0o700);
  key = path.join(work, 'id_ed25519');
  if (!fs.existsSync(key)) local('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);

  if (command === 'down') {
    stopAll();
    console.log('stopped');
    return;
  }
  if (command === 'up' || command === 'all') {
    for (const vm of ['a', 'b']) bootVm(vm);
    console.log('VMs booting');
    for (const vm of ['a', 'b']) await waitSsh(vm);
    console.log('installing Docker, Tailscale and Headscale');
    await install();
    await join();
    fs.writeFileSync(stateFile, JSON.stringify({ TS_IP }, null, 2));
    console.log(`joined: a=${TS_IP.a} b=${TS_IP.b}`);
    console.log(
      sh('a', 'tailscale version | head -1; headscale version; docker --version; uname -r').out,
    );
  } else {
    tsIps();
  }
  if (command === 'install') await install();
  if (command === 'check') {
    tsIps();
    currentLog = path.join(logDir, `${positional[1]}.log`);
    fs.writeFileSync(currentLog, '');
    await checks[positional[1]]();
  }
  if (command === 'all') {
    for (const name of checkOrder) {
      currentLog = path.join(logDir, `${name}.log`);
      fs.writeFileSync(currentLog, '');
      try {
        await checks[name]();
      } catch (error) {
        verdict(name, false, `check crashed: ${error.message}`);
      }
    }
    console.log('\nsummary');
    for (const line of results) console.log(line);
  }
}

try {
  await main();
} finally {
  if (command === 'all' && !keep) stopAll();
}
if (results.some((l) => l.startsWith('FAIL'))) process.exitCode = 1;
