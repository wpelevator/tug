import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { testImageResolver, testControlUrl, testIdentity, json } from '../../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { packageVersion } from '../images/image.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((resolve) => srv.close(resolve)) };
}
const op = () => ({ 'x-tug-test-operator': 'operator' });

test('control reports its own version on /api/v1/version', async () => {
  const s = await server();
  try {
    const res = await fetch(`${s.base}/api/v1/version`, { headers: op() });
    assert.equal(res.status, 200, 'the version route is readable by an operator');
    const body = (await json(res)) as { v?: string };
    assert.equal(body.v, packageVersion(), 'control reports the version baked into its package');
  } finally {
    await s.close();
  }
});

test('the version route works for a fresh unauthenticated-in-test agent too (read role)', async () => {
  const s = await server();
  try {
    // Any operator-class credential reaches `read`; the matrix test in control.credentials.test.ts covers scopes.
    const res = await fetch(`${s.base}/api/v1/version`, { headers: op() });
    assert.equal(res.status, 200, 'a read-role principal reads the version');
  } finally {
    await s.close();
  }
});

test('every response stamps the control version, including error responses', async () => {
  const s = await server();
  try {
    const ok = await fetch(`${s.base}/api/v1/version`, { headers: op() });
    assert.equal(
      ok.headers.get('x-tug-version'),
      packageVersion(),
      'the stamp rides the normal response, so clients never need a dedicated probe request',
    );
    const denied = await fetch(`${s.base}/api/v1/not-a-route`, { headers: op() });
    assert.notEqual(
      denied.status,
      200,
      'the route under test must be an error to prove stamping on errors',
    );
    assert.equal(
      denied.headers.get('x-tug-version'),
      packageVersion(),
      'error responses carry the stamp too',
    );
  } finally {
    await s.close();
  }
});

test('a client declaring a newer version is refused before any handler runs', async () => {
  const s = await server();
  try {
    const [major, minor] = packageVersion().split('.').map(Number);
    // Before 1.0 a newer minor is already incompatible; from 1.0 only a newer major is, and a newer minor is served.
    const newer = major >= 1 ? `${major + 1}.0` : `${major}.${minor + 1}`;
    // A route that does not exist saves the point: a 400 skew refusal can only come from the middleware, not a handler.
    const res = await fetch(`${s.base}/api/v1/not-a-route`, {
      headers: { ...op(), 'x-tug-client-version': newer },
    });
    assert.equal(
      res.status,
      400,
      'a client newer than the control is refused before any handler would run',
    );
    const body = (await json(res)) as { error?: string; skew?: string };
    assert.equal(
      body.skew,
      'client-newer',
      'the refusal names the skew direction for the client to act on',
    );
    assert.match(
      body.error ?? '',
      /tug control setup <control host> --yes/,
      'refusal names the upgrade command',
    );
    const stamp = res.headers.get('x-tug-version');
    assert.ok(
      stamp,
      'refusal responses stay stamped, so a refused legacy client can still self-classify',
    );
    // The refusal must not be a one-way door: a same-version client gets through.
    const same = await fetch(`${s.base}/api/v1/version`, {
      headers: { ...op(), 'x-tug-client-version': packageVersion() },
    });
    assert.equal(same.status, 200, 'the control refuses only clients strictly newer than itself');
  } finally {
    await s.close();
  }
});

test('from 1.0 a client on a newer minor of the same major is served', async (t) => {
  const [major, minor] = packageVersion().split('.').map(Number);
  if (major < 1) return t.skip('before 1.0 a newer minor is incompatible and refused');
  const s = await server();
  try {
    const res = await fetch(`${s.base}/api/v1/version`, {
      headers: { ...op(), 'x-tug-client-version': `${major}.${minor + 1}` },
    });
    assert.equal(
      res.status,
      200,
      'inside one major a newer minor only adds, so the control serves it',
    );
  } finally {
    await s.close();
  }
});

test('a client older than or equal to the control, or headerless, may proceed', async () => {
  const s = await server();
  try {
    const [major, minor] = packageVersion().split('.').map(Number);
    const olderVersion = minor > 0 ? `${major}.${minor - 1}` : `${major - 1}.0`;
    for (const [clientVersion, description] of [
      [olderVersion, 'an older client'],
      [undefined, 'a headerless (legacy) client'],
    ] as const) {
      const headers = clientVersion ? { ...op(), 'x-tug-client-version': clientVersion } : op();
      const res = await fetch(`${s.base}/api/v1/version`, { headers });
      assert.equal(
        res.status,
        200,
        `${description} must get through: the control only gates clients newer than itself`,
      );
    }
  } finally {
    await s.close();
  }
});
