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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cbak-'));
  process.env.TUG_DATA_DIR = dir;
  process.env.TUG_CONTROL_BACKUP_DIR = path.join(dir, 'control-backups');
  process.env.TUG_CONTROL_RESTORE_DIR = path.join(dir, 'control-restore');
  process.env.TUG_OPERATOR_TOKEN = 'op-control-backup-token';
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise(resolve => srv.close(resolve)) };
}
const op = { Authorization: 'Bearer op-control-backup-token', 'content-type': 'application/json' };

test('creates control-plane backup and requires confirmation for restore', async () => {
  const s = await makeServer();
  try {
    let res = await fetch(`${s.base}/api/v1/control/backups/run`, { method: 'POST', headers: op, body: '{}' });
    assert.equal(res.status, 200);
    const backup = await json(res);
    assert.match(backup.backupId, /^cbak_/);
    assert.ok((await fs.stat(backup.artifactRef)).size > 0);
    res = await fetch(`${s.base}/api/v1/control/restore`, { method: 'POST', headers: op, body: JSON.stringify({ artifactRef: backup.artifactRef }) });
    assert.equal(res.status, 400);
  } finally { await s.close(); }
});
