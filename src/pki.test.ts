import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import {
  Pki,
  BACKDATE_MS,
  certKeyHash,
  clientTlsOptions,
  controlNameFromCa,
  createCsr,
  decodeCredential,
  encodeCredential,
  generateKeyPair,
  identityUri,
  parseIdentityUri,
  peerIdentity,
  serverNames,
  validateInstalledCertificate,
  verifyCsr,
  writeFileDurable,
} from './pki.ts';
import { serverTlsOptions } from './tls-server.ts';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tug-pki-'));
}

test('CA is created once, reloaded, and fails closed when material is missing or corrupt', async () => {
  const dir = await tmp();
  const first = await Pki.load(dir, true);
  const again = await Pki.load(dir, false);
  assert.equal(again.caFingerprint, first.caFingerprint, 'reloading must keep the same CA');
  assert.equal(
    (await fs.stat(path.join(dir, 'ca.key'))).mode & 0o777,
    0o600,
    'ca.key must be 0600',
  );
  await fs.rm(path.join(dir, 'ca.crt'));
  await assert.rejects(
    Pki.load(dir, true),
    /incomplete CA/,
    'a half-present CA must not be recreated',
  );
  const empty = await tmp();
  await assert.rejects(
    Pki.load(empty, false),
    /CA is missing/,
    'existing state without a CA must fail closed',
  );
  await fs.writeFile(path.join(empty, 'ca.key'), 'junk');
  await fs.writeFile(path.join(empty, 'ca.crt'), 'junk');
  await assert.rejects(Pki.load(empty, true), /corrupt CA/, 'corrupt CA material must fail closed');
});

test('CSR signing assigns the profile and ignores requester-supplied fields', async () => {
  const pki = await Pki.load(await tmp(), true);
  const keys = await generateKeyPair();
  const csr = await createCsr(keys.privateKeyPem);
  const uri = identityUri('node', 'n1');
  const signed = await pki.signClientCsr(csr, uri, 90 * 86_400_000);
  const cert = new crypto.X509Certificate(signed.cert);
  assert.equal(cert.ca, false, 'leaf certificates must not be CAs');
  assert.equal(cert.subjectAltName, `URI:${uri}`, 'the SAN must be exactly the assigned identity');
  assert.deepEqual(
    cert.keyUsage,
    ['1.3.6.1.5.5.7.3.2'],
    'client certificates carry only clientAuth',
  );
  assert.ok(
    cert.verify(new crypto.X509Certificate(pki.caPem).publicKey),
    'the leaf must chain to the CA',
  );
  assert.ok(
    Date.parse(cert.validFrom) <= Date.now() - BACKDATE_MS + 5_000,
    'notBefore must be back-dated five minutes',
  );
  assert.equal(
    signed.keyHash,
    certKeyHash(signed.cert),
    'key hash must be the certificate key hash',
  );
  const other = await pki.signClientCsr(csr, uri, 1000);
  assert.notEqual(other.cert, signed.cert, 'serials must be unique per certificate');
  assert.equal(other.keyHash, signed.keyHash, 'several certificates share one key hash');
  validateInstalledCertificate({
    cert: signed.cert,
    ca: pki.caPem,
    keyPem: keys.privateKeyPem,
    uri,
  });
  assert.throws(
    () =>
      validateInstalledCertificate({
        cert: signed.cert,
        ca: pki.caPem,
        keyPem: keys.privateKeyPem,
        uri: identityUri('node', 'n2'),
      }),
    /does not name/,
    'a certificate for another node must be rejected at install',
  );
  const capped = await pki.signClientCsr(csr, uri, 10_000 * 86_400_000);
  assert.ok(
    new Date(new crypto.X509Certificate(capped.cert).validTo) <= pki.caNotAfter,
    'validity is capped by the CA',
  );
});

