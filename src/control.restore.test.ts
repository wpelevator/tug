import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { json, testImageResolver, testIdentity } from '../tests/helpers.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-restore-e2e-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({ identity: testIdentity, images: { resolve: testImageResolver } });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}
const op: Record<string, string> = {
  'x-tug-test-operator': 'operator',
  'content-type': 'application/json',
};
const call = (base: string, method: string, route: string, body?: unknown, headers = op) =>
  fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });

const compose = {
  'x-tug': { backup: { schedule: '0 3 * * *', retention: { daily: 7 } } },
  services: {
    db: {
      image: 'mariadb:11.4',
      'x-tug': {
        placement: { nodes: ['n1'] },
        backup: { command: 'dump-it', restore: 'load-it', filename: 'db.sql' },
      },
    },
    web: {
      image: 'wordpress',
      depends_on: { db: { condition: 'service_started' } },
      'x-tug': { placement: { nodes: ['n1'] } },
    },
  },
};

test('a restore locks the project, holds the writers through the work response, and releases them when done', async () => {
  const s = await server();
  try {
    const node = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
    const agent = {
      'x-tug-test-node': node.agentToken,
      'content-type': 'application/json',
    };
    const work = async () => json(await call(s.base, 'GET', '/agent/v1/work', undefined, agent));
    const report = (body: unknown) => call(s.base, 'POST', '/agent/v1/status', body, agent);

    await call(s.base, 'POST', '/api/v1/deployments', { project: 'site', version: 'v1', compose });
    const revision = (await work()).desiredStates[0].revision;
    const serving = (web: string) => ({
      project: 'site',
      observedVersion: 'v1',
      observedRevision: revision,
      health: 'serving',
      serviceStates: { web: { rolloutState: web }, db: { rolloutState: 'serving' } },
    });
    await report({ projects: [serving('serving')], commandResults: [] });
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 's3:https://s3.example.com/bucket/tug',
      env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
    });

    // A first backup puts a snapshot in the catalog.
    await call(s.base, 'POST', '/api/v1/backups/run', { project: 'site', targets: ['db'] });
    const backupCmd = (await work()).commands.find(
      (c: { type: string }) => c.type === 'backup.run',
    );
    await report({
      projects: [],
      commandResults: [
        {
          commandId: backupCmd.id,
          state: 'succeeded',
          result: { runId: 'x', snapshotId: 'snap0001', durationMs: 1 },
        },
      ],
    });

    const preview = await json(
      await call(s.base, 'POST', '/api/v1/restores', { project: 'site', target: 'db' }),
    );
    assert.equal(preview.confirmed, false, 'without confirm nothing happens');
    assert.deepEqual([preview.plan.snapshotId, preview.plan.writers], ['snap0001', ['web']]);
    assert.equal(
      (await json(await call(s.base, 'GET', '/api/v1/restores?project=site'))).restores.length,
      0,
    );

    const started = await json(
      await call(s.base, 'POST', '/api/v1/restores', {
        project: 'site',
        target: 'db',
        confirm: true,
      }),
    );
    assert.ok(started.restoreId, 'confirm starts the restore');
    assert.deepEqual(
      (await work()).holds,
      { site: ['web'] },
      'the agent is told to stop the writer',
    );

    const blocked = await call(s.base, 'POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v2',
      compose,
    });
    assert.equal(blocked.status, 409, 'deploys are refused while the restore holds the project');
    assert.match((await json(blocked)).error, /locked by restore:/);

    // The agent reports the writer stopped; control takes the safety backup next.
    await report({ projects: [serving('held')], commandResults: [] });
    const safety = (await work()).commands.find((c: { type: string }) => c.type === 'backup.run');
    assert.ok(
      JSON.parse(safety.payload_json).tags.includes('trigger:pre-restore'),
      'a safety backup is taken first',
    );
    await report({
      projects: [],
      commandResults: [
        {
          commandId: safety.id,
          state: 'succeeded',
          result: { runId: 'y', snapshotId: 'safe0001', durationMs: 1 },
        },
      ],
    });

    const restoreCmd = (await work()).commands.find(
      (c: { type: string }) => c.type === 'backup.restore',
    );
    assert.ok(restoreCmd, 'then the restore job is sent to the node');
    const payload = JSON.parse(restoreCmd.payload_json);
    assert.deepEqual(payload.restore, { snapshotId: 'snap0001', mode: 'in-place' });
    assert.deepEqual(payload.command.restoreArgv, ['sh', '-c', 'load-it']);
    await report({
      projects: [],
      commandResults: [
        { commandId: restoreCmd.id, state: 'succeeded', result: { runId: 'z', durationMs: 1 } },
      ],
    });

    const restoreState = async () =>
      (await json(await call(s.base, 'GET', '/api/v1/restores?project=site'))).restores[0].state;
    assert.equal(
      await restoreState(),
      'verifying',
      'the restore waits for WordPress to serve again',
    );
    await report({ projects: [serving('serving')], commandResults: [] });
    const done = (await json(await call(s.base, 'GET', '/api/v1/restores?project=site')))
      .restores[0];
    assert.equal(done.state, 'succeeded');
    assert.equal((await work()).holds, undefined, 'the hold is dropped');
    assert.equal(
      (
        await call(s.base, 'POST', '/api/v1/deployments', {
          project: 'site',
          version: 'v2',
          compose,
        })
      ).status,
      200,
      'the project accepts deploys again',
    );
    const events = JSON.stringify(
      await json(await call(s.base, 'GET', '/api/v1/events?project=site')),
    );
    assert.ok(events.includes('restore.started') && events.includes('restore.completed'));
  } finally {
    await s.close();
  }
});
