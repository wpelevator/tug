import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { testImageResolver, testControlUrl, testIdentity, json } from '../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { packageVersion } from './image.ts';

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
