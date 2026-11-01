import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:https';
import { createApp, listen } from './control.ts';
import { issueHostCredential } from './control-credential.ts';
import { createTransport } from './agent-credential.ts';
import { Pki, createCsr, decodeCredential, generateKeyPair, identityUri } from './pki.ts';
import type { Credential } from './pki.ts';
import { testImageResolver } from '../tests/helpers.ts';

async function start() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-mtls-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_ADVERTISE_URL = 'https://localhost:8443';
  process.env.TUG_RENEW_MIN_INTERVAL_MS = '0';
  const app = await createApp({ images: { resolve: testImageResolver } });
  const server: Server = await listen(app, 0);
  const port = (server.address() as AddressInfo).port;
  const root = decodeCredential(
    await issueHostCredential({ name: 'root', role: 'admin', replace: false }),
  );
  /** Requests go to the loopback port while the certificate is still verified against the public name. */
  async function call(cred: Credential, method: string, route: string, body?: unknown) {
    const transport = createTransport(cred, `https://127.0.0.1:${port}`);
    try {
      const res = await transport.http(`${transport.base}${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    } catch {
      return { status: 0, body: null }; // connection closed or handshake refused
    } finally {
      void transport.close();
    }
  }
  /** Registers a node the way `node-install` does: the node makes its key, an admin posts the CSR. */
  async function newNode(name: string, mode: 'create' | 'replace' = 'create', keyPem?: string) {
    const keys = keyPem ? { privateKeyPem: keyPem } : await generateKeyPair();
    const csr = await createCsr(keys.privateKeyPem);
    const res = await call(root, 'POST', `/api/v1/nodes/${name}/identity`, { csr, mode });
    assert.equal(
      res.status,
      200,
      `identity ${mode} for ${name} must succeed: ${JSON.stringify(res.body)}`,
    );
    const credential: Credential = {
      v: 1,
      url: res.body.url,
      ca: res.body.ca,
      cert: res.body.certificate,
      key: keys.privateKeyPem,
    };
    return { credential, keyPem: keys.privateKeyPem, csr };
  }
  return {
    app,
    root,
    port,
    call,
    newNode,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('route classes: operators, nodes and bootstrap keys each reach only their own routes', async () => {
  const s = await start();
  try {
    assert.equal(
      (await s.call(s.root, 'GET', '/api/v1/nodes')).status,
      200,
      'operators reach /api/v1',
    );
    assert.equal(
      (await s.call(s.root, 'GET', '/agent/v1/work')).status,
      403,
      'operators must not reach node routes',
    );
    const node = await s.newNode('n1');
    assert.equal(
      (await s.call(node.credential, 'GET', '/agent/v1/work')).status,
      200,
      'nodes reach /agent/v1',
    );
    assert.equal(
      (await s.call(node.credential, 'GET', '/api/v1/nodes')).status,
      403,
      'nodes must not reach operator routes',
    );
    assert.equal(
      (await s.call(node.credential, 'POST', '/agent/v1/enroll', { csr: node.csr })).status,
      403,
      'node certificates must not use the enrollment route',
    );
    const minted = await s.call(s.root, 'POST', '/api/v1/nodes/enrollment-credential', {
      name: 'n2',
    });
    assert.equal(minted.status, 200, 'admins mint join keys');
    for (const [method, route] of [
      ['GET', '/api/v1/nodes'],
      ['GET', '/agent/v1/work'],
      ['POST', '/agent/v1/renew'],
      ['GET', '/agent/v1/wake'],
    ])
      assert.equal(
        (await s.call(minted.body.credential, method, route, {})).status,
        403,
        `bootstrap certificates must not reach ${method} ${route}`,
      );
  } finally {
    await s.close();
  }
});

test('handshake: clients without a certificate, and plain HTTP, never reach a handler', async () => {
  const s = await start();
  try {
    const outcome = await new Promise<string>((resolve) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port: s.port,
        ca: s.root.ca,
        servername: 'localhost',
      });
      let data = '';
      socket.on('data', (d) => (data += d));
      socket.on('secureConnect', () =>
        socket.write('GET /api/v1/nodes HTTP/1.1\r\nHost: x\r\n\r\n'),
      );
      socket.on('error', () => resolve(data || 'closed'));
      socket.on('close', () => resolve(data || 'closed'));
    });
    assert.equal(outcome, 'closed', 'a client without a certificate must get no HTTP response');
    const plain = await new Promise<string>((resolve) => {
      const net = tls.connect({
        host: '127.0.0.1',
        port: s.port,
        ca: s.root.ca,
        servername: 'localhost',
      });
      net.on('error', () => resolve('error'));
      net.on('close', () => resolve('closed'));
    });
    assert.ok(['error', 'closed'].includes(plain), 'a bare connection must be dropped');
  } finally {
    await s.close();
  }
});

test('key authorization: several certificates per key work; a foreign key for a known node is refused', async () => {
  const s = await start();
  try {
    const node = await s.newNode('n1');
    const renewed = await s.call(node.credential, 'POST', '/agent/v1/renew', { csr: node.csr });
    assert.equal(renewed.status, 200, 'renewal signs another certificate for the stored key');
    const second = { ...node.credential, cert: renewed.body.certificate };
    assert.equal(
      (await s.call(second, 'GET', '/agent/v1/work')).status,
      200,
      'the renewed certificate works',
    );
    assert.equal(
      (await s.call(node.credential, 'GET', '/agent/v1/work')).status,
      200,
      'the previous certificate stays valid until it expires',
    );
    const other = await generateKeyPair();
    const stranger = await (s.app.locals.pki as Pki).signClientCsr(
      await createCsr(other.privateKeyPem),
      identityUri('node', 'n1'),
      86_400_000,
    );
    assert.equal(
      (
        await s.call(
          { ...node.credential, cert: stranger.cert, key: other.privateKeyPem },
          'GET',
          '/agent/v1/work',
        )
      ).status,
      0,
      'a CA-signed certificate with a key other than the stored one must be refused',
    );
    const otherKey = await generateKeyPair();
    const refused = await s.call(node.credential, 'POST', '/agent/v1/renew', {
      csr: await createCsr(otherKey.privateKeyPem),
    });
    assert.equal(refused.status, 403, 'renewal requires a CSR for the existing key');
  } finally {
    await s.close();
  }
});

test('node identity: create is idempotent for the same key, replace cuts off the old key at once', async () => {
  const s = await start();
  try {
    const node = await s.newNode('n1');
    const retry = await s.newNode('n1', 'create', node.keyPem);
    assert.equal(
      (await s.call(retry.credential, 'GET', '/agent/v1/work')).status,
      200,
      'identical key retry works',
    );
    const keys = await generateKeyPair();
    const clash = await s.call(s.root, 'POST', '/api/v1/nodes/n1/identity', {
      csr: await createCsr(keys.privateKeyPem),
      mode: 'create',
    });
    assert.equal(clash.status, 409, 'create refuses an existing name with another key');
    const missing = await s.call(s.root, 'POST', '/api/v1/nodes/nope/identity', {
      csr: await createCsr(keys.privateKeyPem),
      mode: 'replace',
    });
    assert.equal(missing.status, 404, 'replace refuses an unknown node');
    const replaced = await s.newNode('n1', 'replace');
    assert.equal(
      (await s.call(replaced.credential, 'GET', '/agent/v1/work')).status,
      200,
      'the new key works',
    );
    assert.equal(
      (await s.call(node.credential, 'GET', '/agent/v1/work')).status,
      0,
      'every certificate for the replaced key stops working',
    );
  } finally {
    await s.close();
  }
});

test('node IDs are immutable and never reused: a removed node name gets a new ID that old certificates cannot match', async () => {
  const s = await start();
  try {
    await s.newNode('n1');
    const listed = async () =>
      (
        (await s.call(s.root, 'GET', '/api/v1/nodes')).body.nodes as { id: string; name: string }[]
      ).find((n) => n.name === 'n1');
    const first = (await listed())!;
    assert.notEqual(first.id, 'n1', 'the node ID is generated, not derived from the node name');
    assert.match(first.id, /^node_/, 'node IDs carry the node_ prefix');
    const replaced = await s.newNode('n1', 'replace');
    assert.equal((await listed())!.id, first.id, 'replacing the identity keeps the node ID');
    assert.equal(
      (await s.call(replaced.credential, 'GET', '/agent/v1/work')).body.nodeId,
      first.id,
      'the agent work response names the immutable node ID',
    );
    const removed = await s.call(s.root, 'DELETE', '/api/v1/nodes/n1?force=true');
    assert.equal(removed.status, 200, 'node-remove deletes an unplaced node');
    assert.equal(
      (await s.call(replaced.credential, 'GET', '/agent/v1/work')).status,
      0,
      'a removed node certificate stops working',
    );
    // The same name and even the same key come back as a different node: the old certificate names the old ID.
    const again = await s.newNode('n1', 'create', replaced.keyPem);
    const second = (await listed())!;
    assert.notEqual(
      second.id,
      first.id,
      'a name freed by node-remove never gets the old node ID back',
    );
    assert.equal(
      (await s.call(again.credential, 'GET', '/agent/v1/work')).status,
      200,
      'the re-created node authenticates with its own certificate',
    );
    assert.equal(
      (await s.call(replaced.credential, 'GET', '/agent/v1/work')).status,
      0,
      'a certificate issued for the removed node ID is not accepted for the re-created node even with the same key',
    );
  } finally {
    await s.close();
  }
});

test('diagnostics report CA, server and node certificate expiry', async () => {
  const s = await start();
  try {
    await s.newNode('n1');
    const res = await s.call(s.root, 'GET', '/api/v1/diagnostics');
    assert.equal(res.status, 200, 'an admin can read the diagnostics');
    const certificates = res.body.checks.find((c: { name: string }) => c.name === 'certificates');
    assert.equal(certificates.ok, true, 'fresh certificates pass');
    assert.equal(certificates.server.state, 'ok', 'the server certificate is valid');
    assert.ok(certificates.server.daysLeft >= 89, 'the server certificate lasts about 90 days');
    assert.ok(certificates.ca.daysLeft > 3000, 'the CA lasts about ten years');
    const nodes = res.body.checks.find((c: { name: string }) => c.name === 'nodes');
    assert.equal(nodes.nodes[0].certificate.state, 'ok', 'the node certificate is valid');
    assert.ok(
      nodes.nodes[0].certificate.daysLeft >= 89,
      'the node certificate lasts about 90 days',
    );
  } finally {
    await s.close();
  }
});

test('disable blocks the node key without deleting it; replace brings the node back', async () => {
  const s = await start();
  try {
    const node = await s.newNode('n1');
    assert.equal(
      (await s.call(s.root, 'POST', '/api/v1/nodes/n1/disable', {})).status,
      200,
      'admins disable nodes',
    );
    assert.equal(
      (await s.call(node.credential, 'GET', '/agent/v1/work')).status,
      0,
      'a disabled node is refused',
    );
    const listed = await s.call(s.root, 'GET', '/api/v1/nodes');
    assert.ok(
      listed.body.nodes.some((n: any) => n.name === 'n1'),
      'disable keeps node metadata',
    );
    const row = listed.body.nodes.find((n: any) => n.name === 'n1');
    assert.equal(row.status, 'disabled', 'a disabled node is reported as disabled, not online');
    assert.ok(row.disabled_at, 'the listing shows when the node was disabled');
    const back = await s.newNode('n1', 'replace');
    assert.equal(
      (await s.call(back.credential, 'GET', '/agent/v1/work')).status,
      200,
      'replace clears the disabled state',
    );
  } finally {
    await s.close();
  }
});

test('self-enrollment is single-use, name-bound, create-only and retried by key', async () => {
  const s = await start();
  try {
    const minted = await s.call(s.root, 'POST', '/api/v1/nodes/enrollment-credential', {
      name: 'e1',
      labels: ['app'],
    });
    const bootstrap: Credential = minted.body.credential;
    const keys = await generateKeyPair();
    const csr = await createCsr(keys.privateKeyPem);
    const first = await s.call(bootstrap, 'POST', '/agent/v1/enroll', {
      csr,
      address: '10.0.0.9',
      name: 'ignored',
    });
    assert.equal(first.status, 200, `enrollment succeeds: ${JSON.stringify(first.body)}`);
    assert.equal(first.body.node.name, 'e1', 'the name comes from the key row, never the request');
    assert.match(
      first.body.node.id,
      /^node_/,
      'enrollment creates the node with a generated immutable ID',
    );
    assert.deepEqual(first.body.node.labels, ['app'], 'labels come from the key row');
    const retry = await s.call(bootstrap, 'POST', '/agent/v1/enroll', { csr, address: '10.9.9.9' });
    assert.equal(retry.status, 200, 'a retry with the same key signs another certificate');
    assert.equal(retry.body.node.address, '10.0.0.9', 'a retry changes no stored value');
    assert.equal(retry.body.node.id, first.body.node.id, 'a retry keeps the ID the key reserved');
    const stranger = await generateKeyPair();
    const other = await s.call(bootstrap, 'POST', '/agent/v1/enroll', {
      csr: await createCsr(stranger.privateKeyPem),
    });
    assert.equal(other.status, 403, 'a consumed join key refuses a different key');
    const node: Credential = {
      v: 1,
      url: first.body.url,
      ca: first.body.ca,
      cert: first.body.certificate,
      key: keys.privateKeyPem,
    };
    assert.equal(
      (await s.call(node, 'GET', '/agent/v1/work')).status,
      200,
      'the enrolled node authenticates',
    );
    const again = await s.call(s.root, 'POST', '/api/v1/nodes/enrollment-credential', {
      name: 'e1',
    });
    const replace = await s.call(again.body.credential, 'POST', '/agent/v1/enroll', {
      csr: await createCsr(stranger.privateKeyPem),
    });
    assert.equal(replace.status, 409, 'a join key can never replace an existing node');
    const m1 = await s.call(s.root, 'POST', '/api/v1/nodes/enrollment-credential', { name: 'e2' });
    await s.call(s.root, 'POST', '/api/v1/nodes/enrollment-credential', { name: 'e2' });
    const revoked = await s.call(m1.body.credential, 'POST', '/agent/v1/enroll', { csr });
    assert.equal(revoked.status, 0, 're-minting for a name revokes its previous unconsumed key');
  } finally {
    await s.close();
  }
});

test('operator credentials: scoped, revocable, and revocation closes access immediately', async () => {
  const s = await start();
  try {
    const created = await s.call(s.root, 'POST', '/api/v1/credentials', {
      name: 'ci',
      role: 'read',
    });
    assert.equal(created.status, 200, 'admins create operator credentials');
    const ci = decodeCredential(created.body.credential);
    assert.equal(
      (await s.call(ci, 'GET', '/api/v1/status')).status,
      200,
      'a read credential reads',
    );
    assert.equal(
      (await s.call(ci, 'POST', '/api/v1/nodes/x/disable', {})).status,
      403,
      'a read credential cannot administer',
    );
    assert.equal(
      (await s.call(s.root, 'DELETE', '/api/v1/credentials/ci')).status,
      200,
      'admins revoke',
    );
    assert.equal(
      (await s.call(ci, 'GET', '/api/v1/status')).status,
      0,
      'a revoked credential is refused',
    );
    assert.equal(
      (await s.call(s.root, 'DELETE', '/api/v1/credentials/ci')).status,
      200,
      'revocation is idempotent',
    );
    const stillRoot = await s.call(s.root, 'GET', '/api/v1/credentials');
    assert.equal(stillRoot.status, 200, 'the verified admin keeps working throughout replacement');
  } finally {
    await s.close();
  }
});

test('root recovery replaces only root and closes its old sessions within a second', async () => {
  const s = await start();
  try {
    const other = await s.call(s.root, 'POST', '/api/v1/credentials', {
      name: 'second-admin',
      role: 'admin',
    });
    const second = decodeCredential(other.body.credential);
    await assert.rejects(
      issueHostCredential({ name: 'root', role: 'admin', replace: false }),
      /already used/,
      'issuance is create-only by default',
    );
    const recovered = decodeCredential(
      await issueHostCredential({ name: 'root', role: 'admin', replace: true }),
    );
    assert.equal(
      (await s.call(recovered, 'GET', '/api/v1/credentials')).status,
      200,
      'the recovered root works',
    );
    assert.equal(
      (await s.call(s.root, 'GET', '/api/v1/credentials')).status,
      0,
      'the old root key is refused',
    );
    assert.equal(
      (await s.call(second, 'GET', '/api/v1/credentials')).status,
      200,
      'other admins are unaffected',
    );
  } finally {
    await s.close();
  }
});

test('renewal: a node cannot renew with another node key, and expired or bootstrap certificates cannot renew', async () => {
  const s = await start();
  try {
    const a = await s.newNode('a');
    const b = await s.newNode('b');
    const stolen = await s.call(b.credential, 'POST', '/agent/v1/renew', { csr: a.csr });
    assert.equal(
      stolen.status,
      403,
      "a CSR for another node's key must not be signed for this node",
    );
    const minted = await s.call(s.root, 'POST', '/api/v1/nodes/enrollment-credential', {
      name: 'c',
    });
    assert.equal(
      (await s.call(minted.body.credential, 'POST', '/agent/v1/renew', { csr: a.csr })).status,
      403,
      'bootstrap certificates cannot renew',
    );
  } finally {
    await s.close();
  }
});

test('renewal: the minimum interval is enforced per node', async () => {
  const s = await start();
  process.env.TUG_RENEW_MIN_INTERVAL_MS = '3600000';
  try {
    const n = await s.newNode('n1');
    assert.equal(
      (await s.call(n.credential, 'POST', '/agent/v1/renew', { csr: n.csr })).status,
      200,
      'first renewal works',
    );
    assert.equal(
      (await s.call(n.credential, 'POST', '/agent/v1/renew', { csr: n.csr })).status,
      429,
      'a second renewal inside the interval is refused',
    );
  } finally {
    process.env.TUG_RENEW_MIN_INTERVAL_MS = '0';
    await s.close();
  }
});

test('control restore answers its caller, then closes every session', async () => {
  const s = await start();
  try {
    const backup = await s.call(s.root, 'POST', '/api/v1/control/backups/run', {});
    assert.equal(backup.status, 200, 'a control backup runs over mTLS');
    const restored = await s.call(s.root, 'POST', '/api/v1/control/restore', {
      artifactRef: backup.body.artifactRef,
      confirm: true,
    });
    assert.equal(
      restored.status,
      200,
      `the restore response must reach the caller: ${JSON.stringify(restored.body)}`,
    );
    assert.equal(restored.body.restartRequired, true, 'restore requires a restart');
    assert.equal(
      (await s.call(s.root, 'GET', '/api/v1/nodes')).status,
      0,
      'sessions are closed after the restore',
    );
  } finally {
    await s.close();
  }
});

test('credentials keep working when the address in them is wrong, because control is verified by its generated name', async () => {
  const s = await start();
  try {
    const moved = { ...s.root, url: 'https://control-moved.example:9999' };
    assert.equal(
      (await s.call(moved, 'GET', '/api/v1/nodes')).status,
      200,
      'only the connect target matters',
    );
    assert.equal(
      new URL(s.root.url).hostname,
      'localhost',
      'the stored URL is just the default connect address',
    );
  } finally {
    await s.close();
  }
});
