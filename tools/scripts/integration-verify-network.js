#!/usr/bin/env node
// Verifies, from the host, that a service resolves by name across nodes, that nginx publishes its
// port on the app node's plain address, and that Caddy routes to that service from another node.
// Everything runs through `docker compose exec` into the fake VPSes.
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { api as mtlsApi, loadCredential } from './mtls-fetch.js';

const project = process.env.COMPOSE_PROJECT_NAME || 'tug-it-net';
const control = process.env.TUG_CONTROL_URL || 'https://127.0.0.1:18080';
const credential = loadCredential();
const files = [
  '-f',
  'docker-compose.integration.yml',
  '-f',
  'docker-compose.integration-network.yml',
];

function sh(vps, script) {
  const r = spawnSync(
    'docker',
    ['compose', '-p', project, ...files, 'exec', '-T', vps, 'sh', '-c', script],
    { encoding: 'utf8' },
  );
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
async function until(label, fn, timeoutMs = 120000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const r = await fn();
    if (r.ok) {
      console.log(`ok: ${label}`);
      return r.out;
    }
    last = r.out;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error(`FAILED: ${label}\n${last}`);
  process.exit(1);
}
const api = (route, body) => mtlsApi(credential, control, route, body);

const nodes = (await api('/api/v1/nodes')).nodes;
const addresses = Object.fromEntries(nodes.map((n) => [n.name, n.address]));
for (const name of ['vps-a', 'vps-b', 'vps-c']) {
  if (!addresses[name] || isIP(addresses[name]) === 0)
    throw new Error(`${name} has no numeric node address: ${JSON.stringify(nodes)}`);
}
console.log('node addresses', addresses);

await until(
  'service DNS: client on vps-b resolves web on vps-a and fetches it through its node address',
  async () => {
    const r = sh(
      'vps-b',
      `c=$(docker ps -q --filter label=tug.service=client | head -1); [ -n "$c" ] && docker exec "$c" wget -qO- -T 5 http://web:8080/`,
    );
    return { ok: r.ok && r.out.includes('Welcome to nginx'), out: r.out };
  },
);

await until("nginx's private published port binds to vps-a's plain address", async () => {
  const r = sh(
    'vps-a',
    `c=$(docker ps -q --filter label=tug.service=web | head -1); [ -n "$c" ] && docker port "$c" 80/tcp`,
  );
  return {
    ok: r.ok && r.out.trim() === `${addresses['vps-a']}:8080`,
    out: `expected ${addresses['vps-a']}:8080\n${r.out}`,
  };
});

await until('ingress: Caddy on vps-c routes app.test to web on vps-a', async () => {
  const r = sh('vps-c', `curl -fsS -m 5 -H 'Host: app.test' http://127.0.0.1/`);
  return { ok: r.ok && r.out.includes('Welcome to nginx'), out: r.out };
});

console.log(JSON.stringify({ ok: true, addresses }, null, 2));
