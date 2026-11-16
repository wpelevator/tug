import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/db.ts';
import { recordEvent } from './credentials.ts';
import { createReliabilityMonitor } from './reliability-monitor.ts';
import type { NotificationEvent } from './notifications.ts';

test('committed failures and stale/recovered nodes are observed once without an operator watching', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-monitor-'));
  const db = await openDb(path.join(dir, 'tug.db'));
  let time = Date.now();
  const seen: NotificationEvent[] = [];
  try {
    recordEvent(db, { actor: 'test', type: 'service.failed', message: 'historical' });
    const monitor = createReliabilityMonitor(
      db,
      (e) => {
        seen.push(e);
      },
      () => time,
    );
    db.run(
      'INSERT INTO nodes(id,name,last_seen_at) VALUES(?,?,?)',
      'node1',
      'app1',
      new Date(time - 3600000).toISOString(),
    );
    db.run(
      'INSERT INTO deployments(id,project_id,state,created_at) VALUES(?,?,?,?)',
      'deploy1',
      'site',
      'rolling_out',
      new Date(time).toISOString(),
    );
    time += 60_001;
    monitor.tick();
    monitor.tick();
    assert.deepEqual(
      seen.map((e) => e.type),
      ['node.stale'],
      'staleness is detected once and historical events are not replayed',
    );
    recordEvent(db, {
      actor: 'test',
      type: 'backup.failed',
      message: 'private details',
      project: 'site',
    });
    db.run('UPDATE deployments SET state=? WHERE id=?', 'failed', 'deploy1');
    db.run('UPDATE nodes SET last_seen_at=? WHERE id=?', new Date(time).toISOString(), 'node1');
    time++;
    monitor.tick();
    monitor.tick();
    assert.deepEqual(
      seen.map((e) => e.type),
      ['node.stale', 'backup.failed', 'deployment.failed', 'node.recovered'],
      'committed events and state transitions are detected once',
    );
    db.run(
      'UPDATE nodes SET ingress_status_json=? WHERE id=?',
      JSON.stringify({ state: 'failed', error: 'private-ingress-detail' }),
      'node1',
    );
    db.run(
      'INSERT INTO backups(id,project_id,state,created_at) VALUES(?,?,?,?)',
      'backup-failed',
      '_control',
      'failed',
      new Date(time).toISOString(),
    );
    recordEvent(db, {
      actor: 'test',
      type: 'backup.failed',
      project: '_control',
      message: 'private control backup cause',
    });
    monitor.tick();
    monitor.tick();
    assert.deepEqual(
      seen.slice(-2).map((e) => e.type),
      ['backup.failed', 'ingress.failed'],
      'control protection and ingress failures notify once',
    );
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('never-seen nodes and reconnecting nodes during startup grace do not page operators', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-grace-'));
  const db = await openDb(path.join(dir, 'tug.db'));
  let time = Date.now();
  const seen: NotificationEvent[] = [];
  try {
    db.run(
      'INSERT INTO nodes(id,name,last_seen_at) VALUES(?,?,?)',
      'registered',
      'registered',
      null,
    );
    db.run(
      'INSERT INTO nodes(id,name,last_seen_at) VALUES(?,?,?)',
      'returning',
      'returning',
      new Date(time - 3600000).toISOString(),
    );
    const monitor = createReliabilityMonitor(
      db,
      (e) => {
        seen.push(e);
      },
      () => time,
    );
    monitor.tick();
    assert.equal(
      seen.length,
      0,
      'startup grace suppresses old observations and registration is not a stale report',
    );
    time += 30_000;
    db.run('UPDATE nodes SET last_seen_at=? WHERE id=?', new Date(time).toISOString(), 'returning');
    monitor.tick();
    time += 31_000;
    monitor.tick();
    assert.equal(
      seen.length,
      0,
      'normal reconnect within grace produces no stale/recovered notification pair',
    );
    time += 31_000;
    monitor.tick();
    monitor.tick();
    assert.deepEqual(
      seen.map((e) => [e.type, e.node_id]),
      [['node.stale', 'returning']],
      'only a previously seen node that remains silent after grace becomes stale',
    );
    db.run('UPDATE nodes SET last_seen_at=? WHERE id=?', new Date(time).toISOString(), 'returning');
    monitor.tick();
    assert.equal(seen[1].type, 'node.recovered', 'a genuinely stale node still reports recovery');
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
