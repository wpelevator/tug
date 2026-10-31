import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-reg-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = 'op-registry-token';
  process.env.TUG_REGISTRY = 'registry.test';
  process.env.TUG_REGISTRY_AUTH_PATH = path.join(dir, 'htpasswd');
  delete process.env.TUG_REGISTRY_CONTAINER;
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    htpasswdPath: process.env.TUG_REGISTRY_AUTH_PATH,
    close: () => new Promise(resolve => srv.close(resolve)),
  };
}
const headers = { Authorization: 'Bearer op-registry-token', 'content-type': 'application/json' };
async function post(base: string, route: string, body: unknown) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}
async function readHtpasswd(file: string) {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
}

test('node registration writes an htpasswd entry for registry auth', async () => {
  const s = await server();
  try {
    await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    const lines = await readHtpasswd(s.htpasswdPath);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^n1:\$2y\$/);
  } finally { await s.close(); }
});

test('rotating a registry token replaces the node htpasswd entry', async () => {
  const s = await server();
  try {
    await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    const before = await readHtpasswd(s.htpasswdPath);
    const rotated = await post(s.base, '/api/v1/nodes/n1/rotate-registry-token', {});
    assert.match(rotated.registryToken, /^tug_reg_/);
    const after = await readHtpasswd(s.htpasswdPath);
    assert.equal(after.length, 1);
    assert.notEqual(after[0], before[0]);
    assert.match(after[0], /^n1:\$2y\$/);
  } finally { await s.close(); }
});

test('revoking a registry token removes the htpasswd entry and blocks /api/v1/registry/auth', async () => {
  const s = await server();
  try {
    const registered = await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    let res = await fetch(`${s.base}/api/v1/registry/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'n1', password: registered.registryToken }) });
    assert.equal(res.status, 200);

    await post(s.base, '/api/v1/nodes/n1/revoke-registry-token', {});
    const lines = await readHtpasswd(s.htpasswdPath);
    assert.equal(lines.length, 0);

    res = await fetch(`${s.base}/api/v1/registry/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'n1', password: registered.registryToken }) });
    assert.equal(res.status, 401);
  } finally { await s.close(); }
});

test('multiple node registrations keep distinct htpasswd entries', async () => {
  const s = await server();
  try {
    await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    await post(s.base, '/api/v1/nodes/register', { name: 'n2' });
    const lines = await readHtpasswd(s.htpasswdPath);
    assert.equal(lines.length, 2);
    assert.ok(lines.some(l => l.startsWith('n1:')));
    assert.ok(lines.some(l => l.startsWith('n2:')));
  } finally { await s.close(); }
});
