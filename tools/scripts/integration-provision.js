#!/usr/bin/env node
import fs from 'node:fs/promises';

const control = process.env.TUG_CONTROL_URL || 'http://control:8080';
const token = process.env.TUG_TOKEN || 'integration-token';
const tokenDir = process.env.TUG_TOKEN_DIR || '/tokens';
// Networking scenario: advertise each node's name as its WireGuard endpoint and mark ingress nodes.
const publicFromName = process.env.TUG_PUBLIC_ADDRESS_FROM_NAME === 'true';
const ingressNodes = (process.env.TUG_INGRESS_NODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const nodes = (process.env.TUG_NODES || 'vps-a,vps-b,vps-c')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function request(path, body) {
  const res = await fetch(`${control}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

let ready = false;
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(`${control}/healthz`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!ready) throw new Error(`control did not become ready at ${control}`);

await fs.mkdir(tokenDir, { recursive: true });
for (const name of nodes) {
  const result = await request('/api/v1/nodes/register', {
    name,
    address: name,
    publicAddress: publicFromName ? name : undefined,
  });
  await fs.writeFile(
    `${tokenDir}/${name}.env`,
    `export TUG_AGENT_TOKEN=${result.agentToken}\nexport TUG_REGISTRY_TOKEN=${result.registryToken}\n`,
    { mode: 0o600 },
  );
  if (ingressNodes.includes(name))
    await request(`/api/v1/nodes/${name}/ingress`, { enabled: true });
  console.log(`registered ${name}`);
}
