import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
import { leftoverLines } from '../cli/commands/restore.ts';
import { parseAge } from '../duration.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { until } from '../../tests/wait.ts';
import { json, testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import type { BackupJobPayload } from '../protocol.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const op: Record<string, string> = {
  'x-tug-test-operator': 'operator',
  'content-type': 'application/json',
};
const call = (
  base: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = op,
) => fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
const DESTINATION = {
  url: 's3:https://s3.example.com/bucket/tug',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
};
const COMPOSE = {
  name: 'site',
  'x-tug': { backup: { schedule: '0 3 * * *', retention: { daily: 7 } } },
  services: {
    db: {
      image: 'mariadb:11.4',
      volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/mysql' }],
      'x-tug': { placement: { nodes: ['n1'] }, backup: { command: 'dump-it', verify: 'done' } },
    },
  },
  volumes: { 'db-data': {} },
};

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-cleanup-'));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TUG_DATA_DIR: dir,
    TUG_BACKUP_TICK_MS: '3600000',
    TUG_RESTIC_IMAGE: 'restic/restic:0.17.3',
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const docker = new FakeDocker();
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
    docker,
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    dbFile: path.join(dir, 'tug.db'),
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

async function deploy(base: string): Promise<{ agent: Record<string, string>; nodeId: string }> {
  const node = await json(await call(base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
  const res = await call(base, 'POST', '/api/v1/deployments', {
    project: 'site',
    version: 'v1',
    compose: COMPOSE,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const agent = { 'x-tug-test-node': node.nodeId, 'content-type': 'application/json' };
  const work = await json(await call(base, 'GET', '/agent/v1/work', undefined, agent));
  await call(
    base,
    'POST',
    '/agent/v1/status',
    {
      projects: [
        {
          project: 'site',
          observedVersion: 'v1',
          observedRevision: work.desiredStates[0].revision,
          health: 'serving',
        },
      ],
      commandResults: [],
    },
    agent,
  );
  // Listing syncs the schedule rows from the deployment.
  await call(base, 'GET', '/api/v1/backups?project=site');
  return { agent, nodeId: node.nodeId };
}

interface Seen {
  type: string;
  payload: Record<string, unknown>;
}
/** Plays the node for `backup.forget` and `restore.remove`, recording what it was asked. */
function serveCleanup(
  base: string,
  agent: Record<string, string>,
  reply: (seen: Seen) => { state: string; result: unknown },
) {
  const seen: Seen[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const work = await json(await call(base, 'GET', '/agent/v1/work', undefined, agent));
      for (const command of work.commands as { id: string; type: string; payload_json: string }[]) {
        if (!['backup.forget', 'restore.remove'].includes(command.type)) continue;
        const item = { type: command.type, payload: JSON.parse(command.payload_json) };
        seen.push(item);
        const { state, result } = reply(item);
        await call(
          base,
          'POST',
          '/agent/v1/status',
          { projects: [], commandResults: [{ commandId: command.id, state, result }] },
          agent,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  return {
    seen,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** A finished in-place restore with its safety backup, and a scratch restore with its volume. */
async function seed(dbFile: string, nodeId: string) {
  const db = await openDb(dbFile);
  const backup = (id: string, snapshot: string) =>
    db.run(
      "INSERT INTO backup_runs(id,project_id,target,type,node_id,trigger,state,finished_at,snapshot_id) VALUES(?, 'site','service:db','command',?,'manual','succeeded',?,?)",
      id,
      nodeId,
      daysAgo(40),
      snapshot,
    );
  backup('bkr_safe_old', 'aaaaaaaa11112222');
  backup('bkr_safe_new', 'bbbbbbbb33334444');
  backup('bkr_safe_failed', 'cccccccc55556666');
  const restore = (
    id: string,
    mode: string,
    state: string,
    age: number,
    extra: { safety?: string; volume?: string } = {},
  ) =>
    db.run(
      `INSERT INTO restore_runs(id,project_id,target,node_id,snapshot_id,mode,scratch_volume,safety_run_id,state,started_at,finished_at)
       VALUES(?,'site','service:db',?,'snap0001',?,?,?,?,?,?)`,
      id,
      nodeId,
      mode,
      extra.volume ?? null,
      extra.safety ?? null,
      state,
      daysAgo(age),
      daysAgo(age),
    );
  restore('rst_old', 'in-place', 'succeeded', 40, { safety: 'bkr_safe_old' });
  restore('rst_new', 'in-place', 'succeeded', 2, { safety: 'bkr_safe_new' });
  restore('rst_failed', 'in-place', 'failed', 40, { safety: 'bkr_safe_failed' });
  restore('rst_scratch', 'scratch', 'succeeded', 3, { volume: 'tug_r4_site_r123' });
  return db;
}

test('restore list shows what restores left, and only restores that finished free their safety snapshot', async () => {
  const s = await server();
  try {
    const { nodeId } = await deploy(s.base);
    await seed(s.dbFile, nodeId);
    const { leftovers } = await json(await call(s.base, 'GET', '/api/v1/restores?project=site'));
    assert.deepEqual(
      leftovers.scratchVolumes.map((v: { restoreId: string; volume: string; node: string }) => [
        v.restoreId,
        v.volume,
        v.node,
      ]),
      [['rst_scratch', 'tug_r4_site_r123', 'n1']],
      'the scratch volume is listed with its node',
    );
    assert.deepEqual(
      leftovers.safetySnapshots.map((v: { restoreId: string }) => v.restoreId).sort(),
      ['rst_new', 'rst_old'],
      'a failed restore keeps its safety snapshot out of the list: it is the copy of what the data was',
    );
    const lines = leftoverLines(leftovers);
    assert.equal(lines.length, 3, 'the CLI prints one line per leftover');
    assert.match(lines.join('\n'), /tug restore remove rst_scratch/, 'each line names the fix');
  } finally {
    await s.close();
  }
});

test('restore remove forgets only that safety snapshot and removes a scratch volume on its node, both audited', async () => {
  const s = await server();
  const stops: (() => Promise<void>)[] = [];
  try {
    const { agent, nodeId } = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const db = await seed(s.dbFile, nodeId);
    const node = serveCleanup(s.base, agent, (item) =>
      item.type === 'backup.forget'
        ? { state: 'succeeded', result: { runId: 'x', durationMs: 1, forgotten: ['aaaaaaaa'] } }
        : { state: 'succeeded', result: { removed: true } },
    );
    stops.push(node.stop);

    const forget = await call(s.base, 'POST', '/api/v1/restores/rst_old/remove', {});
    assert.equal(forget.status, 200, await forget.clone().text());
    const job = node.seen.find((item) => item.type === 'backup.forget')!;
    assert.deepEqual(
      (job.payload as unknown as BackupJobPayload).forget,
      { snapshotIds: ['aaaaaaaa11112222'] },
      'only the safety snapshot of that restore is named',
    );
    const volume = await call(s.base, 'POST', '/api/v1/restores/rst_scratch/remove', {});
    assert.equal(volume.status, 200, await volume.clone().text());
    const removal = node.seen.find((item) => item.type === 'restore.remove')!;
    assert.deepEqual(
      removal.payload,
      { project: 'site', restoreId: 'rst_scratch', volume: 'tug_r4_site_r123' },
      'the node is told which restore the volume belongs to, so it can check its labels',
    );
    const left = await json(await call(s.base, 'GET', '/api/v1/restores?project=site'));
    assert.deepEqual(
      left.leftovers.safetySnapshots.map((v: { restoreId: string }) => v.restoreId),
      ['rst_new'],
      'the removed ones are gone from the list and the other stays',
    );
    assert.equal(left.leftovers.scratchVolumes.length, 0, 'the scratch volume is gone');
    assert.equal(
      db.all("SELECT 1 FROM events WHERE type='restore.removed'").length,
      2,
      'each removal is audited',
    );
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/restores/rst_old/remove', {})).status,
      409,
      'a restore with nothing left refuses with a reason',
    );
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/restores/rst_failed/remove', {})).status,
      409,
      'a failed restore keeps its safety snapshot',
    );
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/restores/rst_nope/remove', {})).status,
      404,
      'an unknown restore is not found',
    );
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

test('expire-safety forgets the safety snapshots older than the age in one job', async () => {
  const s = await server();
  const stops: (() => Promise<void>)[] = [];
  try {
    const { agent, nodeId } = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    await seed(s.dbFile, nodeId);
    const node = serveCleanup(s.base, agent, () => ({
      state: 'succeeded',
      result: { runId: 'x', durationMs: 1, forgotten: [] },
    }));
    stops.push(node.stop);
    assert.equal(
      (
        await call(s.base, 'POST', '/api/v1/restores/expire-safety', {
          project: 'site',
          olderThan: 'soon',
        })
      ).status,
      400,
      'an age that is not one is refused',
    );
    const res = await call(s.base, 'POST', '/api/v1/restores/expire-safety', {
      project: 'site',
      olderThan: '30d',
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(
      (await json(res)).expired.map((item: { restoreId: string }) => item.restoreId),
      ['rst_old'],
      'only the restore older than 30 days expires; the recent one is kept',
    );
    assert.equal(node.seen.length, 1, 'one forget job covers them all');
    const again = await json(
      await call(s.base, 'POST', '/api/v1/restores/expire-safety', {
        project: 'site',
        olderThan: '30d',
      }),
    );
    assert.deepEqual(again.expired, [], 'nothing is left to expire the second time');
    assert.equal(node.seen.length, 1, 'and no job is queued for nothing');
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

test('an append-only destination refuses to forget a safety snapshot and says why, before any job is queued', async () => {
  const s = await server();
  const stops: (() => Promise<void>)[] = [];
  try {
    const { agent, nodeId } = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      ...DESTINATION,
      retention: 'external',
    });
    await seed(s.dbFile, nodeId);
    const node = serveCleanup(s.base, agent, () => ({ state: 'succeeded', result: {} }));
    stops.push(node.stop);
    for (const [route, body] of [
      ['/api/v1/restores/rst_old/remove', {}],
      ['/api/v1/restores/expire-safety', { project: 'site', olderThan: '30d' }],
    ] as const) {
      const res = await call(s.base, 'POST', route, body);
      assert.equal(res.status, 409, `${route} is refused`);
      assert.match((await json(res)).error, /append-only.*storage side/, 'the reason is given');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(node.seen.length, 0, 'nothing was queued for the node');
    // A scratch volume is not in the repository, so it can still be removed.
    const scratch = serveCleanup(s.base, agent, () => ({
      state: 'succeeded',
      result: { removed: true },
    }));
    stops.push(scratch.stop);
    await until(async () => {
      const res = await call(s.base, 'POST', '/api/v1/restores/rst_scratch/remove', {});
      return res.status === 200;
    }, 'the scratch volume to be removed despite an append-only destination');
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

test('ages parse as minutes, hours, days and weeks only', () => {
  assert.equal(parseAge('90m'), 90 * 60_000, 'minutes');
  assert.equal(parseAge('12h'), 12 * 3_600_000, 'hours');
  assert.equal(parseAge('30d'), 30 * 86_400_000, 'days');
  assert.equal(parseAge('2w'), 14 * 86_400_000, 'weeks');
  for (const bad of ['', '0d', '5', 'd', '-1d', '1y', 'soon', undefined])
    assert.equal(parseAge(bad), null, `${String(bad)} is not an age`);
});
