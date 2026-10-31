#!/usr/bin/env node
const control = process.env.TUG_CONTROL_URL || 'http://localhost:18080';
const operatorToken = process.env.TUG_TOKEN || 'integration-token';
const registryUrl = process.env.TUG_REGISTRY_URL || 'http://localhost:15000';
const node = process.env.TUG_VERIFY_NODE || 'vps-a';

async function controlPost(route) {
  const res = await fetch(`${control}${route}`, { method: 'POST', headers: { authorization: `Bearer ${operatorToken}` } });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return res.json();
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function registryStatus(username, password) {
  const res = await fetch(`${registryUrl}/v2/`, { headers: { authorization: basicAuth(username, password) } });
  return res.status;
}

async function waitForRegistry(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${registryUrl}/v2/`);
      if (res.status === 401 || res.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`registry at ${registryUrl} did not become reachable`);
}

await waitForRegistry();

const rotated = await controlPost(`/api/v1/nodes/${encodeURIComponent(node)}/rotate-registry-token`);
const validToken = rotated.registryToken;
await waitForRegistry();

const validStatus = await registryStatus(node, validToken);
if (validStatus !== 200) throw new Error(`expected 200 for valid registry credentials, got ${validStatus}`);
console.log(`ok: ${node} authenticates against registry with rotated token`);

const wrongStatus = await registryStatus(node, 'not-the-token');
if (wrongStatus !== 401) throw new Error(`expected 401 for invalid registry credentials, got ${wrongStatus}`);
console.log(`ok: ${node} is rejected with an invalid registry password`);

await controlPost(`/api/v1/nodes/${encodeURIComponent(node)}/revoke-registry-token`);
await waitForRegistry();

const revokedStatus = await registryStatus(node, validToken);
if (revokedStatus !== 401) throw new Error(`expected 401 after revoking registry token, got ${revokedStatus}`);
console.log(`ok: ${node} is rejected after registry token revocation`);

console.log('registry auth verification passed');