test('CSR verification rejects bad signatures and unsupported keys', async () => {
  const keys = await generateKeyPair();
  const csr = await createCsr(keys.privateKeyPem);
  const tampered = Buffer.from(csr.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  tampered[tampered.length - 3] ^= 0xff;
  const bad = `-----BEGIN CERTIFICATE REQUEST-----\n${tampered.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`;
  await assert.rejects(verifyCsr(bad), /./, 'a tampered CSR must be rejected');
  await assert.rejects(verifyCsr('nope'), /valid PKCS#10/, 'garbage is not a CSR');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(await tmp(), 'rsa.key');
  await fs.writeFile(keyFile, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const rsaCsr = execFileSync('openssl', [
    'req',
    '-new',
    '-key',
    keyFile,
    '-subj',
    '/CN=x',
  ]).toString();
  await assert.rejects(verifyCsr(rsaCsr), /P-256/, 'non P-256 keys must be rejected');
});

test('credentials round-trip and reject mismatched keys', async () => {
  const pki = await Pki.load(await tmp(), true);
  const { credential } = await pki.issueClient(
    identityUri('operator', 'o1'),
    86_400_000,
    'https://control.example:8443',
  );
  assert.deepEqual(
    decodeCredential(encodeCredential(credential)),
    credential,
    'base64url round trip',
  );
  const other = await generateKeyPair();
  assert.throws(
    () => decodeCredential(JSON.stringify({ ...credential, key: other.privateKeyPem })),
    /does not match/,
  );
  assert.throws(
    () => decodeCredential(JSON.stringify({ ...credential, url: 'http://x:1' })),
    /https origin/,
  );
  assert.deepEqual(parseIdentityUri('tug:enroll:abc'), { klass: 'enroll', id: 'abc' });
  assert.equal(parseIdentityUri('tug:root:abc'), null, 'unknown classes are not identities');
});

test('durable writes replace the file and leave no temporary files', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'agent.json');
  await writeFileDurable(file, 'one');
  await writeFileDurable(file, 'two');
  assert.equal(await fs.readFile(file, 'utf8'), 'two');
  assert.deepEqual(await fs.readdir(dir), ['agent.json'], 'temporary files must be cleaned up');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'credential files must be 0600');
});

async function mtlsServer(pki: Pki, names = serverNames('https://localhost:8443')) {
  const server = await pki.issueServer(names);
  const seen: { identity: ReturnType<typeof peerIdentity>; reused: boolean }[] = [];
  const srv = https.createServer(
    serverTlsOptions({ cert: server.cert, key: server.key, ca: pki.caPem }),
    (req, res) => {
      res.end('ok');
    },
  );
  srv.on('secureConnection', (socket) =>
    seen.push({ identity: peerIdentity(socket), reused: socket.isSessionReused() }),
  );
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: (srv.address() as AddressInfo).port, seen };
}
const connect = (options: tls.ConnectionOptions & { port: number }) =>
  new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', ...options }, () => resolve(s));
    s.on('error', reject);
  });

test('mTLS: a CA-signed client connects; missing, foreign-CA and plain clients fail', async () => {
  const pki = await Pki.load(await tmp(), true);
  const { srv, port, seen } = await mtlsServer(pki);
  try {
    const client = await pki.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://localhost:8443',
    );
    const ok = await connect({ port, ...clientTlsOptions(client.credential) });
    await new Promise((r) => setTimeout(r, 100));
    ok.destroy();
    assert.equal(
      seen[0].identity?.uri,
      'tug:operator:o1',
      'the server must read the identity from the certificate',
    );
    assert.equal(
      seen[0].identity?.keyHash,
      client.keyHash,
      'the server must derive the key hash of the presented key',
    );

    const bare = tls.connect({ host: '127.0.0.1', port, ca: pki.caPem, servername: 'localhost' });
    await new Promise((resolve) => {
      bare.on('error', resolve);
      bare.on('close', resolve);
      bare.on('secureConnect', () => bare.write('GET / HTTP/1.1\r\n\r\n'));
    });
    const foreign = await Pki.load(await tmp(), true);
    const alien = await foreign.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://localhost:8443',
    );
    await assert.rejects(
      async () => {
        const s = await connect({
          port,
          ...clientTlsOptions({ ...alien.credential, ca: pki.caPem }),
        });
        s.write('x');
        await new Promise((resolve, reject) => {
          s.on('error', reject);
          s.on('close', () => reject(new Error('closed')));
        });
      },
      /handshake|closed|certificate|ECONN|alert/i,
      'a certificate from another CA must fail the handshake',
    );
    assert.equal(seen.length, 1, 'failed handshakes must never reach the connection gate');
  } finally {
    srv.close();
  }
});

