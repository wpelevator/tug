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

/** Untyped JSON body of a fetch response; tests assert on the shape themselves. */
export const json = (res: Response): Promise<any> => res.json();

/** Unrelated control tests keep their display image fixtures without network access. Pinning is covered separately. */
export const testImageResolver = async (image: string): Promise<string> => image;

process.env.TUG_PUBLIC_URL ||= 'https://127.0.0.1:8443';

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
            publicAddress: body.publicAddress,
            labels: body.labels,
          }),
        },
      );
    // Registering a known name again installs a new key, as the old upsert rotated the token.
    let res = await identity('create');
    if (res.status === 409) res = await identity('replace');
    if (!res.ok) return res;
    const out = (await res.json()) as { node: { id: string } };
    if (body.wgPublicKey)
      await realFetch(url.replace('/api/v1/nodes/register', '/agent/v1/wireguard/key'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tug-test-node': out.node.id },
        body: JSON.stringify({ publicKey: body.wgPublicKey }),
      });
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
  process.env.TUG_PUBLIC_URL = 'https://localhost:8443';
  const { createApp, listen } = await import('../src/control.ts');
  const { issueHostCredential } = await import('../src/control-credential.ts');
  const { createTransport } = await import('../src/agent-credential.ts');
  const app = await createApp({ images: { resolve: testImageResolver }, ...options });
  const server = await listen(app, 0);
  const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = decodeCredential(
    await issueHostCredential({ name: 'root', role: 'admin', replace: false }),
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
