// Self-contained mTLS client for the integration scripts (they run on the host and inside the runtime image, where
// the TypeScript sources are not available). The connect target may differ from the credential's public URL, as with
// `--control-url`; the certificate is always verified against the public host.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';

export function parseCredential(raw) {
  const text = raw.trim();
  return JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64url').toString('utf8'));
}

export function loadCredential(env = process.env) {
  const raw =
    env.TUG_CREDENTIAL ||
    (env.TUG_CREDENTIAL_FILE && fs.readFileSync(env.TUG_CREDENTIAL_FILE, 'utf8'));
  if (!raw) throw new Error('set TUG_CREDENTIAL or TUG_CREDENTIAL_FILE');
  return parseCredential(raw);
}

/** Issues a request and returns a minimal fetch-like response. */
export function mtlsFetch(credential, connectUrl, route, init = {}) {
  // The server is verified by the name derived from the pinned CA, not by the address being dialed.
  const spki = new crypto.X509Certificate(credential.ca).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  const controlName = `control-${crypto.createHash('sha256').update(spki).digest('hex').slice(0, 12)}.tug`;
  const target = new URL(route, connectUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: init.method || 'GET',
        headers: init.headers,
        ca: credential.ca,
        cert: credential.cert,
        key: credential.key,
        minVersion: 'TLSv1.3',
        servername: controlName,
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(controlName, cert),
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/** Authenticated JSON call; throws on a non-2xx response. */
export async function api(credential, connectUrl, route, body, method) {
  const res = await mtlsFetch(credential, connectUrl, route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Copies the root credential the provisioner wrote out of its (possibly exited) container. */
export async function fetchRootCredential(composeArgs, cwd, timeoutMs = 180000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tug-it-cred-'));
  const file = path.join(dir, 'root.credential.json');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = spawnSync(
      'docker',
      [...composeArgs, 'cp', 'provisioner:/tokens/root.credential.json', file],
      {
        cwd,
        encoding: 'utf8',
      },
    );
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 0) {
      fs.chmodSync(file, 0o600);
      return { credential: parseCredential(fs.readFileSync(file, 'utf8')), file };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('the provisioner did not produce a root credential');
}
