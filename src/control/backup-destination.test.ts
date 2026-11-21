import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './control.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { controlRepositoryPassword } from '../backup/control-backup.ts';
import { openDb } from '../db/db.ts';
import { decrypt } from './secrets.ts';
import { until } from '../../tests/wait.ts';
import { json, testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { repositoryPassword } from '../backup/destination.ts';
import type { CreateContainerBody } from '../docker-api.ts';
import type { BackupJobPayload } from '../protocol.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function server(docker?: FakeDocker, existingDir?: string) {
  const dir = existingDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'tug-bkdest-')));
  process.env.TUG_DATA_DIR = dir;
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
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    dir,
    dbFile: path.join(dir, 'tug.db'),
    keyFile: path.join(dir, 'master.key'),
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}
const headers: Record<string, string> = {
  'x-tug-test-operator': 'operator',
  'content-type': 'application/json',
};
const call = (base: string, method: string, route: string, body?: unknown, h = headers) =>
  fetch(`${base}${route}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
/** Polls until the stored result is the done check `checkId`. */
async function runCheckResult(base: string, checkId: string) {
  let shown = await json(await call(base, 'GET', '/api/v1/backup/destination'));
  await until(async () => {
    shown = await json(await call(base, 'GET', '/api/v1/backup/destination'));
    return shown.checkResult?.checkId === checkId && shown.checkResult.state === 'done';
  }, 'the check to finish');
  return shown.checkResult;
}
/** Starts a check (202 at once) and polls the stored result until that check is done. */
async function runCheck(base: string) {
  const started = await call(base, 'POST', '/api/v1/backup/destination/check', {});
  assert.equal(started.status, 202, 'a check starts in the background');
  const { checkId, state } = await json(started);
  assert.equal(state, 'running', 'the start answers that the check is running');
  let shown = await json(await call(base, 'GET', '/api/v1/backup/destination'));
  assert.equal(shown.checkResult.checkId, checkId, 'the running check is already stored');
  const result = await runCheckResult(base, checkId);
  shown = await json(await call(base, 'GET', '/api/v1/backup/destination'));
  return { checkId, result, shown };
}
const destination = {
  url: 's3:https://s3.example.com/bucket/tug',
  env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret-value-1' },
};

test('the destination is stored encrypted and its values never leave control through the API', async () => {
  const s = await server();
  try {
    assert.deepEqual(await json(await call(s.base, 'GET', '/api/v1/backup/destination')), {
      configured: false,
    });
    const set = await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    assert.equal(set.status, 200, 'an admin can set the destination');
    const shown = await call(s.base, 'GET', '/api/v1/backup/destination');
    const text = await shown.text();
    assert.ok(
      !text.includes('sekret-value-1'),
      'the secret value should not appear in the response',
    );
    const body = JSON.parse(text);
    assert.equal(body.url, destination.url, 'the url is shown');
    assert.deepEqual(
      body.envNames,
      ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      'names are shown',
    );

    const db = await openDb(s.dbFile);
    const row = db.get<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM secrets WHERE project_id='_backup' AND name='AWS_SECRET_ACCESS_KEY'",
    );
    assert.ok(row, 'the value is kept in the secrets table under the reserved project');
    assert.ok(!row.encrypted_value.includes('sekret'), 'the stored value is encrypted');
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(decrypt(row.encrypted_value, key), 'sekret-value-1', 'the master key decrypts it');
    const events = db.all<{ message: string; metadata_json: string }>(
      "SELECT message,metadata_json FROM events WHERE type='backup.destination_set'",
    );
    assert.equal(events.length, 1, 'setting the destination is audited');
    assert.ok(
      !JSON.stringify(events).includes('sekret'),
      'the audit event should not contain the secret',
    );
  } finally {
    await s.close();
  }
});

test('setting a destination replaces the previous variables and an invalid one changes nothing', async () => {
  const s = await server();
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const bad = await call(s.base, 'POST', '/api/v1/backup/destination', { url: 's3:https://h/b' });
    assert.equal(bad.status, 400, 'a destination without credentials is rejected');
    assert.match((await json(bad)).error, /need AWS_ACCESS_KEY_ID/);
    const unchanged = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
    assert.equal(unchanged.url, destination.url, 'the stored destination is untouched');

    await call(s.base, 'POST', '/api/v1/backup/destination', { url: '/srv/restic', env: {} });
    const db = await openDb(s.dbFile);
    assert.equal(
      db.all("SELECT 1 FROM secrets WHERE project_id='_backup'").length,
      0,
      'the old credentials are removed',
    );
    const removed = await json(await call(s.base, 'DELETE', '/api/v1/backup/destination'));
    assert.equal(removed.removed, true, 'the destination can be removed');
    assert.equal(
      (await json(await call(s.base, 'GET', '/api/v1/backup/destination'))).configured,
      false,
    );
  } finally {
    await s.close();
  }
});

test('destination and key endpoints are admin only', async () => {
  const s = await server();
  try {
    const created = await json(
      await call(s.base, 'POST', '/api/v1/credentials', { name: 'ci', role: 'deploy' }),
    );
    const ci = { 'x-tug-test-credential': created.credential, 'content-type': 'application/json' };
    for (const [method, route] of [
      ['GET', '/api/v1/backup/destination'],
      ['POST', '/api/v1/backup/destination'],
      ['DELETE', '/api/v1/backup/destination'],
      ['GET', '/api/v1/backup/repository-password?project=site'],
    ])
      assert.equal(
        (await call(s.base, method, route, method === 'POST' ? destination : undefined, ci)).status,
        403,
        `${method} ${route} should need admin`,
      );
  } finally {
    await s.close();
  }
});

test('the project repository password is derived from the master key and audited', async () => {
  const s = await server();
  try {
    const early = await json(
      await call(s.base, 'GET', '/api/v1/backup/repository-password?project=ghost'),
    );
    const earlyKey = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(
      early.password,
      repositoryPassword(earlyKey, 'ghost'),
      'a project that was never deployed still has its derived password',
    );
    assert.equal(early.deployed, false, 'the response says the project has not been deployed');
    assert.equal(
      (await call(s.base, 'GET', '/api/v1/backup/repository-password?project=_control')).status,
      400,
      'a reserved name has no project password',
    );
    await call(s.base, 'POST', '/api/v1/projects', { name: 'site' });
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const body = await json(
      await call(s.base, 'GET', '/api/v1/backup/repository-password?project=site'),
    );
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(body.password, repositoryPassword(key, 'site'), 'the password is derived');
    assert.equal(body.deployed, true, 'an existing project is reported as deployed');
    assert.equal(
      body.repository,
      's3:https://s3.example.com/bucket/tug/site',
      'one repo per project',
    );
    const db = await openDb(s.dbFile);
    assert.equal(
      db.all("SELECT 1 FROM events WHERE type='backup.key_read'").length,
      2,
      'reading the key is audited',
    );
  } finally {
    await s.close();
  }
});

test('the reserved backup project cannot be reached through the secrets API', async () => {
  const s = await server();
  try {
    for (const [method, route, body] of [
      ['POST', '/api/v1/secrets', { project: '_backup', name: 'X', value: 'y' }],
      ['GET', '/api/v1/secrets?project=_backup', undefined],
      ['DELETE', '/api/v1/secrets/X?project=_backup', undefined],
    ] as const)
      assert.equal(
        (await call(s.base, method, route, body)).status,
        400,
        `${method} ${route} should refuse a reserved project`,
      );
  } finally {
    await s.close();
  }
});

test('credentials are released only to the owning node for a running backup command', async () => {
  const s = await server();
  try {
    await call(s.base, 'POST', '/api/v1/projects', { name: 'site' });
    const n1 = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
    const n2 = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n2' }));
    const deployOn = (version: string, node: string) =>
      call(s.base, 'POST', '/api/v1/deployments', {
        project: 'site',
        version,
        compose: {
          services: { web: { image: 'nginx', 'x-tug': { placement: { nodes: [node] } } } },
        },
      });
    assert.equal((await deployOn('v1', 'n1')).status, 200, 'the project is placed on n1');
    const db = await openDb(s.dbFile);
    const ids = db.all<{ id: string; name: string }>('SELECT id,name FROM nodes');
    const nodeId = (name: string) => ids.find((n) => n.name === name)!.id;
    const insert = (id: string, node: string, type: string, state: string) =>
      db.run(
        'INSERT INTO commands(id,node_id,project_id,type,state,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        nodeId(node),
        'site',
        type,
        state,
        '{}',
        0,
        'now',
        'now',
      );
    insert('cmd_run', 'n1', 'backup.run', 'running');
    insert('cmd_check', 'n1', 'backup.check', 'running');
    insert('cmd_pending', 'n1', 'backup.run', 'pending');
    insert('cmd_other', 'n1', 'service.restart', 'running');
    const fetchCredentials = (nodeId: string, command: string) =>
      fetch(`${s.base}/agent/v1/backup/credentials?command=${command}`, {
        headers: { 'x-tug-test-node': nodeId },
      });

    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_run')).status,
      409,
      'no credentials before a destination exists',
    );
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);

    const ok = await fetchCredentials(n1.nodeId, 'cmd_run');
    assert.equal(ok.status, 200, 'the running backup command gets its credentials');
    const { env } = await json(ok);
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'sekret-value-1', 'destination variables are released');
    assert.equal(
      env.RESTIC_PASSWORD,
      repositoryPassword(key, 'site'),
      'the project password is released',
    );

    const check = await fetchCredentials(n1.nodeId, 'cmd_check');
    assert.equal(check.status, 200, 'a running backup.check command gets its credentials');
    assert.equal(
      (await json(check)).env.RESTIC_PASSWORD,
      repositoryPassword(key, 'site'),
      'the check opens the project repository with its password',
    );

    assert.equal(
      (await fetchCredentials(n2.nodeId, 'cmd_run')).status,
      403,
      'another node is refused',
    );
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_pending')).status,
      409,
      'a pending command is refused',
    );
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_other')).status,
      403,
      'a non-backup command is refused',
    );
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_missing')).status,
      404,
      'an unknown command is refused',
    );
    assert.equal(
      (await fetch(`${s.base}/agent/v1/backup/credentials?command=cmd_run`, { headers })).status,
      403,
      'an operator credential is not a node credential',
    );

    db.run("UPDATE deployments SET state='succeeded'");
    assert.equal((await deployOn('v2', 'n2')).status, 200, 'the project moves to n2');
    assert.equal(
      (await fetchCredentials(n1.nodeId, 'cmd_run')).status,
      403,
      'a running command on a node the project left is refused credentials',
    );
  } finally {
    await s.close();
  }
});

/** Remembers every helper container's settings; checks run one helper at a time, so the last one is the one in use. */
class RecordingDocker extends FakeDocker {
  bodies: CreateContainerBody[] = [];
  async createContainer(name: string, body: CreateContainerBody): Promise<string> {
    this.bodies.push(body);
    return super.createContainer(name, body);
  }
}
const envOf = (body: CreateContainerBody | undefined, name: string): string | undefined =>
  body?.Env?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
const composeWithBackup = {
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
const REST_MISSING =
  'Fatal: repository does not exist: unable to open config file: <config/> does not exist\nIs there a repository at the following location?';

async function deployWithBackup(base: string): Promise<Record<string, string>> {
  const node = await json(await call(base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
  await call(base, 'POST', '/api/v1/projects', { name: 'empty' });
  const deploy = await call(base, 'POST', '/api/v1/deployments', {
    project: 'site',
    version: 'v1',
    compose: composeWithBackup,
  });
  assert.equal(deploy.status, 200, await deploy.clone().text());
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

/**
 * Plays the node's agent for a check: fetches work, takes its `backup.check` commands, opens their credentials the way
 * the agent does and answers with `reply`. Stops with `stop()`.
 */
function serveChecks(
  base: string,
  agent: Record<string, string>,
  reply: (payload: BackupJobPayload) => { state: string; result: unknown },
) {
  const seen: { commandId: string; payload: BackupJobPayload; credentials: number }[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const work = await json(await call(base, 'GET', '/agent/v1/work', undefined, agent));
      for (const command of work.commands as { id: string; type: string; payload_json: string }[]) {
        if (command.type !== 'backup.check') continue;
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
        seen.push({ commandId: command.id, payload, credentials });
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
const repositoryOk = (payload: BackupJobPayload) => ({
  state: 'succeeded',
  result: { runId: payload.runId, durationMs: 1, repository: 'ok' },
});

test('a destination check opens the control and project repositories, creates missing ones and stores the result', async () => {
  const docker = new RecordingDocker();
  docker.addImage('restic/restic:0.19.1');
  const missing = new Set<string>();
  docker.execResponder = (cmd) => {
    const repository = envOf(docker.bodies.at(-1), 'RESTIC_REPOSITORY') ?? '';
    return cmd[1] === 'cat' && missing.has(repository)
      ? { code: 10, err: REST_MISSING }
      : { code: 0 };
  };
  const stops: (() => Promise<void>)[] = [];
  const s = await server(docker);
  try {
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/backup/destination/check', {})).status,
      409,
      'a check without a destination is refused with a reason',
    );
    const agent = await deployWithBackup(s.base);
    const node = serveChecks(s.base, agent, repositoryOk);
    stops.push(node.stop);
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 'rest:http://backup.internal:8030/tug',
      env: { RESTIC_REST_USERNAME: 'tug', RESTIC_REST_PASSWORD: 'rest-secret-1' },
    });
    missing.add('rest:http://backup.internal:8030/tug/_control');
    const { result, shown } = await runCheck(s.base);
    assert.equal(result.ok, true, 'every repository is usable');
    assert.equal(result.state, 'done', 'a finished check says so');
    assert.equal(result.from, 'control', 'the result says where it ran');
    assert.deepEqual(
      result.nodes,
      [{ project: 'site', node: 'n1', state: 'ok' }],
      'the node that runs the project backups answered for its repository',
    );
    assert.equal(result.url, 'rest:http://backup.internal:8030/tug', 'the checked url is echoed');
    assert.deepEqual(
      result.repositories.map((r: { name: string; state: string }) => [r.name, r.state]),
      [
        ['_control', 'initialized'],
        ['site', 'ok'],
      ],
      'control and each project with a backup target are checked; a missing repository is created; a project without targets is skipped',
    );
    const key = (await fs.readFile(s.keyFile, 'utf8')).trim();
    const passwords = docker.bodies.map((b) => envOf(b, 'RESTIC_PASSWORD'));
    assert.deepEqual(
      passwords,
      [controlRepositoryPassword(key), repositoryPassword(key, 'site')],
      'each repository is opened with its own derived password',
    );
    assert.equal(shown.checkResult.ok, true, 'the result is stored with the destination');
    assert.equal(shown.checkedAt, result.checkedAt, 'the check time is stored');
    const db = await openDb(s.dbFile);
    assert.equal(
      db.all("SELECT 1 FROM events WHERE type='backup.destination_checked'").length,
      1,
      'a check is audited',
    );
    assert.ok(!JSON.stringify(result).includes('rest-secret-1'), 'credentials never appear');
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await s.close();
  }
});

test('a destination check reports a failing repository with ok false and a redacted message', async () => {
  const docker = new FakeDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.execResponder = (cmd) =>
    cmd[1] === 'cat'
      ? {
          code: 1,
          err: 'Fatal: unable to open config file: The specified bucket does not exist for sekret-value-1',
        }
      : { code: 0 };
  const s = await server(docker);
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const { result } = await runCheck(s.base);
    const text = JSON.stringify(result);
    assert.equal(result.ok, false, 'the check fails');
    assert.equal(result.repositories[0].state, 'error', 'the repository is an error');
    assert.match(result.repositories[0].error, /bucket does not exist/, 'restic message is shown');
    assert.ok(!text.includes('sekret-value-1'), 'the secret is redacted');
    assert.ok(
      !docker.execOptions.some((e) => e.cmd[1] === 'init'),
      'a missing bucket never triggers init',
    );
    const shown = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
    assert.equal(shown.checkResult.ok, false, 'the failure is stored');
  } finally {
    await s.close();
  }
});

test('a manual backup of a project that was never deployed says it has not been deployed yet', async () => {
  const s = await server();
  try {
    const res = await call(s.base, 'POST', '/api/v1/backups/run', { project: 'ghost' });
    assert.equal(res.status, 404, 'an unknown project cannot be backed up');
    assert.match(
      (await json(res)).error,
      /has not been deployed yet.*backup targets come from its deployed Compose file/,
      'the message says to deploy first',
    );
  } finally {
    await s.close();
  }
});

test('a failing control repository skips the project repositories instead of timing out on each', async () => {
  const docker = new RecordingDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.execResponder = (cmd) =>
    cmd[1] === 'cat'
      ? { code: 1, err: 'Fatal: unable to open config file: bucket does not exist' }
      : { code: 0 };
  const stops: (() => Promise<void>)[] = [];
  const s = await server(docker);
  try {
    const agent = await deployWithBackup(s.base);
    stops.push(serveChecks(s.base, agent, repositoryOk).stop);
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const { result } = await runCheck(s.base);
    assert.deepEqual(
      result.repositories.map((r: { name: string; state: string }) => [r.name, r.state]),
      [
        ['_control', 'error'],
        ['site', 'skipped'],
      ],
      'the project repository is skipped once control fails on the same destination',
    );
    assert.match(result.repositories[1].error, /not checked: control's own repository failed/);
    assert.equal(result.ok, false, 'a skipped repository still fails the check');
    assert.deepEqual(
      result.nodes,
      [{ project: 'site', node: 'n1', state: 'ok' }],
      'nodes are still checked when control cannot reach the destination: they may use another network',
    );
    assert.equal(
      docker.bodies.length,
      1,
      'no helper container is started for the skipped repository',
    );
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await s.close();
  }
});

test('a second concurrent check is refused, and replacing the destination aborts the running check without storing its result', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  class GatedDocker extends RecordingDocker {
    async createContainer(name: string, body: CreateContainerBody): Promise<string> {
      const id = await super.createContainer(name, body);
      await gate;
      return id;
    }
  }
  const docker = new GatedDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.execResponder = () => ({ code: 0 });
  const s = await server(docker);
  try {
    await call(s.base, 'POST', '/api/v1/backup/destination', destination);
    const first = await call(s.base, 'POST', '/api/v1/backup/destination/check', {});
    assert.equal(first.status, 202, 'the check starts');
    await until(() => docker.bodies.length === 1, 'the first check to start its helper');
    const second = await call(s.base, 'POST', '/api/v1/backup/destination/check', {});
    assert.equal(second.status, 409, 'a check while another runs is refused');
    assert.match((await json(second)).error, /already running/, 'the reason is given');
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      ...destination,
      env: { ...destination.env, AWS_SECRET_ACCESS_KEY: 'rotated-secret-2' },
    });
    const shown = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
    assert.equal(shown.checkResult, null, 'replacing the destination drops the running check');
    // `destination set` starts its own check right after saving: the replaced check must not refuse it.
    const next = await call(s.base, 'POST', '/api/v1/backup/destination/check', {});
    assert.equal(
      next.status,
      202,
      'a check right after replacing the destination starts, even though the old check is still unwinding',
    );
    const { checkId } = await json(next);
    release();
    const final = await runCheckResult(s.base, checkId);
    assert.notEqual(
      final.checkId,
      (await json(first)).checkId,
      'the result of the check that began before the replacement is never stored',
    );
  } finally {
    release();
    await s.close();
  }
});

const restDestination = {
  url: 'rest:http://backup.internal:8030/tug',
  env: { RESTIC_REST_USERNAME: 'tug', RESTIC_REST_PASSWORD: 'rest-secret-1' },
};
function resticDocker(): RecordingDocker {
  const docker = new RecordingDocker();
  docker.addImage('restic/restic:0.19.1');
  docker.execResponder = () => ({ code: 0 });
  return docker;
}
const withShortNodeLimit = async (ms: number, body: () => Promise<void>) => {
  process.env.TUG_DESTINATION_CHECK_NODE_TIMEOUT_MS = String(ms);
  try {
    await body();
  } finally {
    delete process.env.TUG_DESTINATION_CHECK_NODE_TIMEOUT_MS;
  }
};

test('a check queues one backup.check per project and node, routes the result to the check and leaves backup runs alone', async () => {
  const s = await server(resticDocker());
  let node: ReturnType<typeof serveChecks> | undefined;
  try {
    const agent = await deployWithBackup(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', restDestination);
    // A backup run that is queued for the node when the check arrives.
    const run = await json(await call(s.base, 'POST', '/api/v1/backups/run', { project: 'site' }));
    assert.equal(run.runs.length, 1, 'a manual backup is queued');
    node = serveChecks(s.base, agent, (payload) => ({
      state: 'succeeded',
      result: { runId: payload.runId, durationMs: 1, repository: 'missing' },
    }));
    const { result } = await runCheck(s.base);
    assert.equal(node.seen.length, 1, 'one check command is queued for the one project and node');
    const [seen] = node.seen;
    assert.equal(seen.credentials, 200, 'the node gets credentials for its backup.check command');
    assert.equal(seen.payload.project, 'site', 'the command names the project');
    assert.equal(seen.payload.target, '', 'a check has no backup target');
    assert.equal(seen.payload.node, 'n1', 'the command names the node');
    assert.equal(
      seen.payload.repository,
      'rest:http://backup.internal:8030/tug/site',
      "the command opens the project's repository",
    );
    assert.equal(seen.payload.resticImage, 'restic/restic:0.19.1', 'the command names the image');
    assert.ok(seen.payload.limits.timeoutSec > 0, 'the command carries limits');
    assert.deepEqual(
      result.nodes,
      [{ project: 'site', node: 'n1', state: 'missing' }],
      'a repository the node cannot find is reported as missing',
    );
    assert.equal(
      result.ok,
      true,
      'a missing repository is not a failure: the first backup creates it',
    );

    const db = await openDb(s.dbFile);
    const runs = db.all<{ id: string; state: string }>('SELECT id,state FROM backup_runs');
    assert.deepEqual(
      runs.map((r) => [r.id, r.state]),
      [[run.runs[0].runId, 'queued']],
      'the check result neither created nor finished a backup run',
    );
    assert.equal(
      db.get<{ last_status: string | null }>('SELECT last_status FROM backup_schedules')
        ?.last_status ?? null,
      null,
      'the check result did not mark the backup target as run',
    );
    assert.equal(
      db.get<{ state: string }>("SELECT state FROM commands WHERE type='backup.check'")?.state,
      'succeeded',
      'the check command is completed like any command',
    );
    assert.equal(
      db.all("SELECT 1 FROM events WHERE type IN ('backup.completed','backup.failed')").length,
      0,
      'a check raises no backup events',
    );
  } finally {
    await node?.stop();
    await s.close();
  }
});

test('a node that cannot reach the destination fails the check with its redacted error', async () => {
  const s = await server(resticDocker());
  let node: ReturnType<typeof serveChecks> | undefined;
  try {
    const agent = await deployWithBackup(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', restDestination);
    node = serveChecks(s.base, agent, () => ({
      state: 'failed',
      result: {
        error: 'repository check failed: dial tcp backup.internal:8030: i/o timeout rest-secret-1',
      },
    }));
    const { result } = await runCheck(s.base);
    assert.equal(result.nodes[0].state, 'error', 'the node reports an error');
    assert.match(result.nodes[0].error, /i\/o timeout/, 'the reason is kept');
    assert.ok(
      !JSON.stringify(result).includes('rest-secret-1'),
      'a credential value never reaches the stored result',
    );
    assert.equal(result.ok, false, 'a node that cannot reach the destination fails the check');
    assert.equal(
      result.repositories.every((r: { state: string }) => r.state === 'ok'),
      true,
      'control itself reached the destination: the node phase is what failed',
    );
  } finally {
    await node?.stop();
    await s.close();
  }
});

test('an offline node is reported at once and gets no command', async () => {
  const s = await server(resticDocker());
  try {
    await deployWithBackup(s.base);
    await call(s.base, 'POST', '/api/v1/backup/destination', restDestination);
    const db = await openDb(s.dbFile);
    db.run("UPDATE nodes SET last_seen_at='2020-01-01T00:00:00.000Z'");
    const { result } = await runCheck(s.base);
    assert.equal(result.nodes[0].state, 'offline', 'a node that stopped reporting is offline');
    assert.deepEqual(
      [result.nodes[0].project, result.nodes[0].node],
      ['site', 'n1'],
      'the entry names the project and node',
    );
    assert.equal(result.ok, false, 'an offline node fails the check');
    assert.equal(
      db.all("SELECT 1 FROM commands WHERE type='backup.check'").length,
      0,
      'nothing is queued for an offline node',
    );
  } finally {
    await s.close();
  }
});

test('a node that never fetches its check is a timeout and the queued command is cancelled', async () => {
  await withShortNodeLimit(150, async () => {
    const s = await server(resticDocker());
    try {
      await deployWithBackup(s.base);
      await call(s.base, 'POST', '/api/v1/backup/destination', restDestination);
      const { result } = await runCheck(s.base);
      assert.equal(result.nodes[0].state, 'timeout', 'a node that does not answer times out');
      assert.match(result.nodes[0].error, /did not answer within/, 'the entry says why');
      assert.equal(result.ok, false, 'a node that does not answer fails the check');
      const db = await openDb(s.dbFile);
      assert.equal(
        db.get<{ state: string }>("SELECT state FROM commands WHERE type='backup.check'")?.state,
        'cancelled',
        'a command no node fetched is cancelled, so it is never delivered late',
      );
    } finally {
      await s.close();
    }
  });
});

test('replacing the destination cancels the node checks of the running check at once', async () => {
  await withShortNodeLimit(60_000, async () => {
    const s = await server(resticDocker());
    try {
      await deployWithBackup(s.base);
      await call(s.base, 'POST', '/api/v1/backup/destination', restDestination);
      const started = await call(s.base, 'POST', '/api/v1/backup/destination/check', {});
      assert.equal(started.status, 202, 'the check starts');
      const db = await openDb(s.dbFile);
      const commandState = () =>
        db.get<{ state: string }>("SELECT state FROM commands WHERE type='backup.check'")?.state;
      await until(() => commandState() === 'pending', 'the node check to be queued');
      await call(s.base, 'POST', '/api/v1/backup/destination', {
        ...restDestination,
        url: 'rest:http://backup.internal:8030/tug-new',
      });
      await until(
        () => commandState() === 'cancelled',
        'the queued node check to be cancelled well before its 60 s limit',
      );
    } finally {
      await s.close();
    }
  });
});

test('a node that fetched its check but did not answer gets a cancel and a late result changes nothing', async () => {
  await withShortNodeLimit(150, async () => {
    const s = await server(resticDocker());
    try {
      const agent = await deployWithBackup(s.base);
      await call(s.base, 'POST', '/api/v1/backup/destination', restDestination);
      const started = await json(
        await call(s.base, 'POST', '/api/v1/backup/destination/check', {}),
      );
      const work = await json(await call(s.base, 'GET', '/agent/v1/work', undefined, agent));
      const command = work.commands.find((c: { type: string }) => c.type === 'backup.check');
      assert.ok(command, 'the node is handed its backup.check command');
      const result = await runCheckResult(s.base, started.checkId);
      assert.equal(result.nodes[0].state, 'timeout', 'a node that keeps the command times out');
      const db = await openDb(s.dbFile);
      const cancel = db.get<{ payload_json: string }>(
        "SELECT payload_json FROM commands WHERE type='backup.cancel'",
      );
      assert.deepEqual(
        cancel && JSON.parse(cancel.payload_json),
        { commandId: command.id },
        'the node is told to stop the job it still has',
      );
      const late = await call(
        s.base,
        'POST',
        '/agent/v1/status',
        {
          projects: [],
          commandResults: [
            {
              commandId: command.id,
              state: 'succeeded',
              result: { runId: 'x', durationMs: 1, repository: 'ok' },
            },
          ],
        },
        agent,
      );
      assert.equal(late.status, 200, 'a late result is accepted');
      const shown = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
      assert.equal(
        shown.checkResult.nodes[0].state,
        'timeout',
        'the finished check is not rewritten',
      );
    } finally {
      await s.close();
    }
  });
});

test('a check that was running when control restarted is marked interrupted instead of running forever', async () => {
  const docker = resticDocker();
  const first = await server(docker);
  const started = await (async () => {
    await deployWithBackup(first.base);
    await call(first.base, 'POST', '/api/v1/backup/destination', restDestination);
    const res = await call(first.base, 'POST', '/api/v1/backup/destination/check', {});
    const body = await json(res);
    // Nobody answers the node, so the check is still running when control goes away.
    await until(async () => {
      const shown = await json(await call(first.base, 'GET', '/api/v1/backup/destination'));
      return shown.checkResult?.repositories?.length === 2;
    }, 'the control-host part to finish');
    const shown = await json(await call(first.base, 'GET', '/api/v1/backup/destination'));
    assert.equal(shown.checkResult.state, 'running', 'the check waits for the node');
    assert.equal(shown.checkedAt, null, 'a running check has no check time');
    return body.checkId as string;
  })();
  await first.close();
  const second = await server(resticDocker(), first.dir);
  try {
    const shown = await json(await call(second.base, 'GET', '/api/v1/backup/destination'));
    assert.equal(shown.checkResult.checkId, started, 'the same check is shown');
    assert.equal(shown.checkResult.state, 'done', 'a check control can no longer finish is done');
    assert.equal(shown.checkResult.ok, false, 'an interrupted check is not a pass');
    assert.match(shown.checkResult.error, /control restarted/, 'the result says what happened');
    assert.equal(
      shown.checkResult.nodes[0].state,
      'timeout',
      'a node that never answered is not pending',
    );
    assert.ok(shown.checkedAt, 'the interrupted check gets a time');
    const again = await call(second.base, 'POST', '/api/v1/backup/destination/check', {});
    assert.equal(again.status, 202, 'a new check can start after a restart');
  } finally {
    await second.close();
  }
});
