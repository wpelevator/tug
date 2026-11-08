import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
import { json, testControlUrl, testIdentity, testImageResolver } from '../../tests/helpers.ts';

test('the node list calls a node stale as soon as its last contact is outside the window, like status does', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-node-list-'));
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
  const get = async (route: string) =>
    json(
      await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${route}`, {
        headers: { 'x-tug-test-operator': 'operator' },
      }),
    );
  const listed = async () =>
    Object.fromEntries(
      ((await get('/api/v1/nodes')) as { nodes: { name: string; status: string }[] }).nodes.map(
        (n) => [n.name, n.status],
      ),
    );
  try {
    const fresh = new Date().toISOString();
    db.run(
      "INSERT INTO nodes(id,name,status,last_seen_at,labels_json) VALUES('n1','fresh','online',?,'[]')",
      fresh,
    );
    db.run(
      "INSERT INTO nodes(id,name,status,last_seen_at,labels_json) VALUES('n2','silent','online','2000-01-01T00:00:00.000Z','[]')",
    );
    db.run("INSERT INTO nodes(id,name,status,labels_json) VALUES('n3','new','registered','[]')");
    db.run(
      "INSERT INTO nodes(id,name,status,last_seen_at,disabled_at,labels_json) VALUES('n4','off','online','2000-01-01T00:00:00.000Z','2026-01-01','[]')",
    );
    assert.deepEqual(
      await listed(),
      { fresh: 'online', silent: 'stale', new: 'registered', off: 'disabled' },
      'a silent node lists as stale without anyone having read /status first; a fresh node stays online, a never-seen one stays registered and a disabled one is disabled',
    );
    const status = (await get('/api/v1/status')) as { nodes: { name: string; status: string }[] };
    assert.equal(
      status.nodes.find((n) => n.name === 'silent')?.status,
      'stale',
      'status and the node list agree about the silent node',
    );
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
});
