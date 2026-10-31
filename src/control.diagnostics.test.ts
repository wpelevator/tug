import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { json } from '../tests/helpers.ts';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-diag-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_OPERATOR_TOKEN = 'op-diag-token';
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-diag-token', 'content-type': 'application/json' };

test('control diagnostics and node diagnostics command queue', async () => {
  const s = await makeServer();
  try {
    let res = await fetch(`${s.base}/api/v1/diagnostics`, { headers: op });
    assert.equal(res.status, 200);
    const diagnostics = await json(res);
    assert.ok(diagnostics.checks.some((c: { name: string; ok: boolean }) => c.name === 'sqlite' && c.ok));

    res = await fetch(`${s.base}/api/v1/nodes/register`, { method: 'POST', headers: op, body: JSON.stringify({ name: 'n1' }) });
    assert.equal(res.status, 200);
    const node = await json(res);
    res = await fetch(`${s.base}/api/v1/diagnostics/nodes`, { method: 'POST', headers: op, body: JSON.stringify({ node: 'n1' }) });
    assert.equal(res.status, 200);
    const queued = await json(res);
    assert.match(queued.commands[0].commandId, /^cmd_/);
    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${node.agentToken}` } });
    assert.equal((await json(res)).commands[0].type, 'diagnostics.run');
    res = await fetch(`${s.base}/api/v1/diagnostics/nodes`, { method: 'POST', headers: op, body: JSON.stringify({ node: 'missing' }) });
    assert.equal(res.status, 404, 'an unknown node is not an empty diagnostic run');
    assert.equal((await json(res)).error, 'node missing not found', 'the error names the node that was requested');
  } finally { await s.close(); }
});
