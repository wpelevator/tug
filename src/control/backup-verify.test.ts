import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
import { backupCheckProblems } from '../backup/check.ts';
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

async function server(docker: FakeDocker, tickMs = '3600000') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-verify-'));
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    TUG_DATA_DIR: dir,
    TUG_CONTROL_BACKUP_DIR: path.join(dir, 'control-backups'),
    TUG_RESTIC_IMAGE: 'restic/restic:0.17.3',
    TUG_BACKUP_TICK_MS: tickMs,
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
const restic = () => {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.17.3');
  docker.execResponder = () => ({ code: 0 });
  return docker;
};

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

/** Plays the node for `backup.maintain` commands, answering each with `reply`. */
function serveMaintenance(
  base: string,
  agent: Record<string, string>,
  reply: (payload: BackupJobPayload) => { state: string; result: unknown },
) {
  const seen: BackupJobPayload[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const work = await json(await call(base, 'GET', '/agent/v1/work', undefined, agent));
      for (const command of work.commands as { id: string; type: string; payload_json: string }[]) {
        if (command.type !== 'backup.maintain') continue;
        const payload = JSON.parse(command.payload_json) as BackupJobPayload;
        seen.push(payload);
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
const passed = (payload: BackupJobPayload) => ({
  state: 'succeeded',
  result: {
    runId: payload.runId,
    durationMs: 1,
    maintenance: {
      prune: payload.maintain?.prune ? 'ok' : 'skipped',
      check: 'ok',
      ...(payload.maintain?.subset ? { subset: payload.maintain.subset } : {}),
    },
  },
});
const failedCheck = (payload: BackupJobPayload) => ({
  state: 'succeeded',
  result: {
    runId: payload.runId,
    durationMs: 1,
    maintenance: {
      prune: 'skipped',
      check: 'failed',
      message: 'check failed: pack abc is damaged',
    },
  },
});
const listing = async (base: string) =>
  json(await call(base, 'GET', '/api/v1/backups?project=site'));
const events = async (dbFile: string, type: string) =>
  (await openDb(dbFile)).all<{ message: string; project_id: string; metadata_json: string }>(
    'SELECT message,project_id,metadata_json FROM events WHERE type=?',
    type,
  );
/** Gives the project's target a recent success, as a finished backup would. */
async function backedUp(
  base: string,
  dbFile: string,
  at = new Date(Date.now() - 60_000).toISOString(),
) {
  // Listing syncs the schedule rows from the deployment, so the target exists to be updated.
  await call(base, 'GET', '/api/v1/backups?project=site');
  const db = await openDb(dbFile);
  db.run(
    "UPDATE backup_schedules SET last_success_at=?,last_status='succeeded',last_run_at=? WHERE project_id='site'",
    at,
    at,
  );
}

test('backup verify checks the repository in the background, records it, and raises the protection level', async () => {
  const s = await server(restic());
  const stops: (() => Promise<void>)[] = [];
  try {
    const agent = await deploy(s.base);
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/backups/verify', { project: 'site' })).status,
      409,
      'a verify without a destination is refused with a reason',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    await backedUp(s.base, s.dbFile);
    assert.equal(
      (await listing(s.base)).targets[0].protection,
      'off-host',
      'a recent off-host success is off-host and no more',
    );
    assert.equal(
      (
        await call(s.base, 'POST', '/api/v1/backups/verify', {
          project: 'site',
          readDataSubset: 'all',
        })
      ).status,
      400,
      'a subset restic would not accept is refused',
    );
    const node = serveMaintenance(s.base, agent, passed);
    stops.push(node.stop);
    const res = await call(s.base, 'POST', '/api/v1/backups/verify', {
      project: 'site',
      readDataSubset: '5%',
    });
    assert.equal(res.status, 202, 'a verify starts in the background');
    const audited = await events(s.dbFile, 'backup.verify');
    assert.equal(audited.length, 1, 'an accepted verify is audited once, with who asked');
    assert.match(
      audited[0].message,
      /repository check of site started by operator/,
      'the audit entry names the project and the actor',
    );
    await until(
      async () => (await listing(s.base)).verify?.ok === true,
      'the check to be recorded',
    );
    assert.deepEqual(
      node.seen.map((payload) => payload.maintain),
      [{ prune: false, subset: '5%' }],
      'a manual verify checks and never prunes',
    );
    const shown = await listing(s.base);
    assert.equal(shown.verify.subset, '5%', 'the record says what was read');
    assert.equal(shown.verify.trigger, 'manual', 'the record says who asked');
    assert.equal(shown.targets[0].protection, 'verified', 'a passing check verifies the target');
    assert.deepEqual(backupCheckProblems(shown), [], 'a passing check is no problem');
    await backedUp(s.base, s.dbFile, new Date().toISOString());
    assert.equal(
      (await listing(s.base)).targets[0].protection,
      'verified',
      'a backup made after the check keeps the level, as daily backups follow a weekly check',
    );

    const db = await openDb(s.dbFile);
    db.run(
      "INSERT INTO restore_runs(id,project_id,target,snapshot_id,mode,state,finished_at) VALUES('rst_1','site','service:db','snap1234','scratch','succeeded',?)",
      new Date().toISOString(),
    );
    assert.equal(
      (await listing(s.base)).targets[0].protection,
      'restore-tested',
      'a succeeded scratch restore completes the ladder',
    );
    db.run(
      "UPDATE restore_runs SET finished_at=? WHERE id='rst_1'",
      new Date(Date.now() - 91 * 24 * 3_600_000).toISOString(),
    );
    assert.equal(
      (await listing(s.base)).targets[0].protection,
      'verified',
      'a scratch restore older than 90 days no longer counts',
    );

    await call(s.base, 'POST', '/api/v1/backup/destination', {
      ...DESTINATION,
      url: 's3:https://s3.example.com/other/tug',
    });
    assert.equal(
      (await listing(s.base)).verify,
      null,
      'results describe the old destination and are dropped with it',
    );
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

test('a failing check alerts once, turns --check red, and a later pass clears it with a recovery event', async () => {
  const s = await server(restic());
  const stops: (() => Promise<void>)[] = [];
  try {
    const agent = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    await backedUp(s.base, s.dbFile);
    let reply: (payload: BackupJobPayload) => { state: string; result: unknown } = failedCheck;
    const node = serveMaintenance(s.base, agent, (payload) => reply(payload));
    stops.push(node.stop);
    const verify = async (count: number) => {
      assert.equal(
        (await call(s.base, 'POST', '/api/v1/backups/verify', { project: 'site' })).status,
        202,
      );
      await until(() => node.seen.length === count, `${count} maintenance job(s) taken`);
      await until(
        async () => (await listing(s.base)).maintenanceRunning === false,
        'the check to finish',
      );
    };
    await verify(1);
    await verify(2);
    const shown = await listing(s.base);
    assert.equal(shown.verify.ok, false, 'the failed check is recorded');
    assert.equal(
      (await listing(s.base)).targets[0].protection,
      'off-host',
      'a failed check does not verify the target',
    );
    assert.match(
      backupCheckProblems(shown).join('\n'),
      /repository check or prune failed.*pack abc is damaged/,
      '--check names the failure',
    );
    assert.equal(
      (await events(s.dbFile, 'backup.verify_failed')).length,
      1,
      'a check that keeps failing alerts once, not per run',
    );
    reply = passed;
    await verify(3);
    assert.equal((await listing(s.base)).verify.ok, true, 'a later pass replaces the failure');
    assert.equal(
      (await events(s.dbFile, 'backup.verify_recovered')).length,
      1,
      'the recovery is announced once',
    );
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

const lockedPrune = (payload: BackupJobPayload) => ({
  state: 'succeeded',
  result: {
    runId: payload.runId,
    durationMs: 1,
    maintenance: {
      prune: 'failed',
      check: 'ok',
      locked: true,
      message: 'prune failed: unable to create lock in backend: repository is already locked',
    },
  },
});

test('one locked prune does not fail --check or alert, two in a row do, and a pass recovers', async () => {
  const s = await server(restic());
  const stops: (() => Promise<void>)[] = [];
  try {
    const agent = await deploy(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    await backedUp(s.base, s.dbFile);
    let reply: (payload: BackupJobPayload) => { state: string; result: unknown } = lockedPrune;
    const node = serveMaintenance(s.base, agent, (payload) => reply(payload));
    stops.push(node.stop);
    const verify = async (count: number) => {
      assert.equal(
        (await call(s.base, 'POST', '/api/v1/backups/verify', { project: 'site' })).status,
        202,
      );
      await until(() => node.seen.length === count, `${count} maintenance job(s) taken`);
      await until(
        async () => (await listing(s.base)).maintenanceRunning === false,
        'the check to finish',
      );
    };
    await verify(1);
    const once = await listing(s.base);
    assert.equal(once.verify.ok, false, 'the failed prune is recorded');
    assert.equal(once.verify.failures, 1, 'the record counts one failure');
    assert.deepEqual(
      backupCheckProblems(once),
      [],
      'a prune that overlapped another lock holder does not fail --check the first time',
    );
    assert.equal(
      (await events(s.dbFile, 'backup.verify_failed')).length,
      0,
      'no alert for a single lock overlap',
    );
    await verify(2);
    const twice = await listing(s.base);
    assert.equal(twice.verify.failures, 2, 'the record counts two failures in a row');
    assert.match(
      backupCheckProblems(twice).join('\n'),
      /repository check or prune failed.*2 times in a row/,
      'the second failure in a row fails --check',
    );
    assert.equal(
      (await events(s.dbFile, 'backup.verify_failed')).length,
      1,
      'the failure is announced when it becomes a problem',
    );
    reply = passed;
    await verify(3);
    const recovered = await listing(s.base);
    assert.equal(recovered.verify.failures, 0, 'a pass resets the count');
    assert.deepEqual(backupCheckProblems(recovered), [], 'a pass turns --check green');
    assert.equal(
      (await events(s.dbFile, 'backup.verify_recovered')).length,
      1,
      'the recovery is announced after a reported failure',
    );
    reply = lockedPrune;
    await verify(4);
    assert.equal(
      (await listing(s.base)).verify.failures,
      1,
      'a failure after a recovery starts a new streak',
    );
  } finally {
    for (const stop of stops) await stop();
    await s.close();
  }
});

test('every repository is pruned and checked once a week, one at a time, and an external destination is never pruned', async () => {
  for (const external of [false, true]) {
    const s = await server(restic(), '40');
    const stops: (() => Promise<void>)[] = [];
    try {
      const agent = await deploy(s.base);
      await call(s.base, 'POST', '/api/v1/backup/destination', {
        ...DESTINATION,
        ...(external ? { retention: 'external' } : {}),
      });
      const node = serveMaintenance(s.base, agent, passed);
      stops.push(node.stop);
      // Not backed up yet: nothing to maintain.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(node.seen.length, 0, 'a project with no backup yet is not maintained');
      await backedUp(s.base, s.dbFile);
      const db = await openDb(s.dbFile);
      // A repository seen for the first time is scheduled inside its first week, never run at once.
      await until(
        () => Boolean(db.get("SELECT 1 FROM meta WHERE key='backup_maintenance_next:site'")),
        'the first due time to be set',
      );
      assert.equal(
        node.seen.length,
        0,
        'the first sight of a repository schedules, it does not run',
      );
      db.run(
        "UPDATE meta SET value=? WHERE key='backup_maintenance_next:site'",
        new Date(Date.now() - 1000).toISOString(),
      );
      await until(() => node.seen.length === 1, 'the weekly maintenance to run');
      assert.deepEqual(
        node.seen[0].maintain,
        { prune: !external },
        external
          ? 'an append-only destination is checked, never asked to prune'
          : 'the weekly run prunes, then checks',
      );
      assert.ok(node.seen[0].tags.includes('trigger:schedule'), 'the job says it was scheduled');
      await until(
        async () => (await listing(s.base)).verify?.ok === true,
        'the result to be stored',
      );
      const next = Date.parse(
        db.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='backup_maintenance_next:site'",
        )!.value,
      );
      assert.ok(
        next - Date.now() > 6 * 24 * 3_600_000,
        'a passing run is next due about a week later',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(node.seen.length, 1, 'it does not run again before it is due');
    } finally {
      for (const stop of stops) await stop();
      await s.close();
    }
  }
});

test("control's own repository is checked with backup verify --control and shown in its list line", async () => {
  const docker = restic();
  const s = await server(docker);
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', DESTINATION);
    const res = await call(s.base, 'POST', '/api/v1/backups/verify', { control: true });
    assert.equal(res.status, 202, 'a control verify starts in the background');
    await until(
      async () => (await listing(s.base)).control?.verify?.ok === true,
      "control's check to be recorded",
    );
    assert.ok(
      docker.execOptions.some((e) => e.cmd[1] === 'check'),
      'restic check ran in a helper container on control',
    );
    assert.ok(
      !docker.execOptions.some((e) => e.cmd[1] === 'prune'),
      "control's nightly backup prunes its repository, so verify does not",
    );
  } finally {
    await s.close();
  }
});
