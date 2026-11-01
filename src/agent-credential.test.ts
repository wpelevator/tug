import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  agentFile,
  agentIdentityCsr,
  createTransport,
  installIdentity,
  loadAgentDocument,
  pendingFile,
  renewCertificate,
} from './agent-credential.ts';
import { NODE_LIFETIME_MS, Pki, certKeyHash, identityUri, serverNames, verifyCsr } from './pki.ts';
import type { IdentityResponse } from './protocol.ts';
import { serverTlsOptions } from './tls-server.ts';

const crash = () => {
  throw new Error('simulated crash');
};

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-state-'));
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-pki-')), true);
  const csr = await agentIdentityCsr(dir);
  const sign = async (): Promise<IdentityResponse> => {
    const signed = await pki.signClientCsr(csr, identityUri('node', 'n1'), NODE_LIFETIME_MS);
    return {
      node: { id: 'n1', name: 'n1' } as IdentityResponse['node'],
      certificate: signed.cert,
      ca: pki.caPem,
      url: 'https://control.test:8443',
    };
  };
  return { dir, pki, csr, sign };
}

test('identity: repeating `agent identity` returns the same CSR and keeps one private key', async () => {
  const s = await setup();
  assert.equal(
    (await verifyCsr(await agentIdentityCsr(s.dir))).keyHash,
    (await verifyCsr(s.csr)).keyHash,
    'the pending key is reused',
  );
  assert.equal(
    (await fs.stat(pendingFile(s.dir))).mode & 0o777,
    0o600,
    'the pending key file must be 0600',
  );
});

test('install-cert: a crash before the rename leaves no identity and a rerun recovers', async () => {
  const s = await setup();
  const response = await s.sign();
  await assert.rejects(installIdentity(s.dir, response, { afterFlush: crash }), /simulated crash/);
  assert.equal(
    await loadAgentDocument(s.dir),
    null,
    'no half-written identity may be visible after the crash',
  );
  assert.deepEqual(
    (await fs.readdir(s.dir)).filter((f) => f.endsWith('.tmp')),
    [],
    'a failed write must clean up its temporary file',
  );
  const doc = await installIdentity(s.dir, response);
  assert.equal(doc.nodeId, 'n1', 'rerunning the command installs the identity');
  assert.equal((await fs.stat(agentFile(s.dir))).mode & 0o777, 0o600, 'agent.json must be 0600');
  await assert.rejects(fs.stat(pendingFile(s.dir)), 'the pending key is removed once installed');
});

test('install-cert: a crash after the rename leaves a complete matching bundle', async () => {
  const s = await setup();
  const response = await s.sign();
  await assert.rejects(installIdentity(s.dir, response, { afterRename: crash }), /simulated crash/);
  const doc = await loadAgentDocument(s.dir);
  assert.ok(doc, 'the renamed identity is complete');
  assert.equal(
    certKeyHash(doc.cert),
    certKeyHash(response.certificate),
    'certificate and key stay paired',
  );
  assert.ok(
    (await fs.stat(pendingFile(s.dir)).catch(() => null)) !== null,
    'the pending key survives until install finishes',
  );
  const again = await installIdentity(s.dir, response);
  assert.equal(again.cert, doc.cert, 'rerunning after the crash is idempotent');
});

test('install-cert refuses a certificate for another node, another key or another CA', async () => {
  const s = await setup();
  const response = await s.sign();
  await assert.rejects(
    installIdentity(s.dir, {
      ...response,
      node: { id: 'n2', name: 'n2' } as IdentityResponse['node'],
    }),
    /does not name/,
    'a certificate for another node must not be installed',
  );
  const other = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-other-ca-')), true);
  await assert.rejects(
    installIdentity(s.dir, { ...response, ca: other.caPem }),
    /not signed by the supplied CA/,
    'a certificate that does not chain to the supplied CA must not be installed',
  );
  assert.equal(await loadAgentDocument(s.dir), null, 'nothing is installed after refusals');
});

test('renewal: a crash keeps the previous identity usable; a completed renewal keeps the same key', async () => {
  const s = await setup();
  const first = await installIdentity(s.dir, await s.sign());
  const post = async (csr: string) => {
    const signed = await s.pki.signClientCsr(csr, identityUri('node', 'n1'), NODE_LIFETIME_MS);
    return { certificate: signed.cert };
  };
  await assert.rejects(
    renewCertificate(s.dir, first, post, { afterFlush: crash }),
    /simulated crash/,
  );
  assert.equal(
    (await loadAgentDocument(s.dir))?.cert,
    first.cert,
    'a crash before the rename keeps the old certificate',
  );
  await assert.rejects(
    renewCertificate(s.dir, first, post, { afterRename: crash }),
    /simulated crash/,
  );
  const renewed = await loadAgentDocument(s.dir);
  assert.notEqual(
    renewed?.cert,
    first.cert,
    'a crash after the rename leaves the new certificate in place',
  );
  assert.equal(renewed?.key, first.key, 'renewal never changes the key');
  assert.equal(
    certKeyHash(renewed!.cert),
    certKeyHash(first.cert),
    'old and new certificates share one key hash',
  );
  await assert.rejects(
    renewCertificate(s.dir, first, async () => ({
      certificate: (await s.sign()).certificate.replace(/A/g, 'B'),
    })),
    /./,
    'a corrupt or foreign response must not replace the identity',
  );
});

test('a failed renewal response never overwrites the identity', async () => {
  const s = await setup();
  const first = await installIdentity(s.dir, await s.sign());
  await assert.rejects(
    renewCertificate(s.dir, first, async () => Promise.reject(new Error('network down'))),
    /network down/,
  );
  assert.equal(
    (await loadAgentDocument(s.dir))?.cert,
    first.cert,
    'the old identity keeps working',
  );
});

test('corrupt state produces a diagnostic that points to node-repair-identity', async () => {
  const s = await setup();
  await fs.writeFile(agentFile(s.dir), '{not json');
  await assert.rejects(
    loadAgentDocument(s.dir),
    /node-repair-identity/,
    'corrupt agent.json is never silently replaced',
  );
  await fs.writeFile(agentFile(s.dir), JSON.stringify({ v: 1 }));
  await assert.rejects(
    loadAgentDocument(s.dir),
    /node-repair-identity/,
    'an incomplete document is reported, not ignored',
  );
});

test('multipart bodies from the global FormData reach an mTLS server intact', async () => {
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-form-')), true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  let seen = '';
  let type = '';
  const server = https.createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: pki.caPem }),
    (req, res) => {
      type = String(req.headers['content-type']);
      req.on('data', (c) => (seen += c));
      req.on('end', () => res.end('{}'));
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = await pki.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://localhost:8443',
    );
    const transport = createTransport(
      client.credential,
      `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    const form = new FormData();
    form.append('payload', '{"project":"site"}');
    form.append('file', new Blob(['hello']), 'a.txt');
    const res = await transport.http(`${transport.base}/api/v1/deployments`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    assert.match(type, /^multipart\/form-data; boundary=/, 'the multipart boundary must be sent');
    assert.ok(
      seen.includes('{"project":"site"}') && seen.includes('hello'),
      'fields and file contents must arrive',
    );
    void transport.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
