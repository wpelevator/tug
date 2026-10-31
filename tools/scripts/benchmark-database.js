#!/usr/bin/env node
// Synthetic reference workload; report blocking rather than setting hardware-dependent CI thresholds.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openDb, openSnapshotDb } from '../../src/db.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-db-benchmark-'));
const report = { node: process.version, events: 100_000, metadataQueries: 1000 };
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
async function measure(operation) {
  await delay(5);
  const start = performance.now();
  const timer = delay(0).then(() => performance.now() - start);
  operation();
  return {
    elapsedMs: Number((performance.now() - start).toFixed(2)),
    timerDelayMs: Number((await timer).toFixed(2)),
  };
}
let db;
try {
  db = await openDb(path.join(dir, 'state.db'));
  db.run('INSERT INTO projects(id,name) VALUES(?,?)', 'benchmark', 'benchmark');
  db.exec('BEGIN IMMEDIATE');
  try {
    const message = 'event payload '.repeat(40);
    for (let index = 0; index < report.events; index++) {
      db.run(
        'INSERT INTO events(id,project_id,message,created_at) VALUES(?,?,?,?)',
        `event-${index}`,
        'benchmark',
        message,
        new Date().toISOString(),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  loop.reset();
  report.metadata = await measure(() => {
    for (let index = 0; index < report.metadataQueries; index++)
      db.get('SELECT * FROM projects WHERE id=?', 'benchmark');
  });
  const snapshot = path.join(dir, 'snapshot.db');
  report.snapshot = await measure(() => db.run('VACUUM INTO ?', snapshot));
  report.snapshotBytes = (await fs.stat(snapshot)).size;
  const readOnly = openSnapshotDb(snapshot);
  try {
    report.integrity = await measure(() => readOnly.get('PRAGMA integrity_check'));
  } finally {
    readOnly.close();
  }
  await delay(5);
  report.eventLoopMaxMs = Number((loop.max / 1e6).toFixed(2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  loop.disable();
  db?.close();
  await fs.rm(dir, { recursive: true, force: true });
}
