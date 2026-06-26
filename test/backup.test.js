import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/control.js';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-bak-'));
  process.env.LAUNCHPAD_DB = path.join(dir, 'launchpad.db');
  process.env.LAUNCHPAD_MASTER_KEY_FILE = path.join(dir, 'master.key');
  process.env.LAUNCHPAD_OPERATOR_TOKEN = 'op-backup-token';
  const app = await createApp();
  const srv = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-backup-token', 'content-type': 'application/json' };
async function post(base, route, body, headers = op) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

test('queues and completes named volume backup command', async () => {
  const s = await makeServer();
  try {
    const registered = await post(s.base, '/api/v1/nodes/register', { name: 'n1' });
    const compose = {
      services: { db: { image: 'redis:7-alpine', volumes: ['data:/data'], 'x-launchpad': { placement: { nodes: ['n1'] } } } },
      volumes: { data: { 'x-launchpad': { type: 'local', persistent: true, placement: { nodes: ['n1'] } } } }
    };
    await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v1', compose });
    const queued = await post(s.base, '/api/v1/backups/run', { project: 'site', target: 'data' });
    assert.match(queued.backupId, /^bak_/);
    let res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${registered.agentToken}` } });
    const work = await res.json();
    assert.equal(work.commands[0].type, 'backup.volume');
    res = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandResults: [{ commandId: queued.commandId, state: 'succeeded', result: { backupId: queued.backupId, artifactRef: '/tmp/data.tar.gz' } }] }) });
    assert.equal(res.status, 200);
    res = await fetch(`${s.base}/api/v1/backups?project=site`, { headers: op });
    const backups = await res.json();
    assert.equal(backups.backups[0].state, 'completed');
    const restore = await post(s.base, '/api/v1/restore', { project: 'site', target: 'data', from: 'latest' });
    assert.match(restore.commandId, /^cmd_/);
    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${registered.agentToken}` } });
    const restoreWork = await res.json();
    assert.equal(restoreWork.commands[0].type, 'restore.volume');
  } finally { await s.close(); }
});

test('queues mariadb service backup and restore commands', async () => {
  const s = await makeServer();
  try {
    const registered = await post(s.base, '/api/v1/nodes/register', { name: 'db' });
    const compose = { services: { mariadb: { image: 'mariadb:11', environment: { MARIADB_DATABASE: 'app', MARIADB_USER: 'app', MARIADB_PASSWORD: '${DB_PASSWORD}', MARIADB_ROOT_PASSWORD: '${DB_ROOT_PASSWORD}' }, 'x-launchpad': { placement: { nodes: ['db'] }, backup: { type: 'mariadb' } } } } };
    await post(s.base, '/api/v1/deployments', { project: 'site', version: 'v1', compose });
    const queued = await post(s.base, '/api/v1/backups/run', { project: 'site', target: 'mariadb' });
    assert.equal(queued.type, 'mariadb');
    let res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${registered.agentToken}` } });
    let work = await res.json();
    assert.equal(work.commands[0].type, 'backup.mariadb');
    res = await fetch(`${s.base}/agent/v1/status`, { method: 'POST', headers: { Authorization: `Bearer ${registered.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandResults: [{ commandId: queued.commandId, state: 'succeeded', result: { backupId: queued.backupId, artifactRef: '/tmp/mariadb.sql.gz', type: 'mariadb' } }] }) });
    assert.equal(res.status, 200);
    const restore = await post(s.base, '/api/v1/restore', { project: 'site', target: 'mariadb', from: 'latest' });
    assert.equal(restore.type, 'mariadb');
    res = await fetch(`${s.base}/agent/v1/work`, { headers: { Authorization: `Bearer ${registered.agentToken}` } });
    work = await res.json();
    assert.equal(work.commands[0].type, 'restore.mariadb');
  } finally { await s.close(); }
});
