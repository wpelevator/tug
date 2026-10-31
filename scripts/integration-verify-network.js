#!/usr/bin/env node
// Verifies, from the host, that the fake VPSes reached each other over WireGuard, that a service
// resolves by name across nodes, that ingress routes to a service on another node, and that a key
// rotation heals the mesh. Everything runs through `docker compose exec` into the fake VPSes.
import { spawnSync } from 'node:child_process';

const project = process.env.COMPOSE_PROJECT_NAME || 'pad-launch-it-net';
const control = process.env.LAUNCHPAD_CONTROL_URL || 'http://localhost:18080';
const token = process.env.LAUNCHPAD_TOKEN || 'integration-token';
const files = ['-f', 'docker-compose.integration.yml', '-f', 'docker-compose.integration-network.yml'];

function sh(vps, script) {
  const r = spawnSync('docker', ['compose', '-p', project, ...files, 'exec', '-T', vps, 'sh', '-c', script], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
async function until(label, fn, timeoutMs = 120000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const r = await fn();
    if (r.ok) { console.log(`ok: ${label}`); return r.out; }
    last = r.out;
    await new Promise(r => setTimeout(r, 3000));
  }
  console.error(`FAILED: ${label}\n${last}`);
  process.exit(1);
}
async function api(route, body) {
  const res = await fetch(`${control}${route}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return res.json();
}

const nodes = (await api('/api/v1/nodes')).nodes;
const ip = Object.fromEntries(nodes.map(n => [n.name, n.overlay_ip]));
for (const name of ['vps-a', 'vps-b', 'vps-c']) {
  if (!ip[name]) throw new Error(`${name} has no overlay address: ${JSON.stringify(nodes)}`);
}
console.log('overlay addresses', ip);

const pairs = [['vps-a', 'vps-b'], ['vps-b', 'vps-a'], ['vps-a', 'vps-c'], ['vps-c', 'vps-b']];
async function meshReachable(label) {
  for (const [from, to] of pairs) {
    await until(`${label}: ${from} pings ${to} (${ip[to]}) over the mesh`, async () => sh(from, `ping -c 1 -W 2 ${ip[to]}`));
  }
}
await meshReachable('mesh');

await until('vps-a has a WireGuard handshake with vps-b', async () => {
  const r = sh('vps-a', 'wg show wg0 latest-handshakes');
  return { ok: r.out.split('\n').some(l => /\s[1-9]\d+$/.test(l)), out: r.out };
});

await until('service DNS: client on vps-b resolves web on vps-a and fetches it over the mesh', async () => {
  const r = sh('vps-b', `c=$(docker ps -q --filter label=com.docker.compose.service=client | head -1); [ -n "$c" ] && docker exec "$c" wget -qO- -T 5 http://web:8080/`);
  return { ok: r.ok && r.out.includes('Welcome to nginx'), out: r.out };
});

await until('ingress: Caddy on vps-c routes app.test to web on vps-a', async () => {
  const r = sh('vps-c', `curl -fsS -m 5 -H 'Host: app.test' http://127.0.0.1/`);
  return { ok: r.ok && r.out.includes('Welcome to nginx'), out: r.out };
});

// Key rotation: the node generates a new keypair, peers pick it up, traffic recovers.
const before = sh('vps-b', 'wg show wg0 public-key').out.trim();
const rotated = await api('/api/v1/nodes/vps-b/rotate-wg-key', {});
await until('rotate-wg-key command succeeds', async () => {
  const cmd = await api(`/api/v1/commands/${rotated.commandId}`);
  return { ok: cmd.state === 'succeeded', out: JSON.stringify(cmd) };
});
await until('vps-b public key changed', async () => {
  const now = sh('vps-b', 'wg show wg0 public-key').out.trim();
  return { ok: now !== '' && now !== before, out: now };
});
await meshReachable('after rotation');

console.log(JSON.stringify({ ok: true, overlay: ip }, null, 2));
