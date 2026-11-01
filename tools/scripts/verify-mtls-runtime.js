#!/usr/bin/env node
// Runs against a built tree (npm run build first; inside the images it is /app/dist): exercises @peculiar/x509
// issuance and CSR verification, an mTLS listener with the production TLS options, and the undici transport pinned to
// the CA, including the loopback connect-target override that still verifies the public host name. Exits non-zero on
// any failure, so it doubles as the runtime-image check that the TLS dependencies work on Debian and Alpine.
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dist = new URL('../../dist/', import.meta.url).href;
const { Pki, serverNames, generateKeyPair, createCsr, identityUri, peerIdentity } = await import(
  `${dist}pki.js`
);
const { serverTlsOptions } = await import(`${dist}tls-server.js`);
const { createTransport } = await import(`${dist}agent-credential.js`);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-verify-'));
const results = [];
const check = async (name, fn) => {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.stack || e) });
  }
};

const pki = await Pki.load(dir, true);
const server = await pki.issueServer(serverNames('https://control.example.com:8443'));
const { credential } = await pki.issueClient(
  identityUri('operator', 'verify'),
  86_400_000,
  'https://control.example.com:8443',
);

const listener = https.createServer(
  serverTlsOptions({ cert: server.cert, key: server.key, ca: pki.caPem }),
  (req, res) => {
    const id = peerIdentity(req.socket);
    res.end(JSON.stringify({ uri: id?.uri, reused: req.socket.isSessionReused() }));
  },
);
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;

await check('csr round trip (WebCrypto P-256)', async () => {
  const keys = await generateKeyPair();
  const csr = await createCsr(keys.privateKeyPem);
  const signed = await pki.signClientCsr(csr, identityUri('node', 'node_x'), 86_400_000);
  return new crypto.X509Certificate(signed.cert).subjectAltName;
});

await check(
  'undici transport: mTLS with loopback connect override, public name verified',
  async () => {
    const t = createTransport(credential, `https://127.0.0.1:${port}`);
    try {
      const res = await t.http(`${t.base}/`);
      return await res.json();
    } finally {
      await t.close();
    }
  },
);

await check('undici transport: wrong public name is refused', async () => {
  const wrong = { ...credential, url: 'https://other.example.com:8443' };
  const t = createTransport(wrong, `https://127.0.0.1:${port}`);
  try {
    await t.http(`${t.base}/`);
    throw new Error('connection to a certificate for another name must fail');
  } catch (e) {
    if (String(e.message).startsWith('connection to')) throw e;
    return `refused: ${e.cause?.code || e.message}`;
  } finally {
    await t.close();
  }
});

await check('no client certificate fails the handshake', async () => {
  return await new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, ca: pki.caPem, servername: 'control.example.com' },
      () => reject(new Error('request without a client certificate was served')),
    );
    req.on('error', (e) => resolve(`refused: ${e.code || e.message}`));
    req.end();
  });
});

listener.close();
listener.closeAllConnections?.();
await fs.rm(dir, { recursive: true, force: true });
console.log(JSON.stringify({ node: process.version, arch: process.arch, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
