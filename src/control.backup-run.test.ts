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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-bkrun-'));
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
      environment: {
        MARIADB_DATABASE: 'wordpress',
        MARIADB_ROOT_PASSWORD: '@@tug:secret:DB_ROOT_PASSWORD@@',
      },
      volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/mysql' }],
      'x-tug': {
        placement: { nodes: ['n1'] },
        backup: { command: 'dump-it "$DB_PASSWORD"', verify: 'done' },
      },
    },
  },
  volumes: { 'db-data': {} },
};

test('a manual backup flows from the API through the agent protocol to the catalog', async () => {
  const s = await server();
  try {
    const node = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
    const agent = {
      'x-tug-test-node': node.nodeId,
      'content-type': 'application/json',
    };
    await call(s.base, 'POST', '/api/v1/secrets', {
      project: 'site',
      name: 'DB_ROOT_PASSWORD',
      value: 'rootpw-123',
    });
    const deploy = await call(s.base, 'POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose,
    });
    assert.equal(deploy.status, 200, await deploy.clone().text());
    let work = await json(await call(s.base, 'GET', '/agent/v1/work', undefined, agent));
    await call(
      s.base,
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

    const noDestination = await call(s.base, 'POST', '/api/v1/backups/run', { project: 'site' });
    assert.equal(
      noDestination.status,
      409,
      'a backup without a destination is refused with the reason',
    );
    assert.match((await json(noDestination)).error, /no backup destination/);

    await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 's3:https://s3.example.com/bucket/tug',
      env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
    });
    const run = await json(
      await call(s.base, 'POST', '/api/v1/backups/run', { project: 'site', targets: ['db'] }),
    );
    assert.equal(run.runs.length, 1, 'one backup is queued');

    work = await json(await call(s.base, 'GET', '/agent/v1/work', undefined, agent));
    const command = work.commands.find((c: { type: string }) => c.type === 'backup.run');
    assert.ok(command, 'the agent receives a backup.run command');
    const payload = JSON.parse(command.payload_json);
    assert.equal(payload.repository, 's3:https://s3.example.com/bucket/tug/site');
    assert.deepEqual(payload.command.argv, ['sh', '-c', 'dump-it "$DB_PASSWORD"']);
    assert.ok(
      !command.payload_json.includes('sekret-value-1') &&
        !command.payload_json.includes('rootpw-123'),
      'no secret rides in the payload',
    );

    const credentials = await json(
      await call(
        s.base,
        'GET',
        `/agent/v1/backup/credentials?command=${command.id}`,
        undefined,
        agent,
      ),
    );
    assert.deepEqual(
      Object.keys(credentials.env).sort(),
      ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RESTIC_PASSWORD'],
      'only repository credentials are released; the command reads its own environment',
    );
    assert.equal(credentials.env.AWS_SECRET_ACCESS_KEY, 'sekret-value-1');

    await call(
      s.base,
      'POST',
      '/agent/v1/status',
      {
        projects: [],
        commandResults: [],
        jobs: [
          {
            commandId: command.id,
            runId: payload.runId,
            phase: 'dumping',
            startedAt: new Date().toISOString(),
          },
        ],
      },
      agent,
    );
    let listing = await json(await call(s.base, 'GET', '/api/v1/backups?project=site'));
    assert.equal(listing.runs[0].state, 'running', 'a heartbeat marks the run running');

    await call(
      s.base,
      'POST',
      '/agent/v1/status',
      {
        projects: [],
        commandResults: [
          {
            commandId: command.id,
            state: 'succeeded',
            result: {
              runId: payload.runId,
              snapshotId: 'abcdef1234567890',
              addedBytes: 100,
              totalBytes: 500,
              durationMs: 42,
            },
          },
        ],
      },
      agent,
    );
    listing = await json(await call(s.base, 'GET', '/api/v1/backups?project=site'));
    assert.deepEqual(
      [listing.runs[0].state, listing.runs[0].snapshot_id, listing.runs[0].trigger],
      ['succeeded', 'abcdef1234567890', 'manual'],
    );
    assert.ok(listing.targets[0].lastSuccessAt, 'the target shows its last success');
    assert.equal(listing.targets[0].node, 'n1');
    assert.equal(listing.targets[0].problem, null, 'a freshly backed up target has no problem');

    const events = await json(await call(s.base, 'GET', '/api/v1/events?project=site'));
    assert.ok(
      JSON.stringify(events).includes('backup.completed'),
      'completion is in the event stream',
    );
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/backups/run', { project: 'site', targets: ['ghost'] }))
        .status,
      409,
      'unknown targets are refused',
    );
  } finally {
    await s.close();
  }
});
