import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.js';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-'));
  process.env.LAUNCHPAD_DATA_DIR = dir;
  process.env.LAUNCHPAD_OPERATOR_TOKEN = 'op-test-token';
  process.env.LAUNCHPAD_REGISTRY = 'registry.test';
  const app = await createApp();
  const srv = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise(resolve => srv.close(resolve)) };
}
function op() { return { Authorization: 'Bearer op-test-token', 'content-type': 'application/json' }; }

test('registers node, stores secret, creates desired state, serves agent work', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/register`, { method: 'POST', headers: op(), body: JSON.stringify({ name: 'n1', address: '10.0.0.1' }) });
    assert.equal(res.status, 200);
    const registered = await res.json();
    assert.match(registered.agentToken, /^lpa_/);

    res = await fetch(`${s.base}/api/v1/secrets`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', name: 'DB_PASSWORD', value: 'pw' }) });
    assert.equal(res.status, 200);

    const compose = { services: { web: { image: 'nginx:alpine', 'x-launchpad': { placement: { nodes: ['n1'] } } } } };
    res = await fetch(`${s.base}/api/v1/deployments`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', version: 'git-a', compose }) });
    assert.equal(res.status, 200);

    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${registered.agentToken}` } });
    let work = await res.json();
    assert.equal(work.desiredStates[0].version, 'git-a');

    res = await fetch(`${s.base}/api/v1/restart`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', service: 'web' }) });
    assert.equal(res.status, 200);
    const restart = await res.json();
    res = await fetch(`${s.base}/api/v1/logs`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', service: 'web', tail: 5 }) });
    assert.equal(res.status, 200);
    const command = await res.json();
    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${registered.agentToken}` } });
    work = await res.json();
    assert.equal(work.commands[0].id, restart.commandId);
    assert.equal(work.commands[1].id, command.commandId);
    res = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ projects: [{ project: 'site', observedVersion: 'git-a', health: 'serving' }], commandResults: [{ commandId: restart.commandId, state: 'succeeded', result: { restarted: true } }, { commandId: command.commandId, state: 'succeeded', result: { stdout: 'ok' } }] }) });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/commands/${command.commandId}`, { headers: op() });
    assert.equal((await res.json()).state, 'succeeded');
    res = await fetch(`${s.base}/api/v1/status`, { headers: op() });
    const status = await res.json();
    assert.equal(status.deployments[0].state, 'succeeded');
  } finally { await s.close(); }
});

test('failed node status fails deployment and unblocks future deploys', async () => {
  const s = await server();
  try {
    let res = await fetch(`${s.base}/api/v1/nodes/register`, { method: 'POST', headers: op(), body: JSON.stringify({ name: 'n1' }) });
    const registered = await res.json();
    const compose = { services: { web: { image: 'nginx:alpine', 'x-launchpad': { placement: { nodes: ['n1'] } } } } };
    res = await fetch(`${s.base}/api/v1/deployments`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', version: 'bad', compose }) });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/deployments`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', version: 'blocked', compose }) });
    assert.equal(res.status, 409);
    res = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ projects: [{ project: 'site', observedVersion: 'bad', health: 'failed' }] }) });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/deployments`, { method: 'POST', headers: op(), body: JSON.stringify({ project: 'site', version: 'good', compose }) });
    assert.equal(res.status, 200);
  } finally { await s.close(); }
});
