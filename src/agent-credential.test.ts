import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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

test('corrupt state produces a diagnostic that points to node repair', async () => {
  const s = await setup();
  await fs.writeFile(agentFile(s.dir), '{not json');
  await assert.rejects(
    loadAgentDocument(s.dir),
    /node repair/,
    'corrupt agent.json is never silently replaced',
  );
  await fs.writeFile(agentFile(s.dir), JSON.stringify({ v: 1 }));
  await assert.rejects(
    loadAgentDocument(s.dir),
    /node repair/,
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

test('the client version header goes to the control only, never to other origins the client dials', async () => {
  const pki = await Pki.load(await fs.mkdtemp(path.join(os.tmpdir(), 'tug-hdr-')), true);
  const issued = await pki.issueServer(serverNames('https://localhost:8443'));
  const seen: Record<string, string | undefined> = {};
  const control = https.createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: pki.caPem }),
    (req, res) => {
      seen.control = req.headers['x-tug-client-version'] as string | undefined;
      res.end('{}');
    },
  );
  const app = http.createServer((req, res) => {
    seen.app = req.headers['x-tug-client-version'] as string | undefined;
    res.end('ok');
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  try {
    const client = await pki.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://localhost:8443',
    );
    const transport = createTransport(
      client.credential,
      `https://127.0.0.1:${(control.address() as AddressInfo).port}`,
    );
    await transport.http(`${transport.base}/api/v1/status`);
    await transport.http(`http://127.0.0.1:${(app.address() as AddressInfo).port}/health`);
    void transport.close();
    assert.ok(seen.control, 'requests to the control declare the client version');
    assert.equal(
      seen.app,
      undefined,
      'an application container health check must not learn the Tug version',
    );
  } finally {
    control.closeAllConnections();
    control.close();
    app.close();
  }
});

/** An enrolled agent: the pending key was signed and installed, which removes the pending file. */
async function enrolled(name = 'n1') {
  const s = await setup();
  const signed = await s.pki.signClientCsr(s.csr, identityUri('node', name), NODE_LIFETIME_MS);
  const doc = await installIdentity(s.dir, {
    node: { id: name, name } as IdentityResponse['node'],
    certificate: signed.cert,
    ca: s.pki.caPem,
    url: 'https://control.test:8443',
  });
  return { ...s, doc };
}

test('identity --current on an agent enrolled as that node reuses the installed key', async () => {
  const s = await enrolled('n1');
  const csr = await agentIdentityCsr(s.dir, { current: 'n1' });
  assert.equal(
    (await verifyCsr(csr)).keyHash,
    certKeyHash(s.doc.cert),
    'the CSR must carry the installed key so control treats node add as an idempotent retry',
  );
  const signed = await s.pki.signClientCsr(csr, identityUri('node', 'n1'), NODE_LIFETIME_MS);
  const upgraded = await installIdentity(s.dir, {
    node: { id: 'n1', name: 'n1' } as IdentityResponse['node'],
    certificate: signed.cert,
    ca: s.pki.caPem,
    url: 'https://control.test:8443',
  });
  assert.equal(upgraded.key, s.doc.key, 'install-cert keeps the same private key');
  assert.notEqual(upgraded.cert, s.doc.cert, 'and installs the freshly signed certificate');
  await assert.rejects(fs.stat(pendingFile(s.dir)), 'the pending key is removed after the install');
});

test('identity without --current on an enrolled agent generates a new key, so replace rotates it', async () => {
  const s = await enrolled('n1');
  assert.notEqual(
    (await verifyCsr(await agentIdentityCsr(s.dir))).keyHash,
    certKeyHash(s.doc.cert),
    'node replace must be able to install a different key',
  );
});

test('identity --current refuses an agent enrolled as another node and leaves it untouched', async () => {
  const s = await enrolled('n1');
  await assert.rejects(
    agentIdentityCsr(s.dir, { current: 'n2' }),
    /enrolled as node n1, not n2.*tug node replace n1/,
    'two nodes must never share a key, so adding another name on an enrolled host is refused with the remedy',
  );
  assert.equal(
    (await loadAgentDocument(s.dir))?.key,
    s.doc.key,
    'a refused request must not change the installed identity',
  );
});

test('identity --current on a host with no installed identity behaves like a first enrollment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-fresh-'));
  const first = await agentIdentityCsr(dir, { current: 'n1' });
  assert.equal(
    (await verifyCsr(await agentIdentityCsr(dir, { current: 'n1' }))).keyHash,
    (await verifyCsr(first)).keyHash,
    'a fresh host generates one pending key and keeps reusing it',
  );
});
