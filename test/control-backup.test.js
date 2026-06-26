import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/control.js';

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-cbak-'));
  process.env.LAUNCHPAD_DB = path.join(dir, 'launchpad.db');
  process.env.LAUNCHPAD_MASTER_KEY_FILE = path.join(dir, 'master.key');
  process.env.LAUNCHPAD_CONTROL_BACKUP_DIR = path.join(dir, 'control-backups');
  process.env.LAUNCHPAD_CONTROL_RESTORE_DIR = path.join(dir, 'control-restore');
  process.env.LAUNCHPAD_OPERATOR_TOKEN = 'op-control-backup-token';
  const app = await createApp();
  const srv = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-control-backup-token', 'content-type': 'application/json' };

test('creates control-plane backup and requires confirmation for restore', async () => {
  const s = await makeServer();
  try {
    let res = await fetch(`${s.base}/api/v1/control/backups/run`, { method: 'POST', headers: op, body: '{}' });
    assert.equal(res.status, 200);
    const backup = await res.json();
    assert.match(backup.backupId, /^cbak_/);
    assert.ok((await fs.stat(backup.artifactRef)).size > 0);
    res = await fetch(`${s.base}/api/v1/control/restore`, { method: 'POST', headers: op, body: JSON.stringify({ artifactRef: backup.artifactRef }) });
    assert.equal(res.status, 400);
  } finally { await s.close(); }
});
