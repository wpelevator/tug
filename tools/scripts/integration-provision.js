#!/usr/bin/env node
// Runs in the runtime image next to control. It waits for control's CA, issues the root credential on the control
// host (control-credential, sharing control's data volume), then registers every fake VPS the way `tug node add`
// does: the node's own `agent identity` makes the key and CSR, the identity endpoint signs it and `agent install-cert`
// installs the result into /tokens/<node>, which the fake VPS copies into its state volume.
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import { api, parseCredential } from './mtls-fetch.js';

const control = process.env.TUG_CONTROL_URL || 'https://control:8443';
const dataDir = process.env.TUG_DATA_DIR || '/data';
const identityDir = process.env.TUG_TOKEN_DIR || '/tokens';
// Networking scenario: resolve Compose service names to numeric node addresses and mark ingress nodes.
const ingressNodes = (process.env.TUG_INGRESS_NODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const nodes = (process.env.TUG_NODES || 'vps-a,vps-b,vps-c')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Optional Compose DNS aliases in the same order, for a control node name that differs from its service name.
const dnsNames = (process.env.TUG_NODE_DNS_NAMES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (dnsNames.length && dnsNames.length !== nodes.length)
  throw new Error('TUG_NODE_DNS_NAMES must have one Compose DNS name per TUG_NODES entry');

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

async function resolveNodeAddress(name) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return (await lookup(name, { family: 4 })).address;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`could not resolve a numeric private address for ${name}`, { cause: lastError });
}

for (let i = 0; i < 120 && !(await exists(`${dataDir}/pki/ca.crt`)); i++)
  await new Promise((r) => setTimeout(r, 1000));
if (!(await exists(`${dataDir}/pki/ca.crt`))) throw new Error('control did not create its CA');

await fs.mkdir(identityDir, { recursive: true });
// The scripts treat root.credential.json as "the stack is ready", so it is published last, after every node is
// registered. Until then the credential lives in a pending file.
const rootFile = `${identityDir}/root.credential.json`;
const pendingFile = `${identityDir}/.root.credential.pending.json`;
if (!(await exists(pendingFile)) && !(await exists(rootFile))) {
  const issued = execFileSync(
    'node',
    ['dist/main.js', 'control', 'issue-credential', '--name', 'root', '--role', 'admin'],
    {
      encoding: 'utf8',
      env: { ...process.env, TUG_DATA_DIR: dataDir },
    },
  );
  await fs.writeFile(pendingFile, issued.trim(), { mode: 0o600 });
}
const root = parseCredential(
  await fs.readFile((await exists(pendingFile)) ? pendingFile : rootFile, 'utf8'),
);

let ready = false;
for (let i = 0; i < 120; i++) {
  try {
    await api(root, control, '/api/v1/status');
    ready = true;
    break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!ready) throw new Error(`control did not become ready at ${control}`);

for (const [index, name] of nodes.entries()) {
  const stateDir = `${identityDir}/${name}`;
  if (!(await exists(`${stateDir}/agent.json`))) {
    const env = { ...process.env, TUG_STATE_DIR: stateDir };
    const csr = execFileSync('node', ['dist/main.js', 'agent', 'identity'], {
      encoding: 'utf8',
      env,
    });
    const response = await api(root, control, `/api/v1/nodes/${name}/identity`, {
      csr,
      mode: 'create',
      address: await resolveNodeAddress(dnsNames[index] || name),
    });
    execFileSync('node', ['dist/main.js', 'agent', 'install-cert'], {
      input: JSON.stringify(response),
      env,
    });
  }
  if (ingressNodes.includes(name))
    await api(root, control, `/api/v1/nodes/${name}/ingress`, { enabled: true });
  console.log(`registered ${name}`);
}

// Publish the credential last: its presence now means every node above is registered.
if (await exists(pendingFile)) await fs.rename(pendingFile, rootFile);
console.log('ready');