test('mTLS: session resumption is refused so every connection presents its certificate', async () => {
  const pki = await Pki.load(await tmp(), true);
  const { srv, port, seen } = await mtlsServer(pki);
  try {
    const client = await pki.issueClient(
      identityUri('node', 'n1'),
      86_400_000,
      'https://localhost:8443',
    );
    const options = { port, ...clientTlsOptions(client.credential) };
    const first = await connect(options);
    await new Promise((r) => setTimeout(r, 100));
    const session = first.getSession();
    first.destroy();
    assert.equal(seen.length, 1, 'the first connection must reach the gate');
    const second = await connect({ ...options, session });
    assert.equal(second.isSessionReused(), false, 'the client must not manage to resume');
    await new Promise((r) => setTimeout(r, 100));
    second.destroy();
    assert.ok(
      seen.every((s) => !s.reused),
      'the server must never see a reused session',
    );
  } finally {
    srv.close();
  }
});

test('mTLS: clients verify the generated control name, so the address in a credential never matters', async () => {
  const pki = await Pki.load(await tmp(), true);
  assert.match(
    pki.controlName,
    /^control-[0-9a-f]{12}\.tug$/,
    'the name is generated from the CA key',
  );
  assert.equal(
    controlNameFromCa(pki.caPem),
    pki.controlName,
    'clients recompute the same name from the CA',
  );
  const { srv, port } = await mtlsServer(pki, serverNames('https://old-address.example:8443'));
  try {
    const client = await pki.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://old-address.example:8443',
    );
    (await connect({ port, ...clientTlsOptions(client.credential) })).destroy();
    (
      await connect({
        port,
        ...clientTlsOptions({ ...client.credential, url: 'https://moved.example:9443' }),
      })
    ).destroy();
  } finally {
    srv.close();
  }
});

test('mTLS: a server certificate without the control name is refused, even for the right address', async () => {
  const pki = await Pki.load(await tmp(), true);
  const keys = await generateKeyPair();
  const impostor = await pki.signLeaf({
    publicKey: keys.publicKey,
    kind: 'server',
    names: { dns: ['localhost'], ip: ['127.0.0.1'] },
    lifetimeMs: 86_400_000,
  });
  const srv = https.createServer(
    serverTlsOptions({ cert: impostor.cert, key: keys.privateKeyPem, ca: pki.caPem }),
    (_req, res) => res.end('ok'),
  );
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const client = await pki.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://localhost:1',
    );
    await assert.rejects(
      connect({
        port: (srv.address() as AddressInfo).port,
        ...clientTlsOptions(client.credential),
      }),
      /./,
      'a certificate that does not carry the control name must fail verification',
    );
  } finally {
    srv.close();
  }
});

test('IP public URLs get IP SANs and verify without SNI', async () => {
  const pki = await Pki.load(await tmp(), true);
  const { srv, port } = await mtlsServer(
    pki,
    serverNames('https://127.0.0.1:8443', ['control.internal']),
  );
  try {
    const client = await pki.issueClient(
      identityUri('operator', 'o1'),
      86_400_000,
      'https://127.0.0.1:8443',
    );
    (await connect({ port, ...clientTlsOptions(client.credential) })).destroy();
  } finally {
    srv.close();
  }
});
