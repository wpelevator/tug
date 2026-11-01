#!/usr/bin/env node
// Runs in the runtime image next to control. It waits for control's CA, issues the root credential on the control
// host (control-credential, sharing control's data volume), then registers every fake VPS the way `node-install`
// does: the node's own `agent identity` makes the key and CSR, the identity endpoint signs it and `agent install-cert`
// installs the result into /tokens/<node>, which the fake VPS copies into its state volume.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { api, parseCredential } from './mtls-fetch.js';

const control = process.env.TUG_CONTROL_URL || 'https://control:8443';
const dataDir = process.env.TUG_DATA_DIR || '/data';
const identityDir = process.env.TUG_TOKEN_DIR || '/tokens';
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

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
for (let i = 0; i < 120 && !(await exists(`${dataDir}/pki/ca.crt`)); i++)
  await new Promise((r) => setTimeout(r, 1000));
if (!(await exists(`${dataDir}/pki/ca.crt`))) throw new Error('control did not create its CA');

await fs.mkdir(identityDir, { recursive: true });
const rootFile = `${identityDir}/root.credential.json`;
if (!(await exists(rootFile))) {
  const issued = execFileSync(
    'node',
    ['dist/main.js', 'control', 'issue-credential', '--name', 'root', '--role', 'admin'],
    {
      encoding: 'utf8',
      env: { ...process.env, TUG_DATA_DIR: dataDir },
    },
  );
  await fs.writeFile(rootFile, issued.trim(), { mode: 0o600 });
}
const root = parseCredential(await fs.readFile(rootFile, 'utf8'));

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

for (const name of nodes) {
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
      address: name,
      publicAddress: publicFromName ? name : undefined,
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
