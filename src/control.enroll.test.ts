import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { json as jsonBody } from '../tests/helpers.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = 'op-test-token';
  process.env.TUG_REGISTRY = 'registry.test';
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
function op() { return { Authorization: 'Bearer op-test-token', 'content-type': 'application/json' }; }
const json = { 'content-type': 'application/json' };

test('enroll token exchanges for durable agent credentials and is single-use', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/enroll-token`, { method: 'POST', headers: op(), body: JSON.stringify({ name: 'app1' }) });
    assert.equal(res.status, 200);
    const minted = await jsonBody(res);
    assert.match(minted.enrollToken, /^tug_enroll_/);
    assert.equal(minted.registry, 'registry.test');

    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken }) });
    assert.equal(res.status, 200);
    const enrolled = await jsonBody(res);
    assert.equal(enrolled.node.name, 'app1');
    assert.match(enrolled.agentToken, /^tug_agent_/);
    assert.match(enrolled.registryToken, /^tug_reg_/);
    assert.equal(enrolled.registry, 'registry.test');

    // durable token authenticates against agent work
    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${enrolled.agentToken}` } });
    assert.equal(res.status, 200);

    // single-use: a second enroll with the same token is rejected
    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken }) });
    assert.equal(res.status, 401);
  } finally { await s.close(); }
});

test('unbound enroll token takes name from agent and honors uses count', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/enroll-token`, { method: 'POST', headers: op(), body: JSON.stringify({ uses: 2 }) });
    const minted = await jsonBody(res);

    // missing name on an unbound token is a 400
    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken }) });
    assert.equal(res.status, 400);

    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken, name: 'web-a' }) });
    assert.equal((await jsonBody(res)).node.name, 'web-a');
    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken, name: 'web-b' }) });
    assert.equal((await jsonBody(res)).node.name, 'web-b');
    // third use exhausts the token
    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken, name: 'web-c' }) });
    assert.equal(res.status, 401);
  } finally { await s.close(); }
});

test('expired enroll token is rejected', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/enroll-token`, { method: 'POST', headers: op(), body: JSON.stringify({ name: 'app1', ttlSeconds: 1 }) });
    const minted = await jsonBody(res);
    await new Promise(r => setTimeout(r, 1100));
    res = await fetch(`${s.base}/agent/v1/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ enrollToken: minted.enrollToken }) });
    assert.equal(res.status, 401);
  } finally { await s.close(); }
});
