import { X509Certificate } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db } from '../src/db.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Pki,
  certKeyHash,
  createCsr,
  decodeCredential,
  generateKeyPair,
  identityUri,
} from '../src/pki.ts';
import type { Credential } from '../src/pki.ts';
import type { ComposeFile } from '../src/protocol.ts';

/** Explicit fixture setup: grant only the registered nodes and valid ingress hosts requested by a test Compose file. */
export async function grantProjectFixture(
  base: string,
  project: string,
  compose: ComposeFile,
): Promise<void> {
  const headers = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
  const list = await fetch(`${base}/api/v1/nodes`, { headers });
  if (!list.ok) throw new Error(`cannot list fixture nodes: ${list.status}`);
  const { nodes: known } = (await list.json()) as {
    nodes: { name: string; labels: string[]; disabled_at: string | null }[];
  };
  const active = known.filter((node) => !node.disabled_at);
  const prior = await fetch(`${base}/api/v1/projects/${encodeURIComponent(project)}/policy`, {
    headers,
  });
  const old = prior.ok
    ? ((await prior.json()) as { nodes: string[]; ingressHosts: string[] })
    : { nodes: [], ingressHosts: [] };
  const nodes = new Set(old.nodes);
  const hosts = new Set(old.ingressHosts);
  for (const service of Object.values(compose?.services || {})) {
    const placement = service['x-tug']?.placement;
    if (placement?.nodes?.length) {
      for (const name of placement.nodes)
        if (active.some((node) => node.name === name)) nodes.add(name);
    } else if (placement?.labels?.length || service['x-tug']?.global) {
      for (const node of active)
        if ((placement?.labels || []).every((label) => node.labels.includes(label)))
          nodes.add(node.name);
    } else if (active[0]) nodes.add(active[0].name);
    const host = service['x-tug']?.ingress?.host;
    if (
      typeof host === 'string' &&
      /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)
    )
      hosts.add(host.toLowerCase());
  }
  for (const volume of Object.values(compose?.volumes || {}))
    for (const name of volume['x-tug']?.placement?.nodes || [])
      if (active.some((node) => node.name === name)) nodes.add(name);
  const response = await fetch(`${base}/api/v1/projects/${encodeURIComponent(project)}/policy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nodes: [...nodes], ingressHosts: [...hosts] }),
  });
  if (!response.ok)
    throw new Error(`cannot set fixture policy: ${response.status} ${await response.text()}`);
}

/** Untyped JSON body of a fetch response; tests assert on the shape themselves. */
export const json = (res: Response): Promise<any> => res.json();

/** Unrelated control tests keep their display image fixtures without network access. Pinning is covered separately. */
export const testImageResolver = async (image: string): Promise<string> => image;

/** Passed to `createApp` so tests never touch TUG_CONTROL_URL, which CLI subprocesses read as a connect override. */
export const testControlUrl = 'https://127.0.0.1:8443';

/**
 * In-process stand-in for the TLS peer certificate, so HTTP-level tests can skip TLS. Real certificates, key hashes and
 * the handshake are covered by pki.test.ts and control.mtls.test.ts. The principal still resolves against the database.
 */
export const testIdentity = (
  req: IncomingMessage,
  db: Db,
): { uri: string; keyHash: string } | null => {
  const h = req.headers;
  const credential = h['x-tug-test-credential'];
  if (typeof credential === 'string') {
    try {
      const c = decodeCredential(credential);
      return {
        uri: (new X509Certificate(c.cert).subjectAltName ?? '').replace(/^URI:/, ''),
        keyHash: certKeyHash(c.cert),
      };
    } catch {
      return null; // an unparseable credential presents no identity
    }
  }
  const node = h['x-tug-test-node'];
  if (typeof node === 'string') {
    // Tests name a node by its name or its ID; the certificate identity always carries the immutable ID.
    const row = db.get<{ id: string; key_hash: string }>(
      'SELECT id,key_hash FROM nodes WHERE id=? OR name=?',
      node,
      node,
    );
    return { uri: `tug:node:${row?.id ?? node}`, keyHash: row?.key_hash ?? 'unknown' };
  }
  const enroll = h['x-tug-test-enroll'];
  if (typeof enroll === 'string') {
    const row = db.get<{ key_hash: string }>(
      'SELECT key_hash FROM enrollment_credentials WHERE id=?',
      enroll,
    );
    return { uri: `tug:enroll:${enroll}`, keyHash: row?.key_hash ?? 'unknown' };
  }
  const operator = h['x-tug-test-operator'];
  if (typeof operator === 'string') {
    const credentialId = `cred_test_${operator}`;
    if (!db.get('SELECT 1 FROM operator_credentials WHERE id=?', credentialId))
      db.run(
        "INSERT INTO operator_credentials(id,name,key_hash,role,created_at,created_by) VALUES(?,?,?,'admin',?,'test')",
        credentialId,
        operator,
        `test-${operator}`,
        new Date().toISOString(),
      );
    return { uri: `tug:operator:${credentialId}`, keyHash: `test-${operator}` };
  }
  return null;
};

/**
 * Old tests register nodes with `POST /api/v1/nodes/register { name }`. Keep that call shape by generating a key and CSR
 * the way a node would and posting it to the identity endpoint; `nodeId` is the node ID, which `x-tug-test-node` takes.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (init?.method === 'POST' && url.endsWith('/api/v1/nodes/register')) {
    const body = JSON.parse(String(init.body));
    const keys = await generateKeyPair();
    const csr = await createCsr(keys.privateKeyPem);
    const identity = (mode: string) =>
      realFetch(
        url.replace('/nodes/register', `/nodes/${encodeURIComponent(body.name)}/identity`),
        {
          ...init,
          body: JSON.stringify({
            csr,
            mode,
            address: body.address,
            labels: body.labels,
          }),
        },
      );
    // Registering a known name again installs a new key, as the old upsert rotated the token.
    let res = await identity('create');
    if (res.status === 409) res = await identity('replace');
    if (!res.ok) return res;
    const out = (await res.json()) as { node: { id: string } };
    return new Response(JSON.stringify({ ...out, nodeId: out.node.id }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

/** Writes a real credential document (own CA, operator identity) for tests that only need a valid file. */
export async function writeCredentialFile(
  file: string,
  url = 'https://control.test:8443',
): Promise<Credential> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cred-'));
  const pki = await Pki.load(dir, true);
  const { credential } = await pki.issueClient(identityUri('operator', 'o1'), 86_400_000, url);
  await fs.writeFile(file, JSON.stringify(credential), { mode: 0o600 });
  return credential;
}

/**
 * A real mTLS control for tests that run the CLI as a subprocess. `env` carries the root credential and the loopback
 * connect target; the credential's public URL (`https://localhost:8443`) is what the CLI verifies.
 */
export async function startMtlsControl(
  dir: string,
  options: { eventPruneIntervalMs?: number } = {},
) {
  process.env.TUG_DATA_DIR = dir;
  const { createApp, listen } = await import('../src/control.ts');
  const { issueHostCredential } = await import('../src/control-credential.ts');
  const { createTransport } = await import('../src/agent-credential.ts');
  const controlUrl = 'https://localhost:8443';
  const app = await createApp({ images: { resolve: testImageResolver }, controlUrl, ...options });
  const server = await listen(app, 0);
  const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = decodeCredential(
    await issueHostCredential({ name: 'root', role: 'admin', replace: false, controlUrl }),
  );
  const credentialFile = path.join(dir, 'root.credential.json');
  await fs.writeFile(credentialFile, JSON.stringify(root), { mode: 0o600 });
  /** Registers a node the way `node-install` does and returns its credential. */
  const registerNode = async (name: string) => {
    const keys = await generateKeyPair();
    const transport = createTransport(root, url);
    try {
      const res = await transport.http(`${transport.base}/api/v1/nodes/${name}/identity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csr: await createCsr(keys.privateKeyPem), mode: 'create' }),
      });
      return { status: res.status, body: (await res.json()) as any };
    } finally {
      void transport.close();
    }
  };
  return {
    app,
    url,
    root,
    credentialFile,
    env: { TUG_CONTROL_URL: url, TUG_CREDENTIAL_FILE: credentialFile, TUG_CONFIG: '' },
    registerNode,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
