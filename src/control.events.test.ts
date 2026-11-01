import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { testImageResolver, testIdentity } from '../tests/helpers.ts';
import { openDb } from './db.ts';
import { json } from '../tests/helpers.ts';

const DAY = 86_400_000;
const op = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };

/** Writes events straight into a control database: `name` with a creation time `ageMs` in the past. */
async function seed(dir: string, events: { name: string; ageMs: number }[]) {
  const db = await openDb(path.join(dir, 'tug.db'));
  for (const { name, ageMs } of events) {
    db.run(
      'INSERT INTO events(id,project_id,level,type,message,created_at) VALUES(?,?,?,?,?,?)',
      name,
      'site',
      'info',
      'service.serving',
      name,
      new Date(Date.now() - ageMs).toISOString(),
    );
  }
  db.close();
}
async function makeServer(
  options: Parameters<typeof createApp>[0] = {},
  env: Record<string, string | undefined> = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-events-'));
  const restore = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  return {
    dir,
    async start() {
      process.env.TUG_DATA_DIR = dir;
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const app = await createApp({
        identity: testIdentity,
        ...options,
        images: { resolve: testImageResolver },
      });
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const srv = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      return {
        base,
        events: async () =>
          (
            (await json(await fetch(`${base}/api/v1/events?limit=500`, { headers: op })))
              .events as { message: string }[]
          )
            .map((e) => e.message)
            .sort(),
        close: () => new Promise((resolve) => srv.close(resolve)),
      };
    },
  };
}

test('events older than the retention period are deleted when control starts', async () => {
  const s = await makeServer();
  await seed(s.dir, [
    { name: 'old', ageMs: 60 * DAY },
    { name: 'edge', ageMs: 29 * DAY },
    { name: 'new', ageMs: 1000 },
  ]);
  const srv = await s.start();
  try {
    assert.deepEqual(
      await srv.events(),
      ['edge', 'new'],
      'events past the 30 day default are gone and younger ones stay',
    );
  } finally {
    await srv.close();
  }
});

test('only the newest TUG_EVENT_MAX_ROWS events are kept', async () => {
  const s = await makeServer({}, { TUG_EVENT_MAX_ROWS: '3' });
  await seed(
    s.dir,
    Array.from({ length: 8 }, (_, i) => ({ name: `e${i}`, ageMs: (8 - i) * 1000 })),
  );
  const srv = await s.start();
  try {
    assert.deepEqual(
      await srv.events(),
      ['e5', 'e6', 'e7'],
      'the three most recent events survive the row cap',
    );
  } finally {
    await srv.close();
  }
});

test('0 turns a retention limit off', async () => {
  const s = await makeServer({}, { TUG_EVENT_RETENTION_DAYS: '0', TUG_EVENT_MAX_ROWS: '0' });
  await seed(s.dir, [
    { name: 'ancient', ageMs: 400 * DAY },
    { name: 'new', ageMs: 1000 },
  ]);
  const srv = await s.start();
  try {
    assert.deepEqual(
      await srv.events(),
      ['ancient', 'new'],
      'neither the age limit nor the row cap applies',
    );
  } finally {
    await srv.close();
  }
});

test('a retention setting that is not a whole number falls back to the default', async () => {
  const s = await makeServer({}, { TUG_EVENT_RETENTION_DAYS: 'a month', TUG_EVENT_MAX_ROWS: '-5' });
  await seed(s.dir, [
    { name: 'old', ageMs: 60 * DAY },
    { name: 'new', ageMs: 1000 },
  ]);
  const srv = await s.start();
  try {
    assert.deepEqual(
      await srv.events(),
      ['new'],
      'the 30 day default still applies when the setting is invalid',
    );
  } finally {
    await srv.close();
  }
});

test('agent reports prune old events, but at most once per interval', async () => {
  for (const [intervalMs, expected] of [
    [0, ['fresh', 'new']],
    [3_600_000, ['ancient', 'fresh', 'new']],
  ] as const) {
    const s = await makeServer({ eventPruneIntervalMs: intervalMs });
    const srv = await s.start();
    try {
      const node = await json(
        await fetch(`${srv.base}/api/v1/nodes/register`, {
          method: 'POST',
          headers: op,
          body: JSON.stringify({ name: 'n1' }),
        }),
      );
      await seed(s.dir, [
        { name: 'ancient', ageMs: 90 * DAY },
        { name: 'new', ageMs: 1000 },
      ]);
      const report = await fetch(`${srv.base}/agent/v1/events`, {
        method: 'POST',
        headers: { 'x-tug-test-node': node.agentToken, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'site', type: 'service.serving', message: 'fresh' }),
      });
      assert.equal(report.status, 200, 'the agent report itself succeeds');
      assert.deepEqual(
        await srv.events(),
        [...expected],
        intervalMs === 0
          ? 'an overdue prune runs when an agent reports'
          : 'a prune that ran moments ago is not repeated on every report',
      );
    } finally {
      await srv.close();
    }
  }
});
