import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Pki, identityUri, serverNames } from '../pki.ts';
import { serverTlsOptions } from '../tls-server.ts';
import { resetVersionChecks, request, setResolvedConfig } from './context.ts';
import type { ResolvedCliConfig } from '../cli-config.ts';

/**
 * Regression test for the incident: the version preflight is the first TLS connection a command opens, so a
 * credential signed by a CA different from the control's must produce the CA-mismatch message HERE — not a bare
 * openssl string from the preflight that would make the request-path mapping unreachable.
 */
test('a credential from a different CA fails the preflight with the both-fingerprints message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-preca-'));
  const serverPki = await Pki.load(
    await fs.mkdtemp(path.join(os.tmpdir(), 'tug-server-ca-')),
    true,
  );
  const clientPki = await Pki.load(
    await fs.mkdtemp(path.join(os.tmpdir(), 'tug-client-ca-')),
    true,
  );
  const issued = await serverPki.issueServer(serverNames('https://localhost:8443'));
  const credential = (
    await clientPki.issueClient(identityUri('operator', 'o1'), 86_400_000, 'https://localhost:8443')
  ).credential;
  const https = createServer(
    serverTlsOptions({ cert: issued.cert, key: issued.key, ca: serverPki.caPem }),
    () => {}, // no route here: the preflight must fail at TLS, before any route is reached
  );
  https.listen(0, '127.0.0.1');
  await once(https, 'listening');
  const url = `https://127.0.0.1:${(https.address() as { port: number }).port}`;
  const realpathed = path.join(dir, 'credential.json');
  await fs.writeFile(realpathed, JSON.stringify(credential), { mode: 0o600 });
  setResolvedConfig({
    file: path.join(dir, 'cfg.yml'),
    localFile: path.join(dir, 'cfg.local.yml'),
    fileExists: false,
    controlUrl: url,
    credential,
    credentialFile: realpathed,
    commandDefaults: {},
    nodeDefaults: {},
    nodes: {},
    project: 'site',
  } as unknown as ResolvedCliConfig);
  resetVersionChecks();
  try {
    await assert.rejects(
      request('GET', '/api/v1/services?project=site'),
      /did not present a certificate signed by this credential's CA/,
      'the CA mismatch must surface as the actionable message from the first TLS connection (the preflight)',
    );
    await assert.rejects(
      request('GET', '/api/v1/services?project=site'),
      /this credential trusts [A-F0-9]/,
      'the message also names the trusted CA fingerprint',
    );
  } finally {
    https.closeAllConnections();
    await new Promise<void>((resolve) => https.close(() => resolve()));
    resetVersionChecks();
  }
});
