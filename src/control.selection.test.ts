import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import { createApp } from './control.ts';
import { openDb } from './db.ts';
import { json, testControlUrl, testIdentity, testImageResolver } from '../tests/helpers.ts';

test('selection discovery uses desired placement, filters catalogs and enforces project scope', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-selection-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
  });
  const server = await new Promise<Server>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
  const db = await openDb(path.join(dir, 'tug.db'));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (route: string, credential?: string) =>
    fetch(base + route, {
      headers: credential
        ? { 'x-tug-test-credential': credential }
        : { 'x-tug-test-operator': 'operator' },
    });
  const post = async (route: string, body: unknown) =>
    json(
      await fetch(base + route, {
        method: 'POST',
        headers: { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  try {
    // Seed authoritative state directly: no node report is required to discover a service.
    for (const project of ['a', 'b']) {
      db.run(
        'INSERT INTO projects(id,name,current_deployment_id) VALUES(?,?,?)',
        project,
        project,
        `dep_${project}`,
      );
      db.run(
        'INSERT INTO deployments(id,project_id,version,state,created_at) VALUES(?,?,?,?,?)',
        `dep_${project}`,
        project,
        'v1',
        'rolling_out',
        '2000-01-01',
      );
      db.run(
        'INSERT INTO desired_states(id,project_id,deployment_id,version,state_json) VALUES(?,?,?,?,?)',
        `ds_${project}`,
        project,
        `dep_${project}`,
        'v1',
        JSON.stringify({
          project,
          services: {
            web: { placement: { nodes: ['n1'] } },
            worker: { placement: { nodes: ['n2'] } },
          },
        }),
      );
    }
    db.run("INSERT INTO nodes(id,name,status,labels_json) VALUES('n1','n1','registered','[]')");
    db.run(
      "INSERT INTO nodes(id,name,status,last_seen_at,labels_json) VALUES('n2','n2','online','2000-01-01','[]')",
    );
    for (let i = 0; i < 30; i++)
      db.run(
        'INSERT INTO deployments(id,project_id,version,state,created_at) VALUES(?,?,?,?,?)',
        `done_${i}`,
        'a',
        'new',
        'succeeded',
        '2099-01-01',
      );
    for (const [id, project, target, state, snapshot, trigger] of [
      ['bkr_ok', 'a', 'service:db', 'succeeded', 'snap1', 'manual'],
      ['bkr_safety', 'a', 'service:db', 'succeeded', 'snap2', 'pre-restore'],
      ['bkr_failed', 'a', 'service:db', 'failed', 'snap3', 'manual'],
      ['bkr_empty', 'a', 'service:db', 'succeeded', null, 'manual'],
      ['bkr_other', 'a', 'volume:files', 'succeeded', 'snap4', 'manual'],
      ['bkr_foreign', 'b', 'service:db', 'succeeded', 'snap5', 'manual'],
    ])
      db.run(
        'INSERT INTO backup_runs(id,project_id,target,type,trigger,state,snapshot_id,finished_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        project,
        target,
        'service',
        trigger,
        state,
        snapshot,
        '2026-11-03',
      );
    db.run("INSERT INTO service_holds(project_id,service,reason) VALUES('a','web','move')");
    db.run(
      "INSERT INTO service_holds(project_id,service,reason,restore_id) VALUES('a','worker','restore','rst_1')",
    );
    const credential = (
      await post('/api/v1/credentials', { name: 'a-reader', role: 'read', projects: ['a'] })
    ).credential;
    const serviceResult = await json(await call('/api/v1/services?project=a', credential));
    assert.deepEqual(
      serviceResult.services,
      [
        { name: 'web', nodes: [{ name: 'n1', status: 'registered' }] },
        { name: 'worker', nodes: [{ name: 'n2', status: 'stale' }] },
      ],
      'service options should use current desired placements even before node reports arrive',
    );
    assert.deepEqual(
      (await json(await call('/api/v1/projects', credential))).projects,
      [{ name: 'a' }],
      'project choices must exclude unauthorized projects',
    );
    assert.deepEqual(
      (await json(await call('/api/v1/deployments?project=a', credential))).deployments.map(
        (row: { id: string }) => row.id,
      ),
      ['dep_a'],
      'active deployments must remain discoverable beyond the status endpoint history limit',
    );
    assert.deepEqual(
      (
        await json(await call('/api/v1/backup/snapshots?project=a&target=service:db', credential))
      ).snapshots
        .map((row: { id: string }) => row.id)
        .sort(),
      ['bkr_ok', 'bkr_safety'],
      'snapshot choices must include only successful catalog backups for the selected project and target, including labeled safety backups',
    );
    assert.equal(
      (await call('/api/v1/backup/snapshots?project=a', credential)).status,
      400,
      'snapshot discovery must require a target',
    );
    for (const route of [
      '/api/v1/services',
      '/api/v1/deployments',
      '/api/v1/backup/snapshots?target=service:db',
    ]) {
      const query = route.includes('?') ? '&' : '?';
      for (const project of ['b', 'unknown'])
        assert.equal(
          (await call(`${route}${query}project=${project}`, credential)).status,
          403,
          'discovery must reject both existing and nonexistent unauthorized projects identically',
        );
    }
    assert.equal(
      (await call('/api/v1/holds?project=a', credential)).status,
      403,
      'move hold discovery must require admin',
    );
    assert.deepEqual(
      (await json(await call('/api/v1/holds?project=a'))).holds.map(
        (row: { service: string }) => row.service,
      ),
      ['web'],
      'hold release choices must exclude restore-owned holds',
    );
  } finally {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
