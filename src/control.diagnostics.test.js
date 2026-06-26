import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.js';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-diag-'));
  process.env.LAUNCHPAD_DB = path.join(dir, 'launchpad.db');
  process.env.LAUNCHPAD_MASTER_KEY_FILE = path.join(dir, 'master.key');
  process.env.LAUNCHPAD_OPERATOR_TOKEN = 'op-diag-token';
  const app = await createApp();
  const srv = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-diag-token', 'content-type': 'application/json' };

test('control diagnostics and node diagnostics command queue', async () => {
  const s = await makeServer();
  try {
    let res = await fetch(`${s.base}/api/v1/diagnostics`, { headers: op });
    assert.equal(res.status, 200);
    const diagnostics = await res.json();
    assert.ok(diagnostics.checks.some(c => c.name === 'sqlite' && c.ok));

    res = await fetch(`${s.base}/api/v1/nodes/register`, { method: 'POST', headers: op, body: JSON.stringify({ name: 'n1' }) });
    assert.equal(res.status, 200);
    const node = await res.json();
    res = await fetch(`${s.base}/api/v1/diagnostics/nodes`, { method: 'POST', headers: op, body: JSON.stringify({ node: 'n1' }) });
    assert.equal(res.status, 200);
    const queued = await res.json();
    assert.match(queued.commands[0].commandId, /^cmd_/);
    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${node.agentToken}` } });
    assert.equal((await res.json()).commands[0].type, 'diagnostics.run');
  } finally { await s.close(); }
});
