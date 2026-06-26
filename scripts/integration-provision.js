#!/usr/bin/env node
import fs from 'node:fs/promises';

const control = process.env.LAUNCHPAD_CONTROL_URL || 'http://control:8080';
const token = process.env.LAUNCHPAD_TOKEN || 'integration-token';
const tokenDir = process.env.LAUNCHPAD_TOKEN_DIR || '/tokens';
const nodes = (process.env.LAUNCHPAD_NODES || 'vps-a,vps-b,vps-c').split(',').map(s => s.trim()).filter(Boolean);

async function request(path, body) {
  const res = await fetch(`${control}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

let ready = false;
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(`${control}/healthz`);
    if (res.ok) { ready = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 1000));
}
if (!ready) throw new Error(`control did not become ready at ${control}`);

await fs.mkdir(tokenDir, { recursive: true });
for (const name of nodes) {
  const result = await request('/api/v1/nodes/register', { name, address: name });
  await fs.writeFile(`${tokenDir}/${name}.env`, `export LAUNCHPAD_AGENT_TOKEN=${result.agentToken}\nexport LAUNCHPAD_REGISTRY_TOKEN=${result.registryToken}\n`, { mode: 0o600 });
  console.log(`registered ${name}`);
}
