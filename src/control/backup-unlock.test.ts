import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
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

async function server(docker: FakeDocker) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-unlock-'));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TUG_DATA_DIR: dir,
    TUG_CONTROL_BACKUP_DIR: path.join(dir, 'control-backups'),
    TUG_RESTIC_IMAGE: 'restic/restic:0.17.3',
    TUG_BACKUP_TICK_MS: '3600000',
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
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

/** A restic that lists `before` locks until `unlock` runs and `after` locks from then on. */
function lockedDocker(before: string[], after: string[]): FakeDocker {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.17.3');
  let unlocked = false;
  docker.execResponder = (cmd) => {
    const line = cmd.join(' ');
    if (line === 'restic unlock') {
      unlocked = true;
      return { code: 0 };
    }
    if (line === 'restic list locks --no-lock')
      return { code: 0, out: (unlocked ? after : before).map((id) => `${id}\n`).join('') };
    return { code: 0 };
  };
  return docker;
}

async function deploy(base: string): Promise<Record<string, string>> {
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
  return agent;
}

/** Plays the node for `backup.unlock` commands: answers each with `reply` once `gate` resolves. */
function serveUnlocks(
  base: string,
  agent: Record<string, string>,
  reply: (payload: BackupJobPayload) => { state: string; result: unknown },
  gate: Promise<void> = Promise.resolve(),
) {
  const seen: { payload: BackupJobPayload; credentials: number }[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const work = await json(await call(base, 'GET', '/agent/v1/work', undefined, agent));
      for (const command of work.commands as { id: string; type: string; payload_json: string }[]) {
        if (command.type !== 'backup.unlock') continue;
        const payload = JSON.parse(command.payload_json) as BackupJobPayload;
        const credentials = (
          await call(
            base,
            'GET',
            `/agent/v1/backup/credentials?command=${command.id}`,
            undefined,
            agent,
          )
        ).status;
        seen.push({ payload, credentials });
        await gate;
        const { state, result } = reply(payload);
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
const events = async (dbFile: string, type: string) =>
  (await openDb(dbFile)).all<{ message: string; metadata_json: string }>(
    'SELECT message,metadata_json FROM events WHERE type=?',
    type,
  );

test('unlocking the control repository removes stale locks from control, reports the counts and is audited', async () => {
  const docker = lockedDocker(['aaaaaaaa11', 'bbbbbbbb22', 'cccccccc33'], ['cccccccc33']);
  const s = await server(docker);
  try {
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/backups/unlock', { control: true })).status,
      409,
      'an unlock without a destination is refused with a reason',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const res = await call(s.base, 'POST', '/api/v1/backups/unlock', { control: true });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json(res);
    assert.equal(body.removed, 2, 'the locks that went away are counted');
    assert.equal(body.remaining, 1, 'the lock a live restic holds remains');
    assert.match(body.note, /30 minutes/, 'what remains is explained');
    assert.ok(
      docker.execOptions.some((e) => e.cmd.join(' ') === 'restic unlock'),
      'plain restic unlock ran',
    );
    assert.ok(
      !docker.execOptions.some((e) => e.cmd.includes('--remove-all')),
      'the live lock of a prune elsewhere is never force-removed',
    );
    const audited = await events(s.dbFile, 'backup.unlock');
    assert.equal(audited.length, 1, 'the unlock is audited');
    assert.equal(
      JSON.parse(audited[0].metadata_json).control,
      true,
      'the audit says it was control',
    );
  } finally {
    await s.close();
  }
});

test('unlocking a project queues backup.unlock on the node that runs its backups, with credentials, and does not take the project lock', async () => {
  const s = await server(lockedDocker([], []));
  const stops: (() => Promise<void>)[] = [];
  try {
    const agent = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/backups/unlock', { project: 'nope' })).status,
      404,
      'an unknown project is refused',
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const node = serveUnlocks(
      s.base,
      agent,
      (payload) => ({
        state: 'succeeded',
        result: { runId: payload.runId, durationMs: 1, unlock: { before: 2, after: 0 } },
      }),
      gate,
    );
    stops.push(node.stop);
    const first = call(s.base, 'POST', '/api/v1/backups/unlock', { project: 'site' });
    await until(() => node.seen.length === 1, 'the node to take the unlock command');
    const deploying = await call(s.base, 'POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v2',
      compose: COMPOSE,
    });
    assert.equal(
      deploying.status,
      200,
      `a deploy is not blocked while an unlock runs, because unlock takes no project lock: ${await deploying.clone().text()}`,
    );
    release();
    const res = await first;
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json(res);
    assert.deepEqual(
      { removed: body.removed, remaining: body.remaining, node: body.node, project: body.project },
      { removed: 2, remaining: 0, node: 'n1', project: 'site' },
      'the node result is relayed',
    );
    assert.equal(body.note, undefined, 'nothing remains, so there is nothing to explain');
    assert.equal(node.seen[0].credentials, 200, 'the node may open the repository credentials');
    assert.ok(
      node.seen[0].payload.repository.endsWith('/site'),
      "the job targets the project's own repository",
    );
    assert.equal((await events(s.dbFile, 'backup.unlock')).length, 1, 'the unlock is audited once');
    const again = call(s.base, 'POST', '/api/v1/backups/unlock', { project: 'site' });
    assert.equal((await again).status, 200, 'a second unlock runs after the first finished');
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

test('a failed unlock on the node is reported as a bad gateway with its reason', async () => {
  const s = await server(lockedDocker([], []));
  const stops: (() => Promise<void>)[] = [];
  try {
    const agent = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const node = serveUnlocks(s.base, agent, () => ({
      state: 'failed',
      result: { error: 'unlock failed: Fatal: unable to open repository' },
    }));
    stops.push(node.stop);
    const res = await call(s.base, 'POST', '/api/v1/backups/unlock', { project: 'site' });
    assert.equal(res.status, 502, `a node failure is not a success: ${await res.clone().text()}`);
    assert.match((await json(res)).error, /unable to open repository/, 'the reason is shown');
    assert.equal(
      (await events(s.dbFile, 'backup.unlock')).length,
      0,
      'a failed unlock is not audited as done',
    );
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});
