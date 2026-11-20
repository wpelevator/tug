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
import { json, testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { repositoryPassword } from '../backup/destination.ts';
import type { CreateContainerBody } from '../docker-api.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function server(docker?: FakeDocker) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-bkdest-'));
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
  const s = await server(docker);
  try {
    assert.equal(
      (await call(s.base, 'POST', '/api/v1/backup/destination/check', {})).status,
      409,
      'a check without a destination is refused with a reason',
    );
    const node = await json(await call(s.base, 'POST', '/api/v1/nodes/register', { name: 'n1' }));
    await call(s.base, 'POST', '/api/v1/projects', { name: 'empty' });
    const deploy = await call(s.base, 'POST', '/api/v1/deployments', {
      project: 'site',
      version: 'v1',
      compose: composeWithBackup,
    });
    assert.equal(deploy.status, 200, await deploy.clone().text());
    const agent = { 'x-tug-test-node': node.nodeId, 'content-type': 'application/json' };
    const work = await json(await call(s.base, 'GET', '/agent/v1/work', undefined, agent));
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
    await call(s.base, 'POST', '/api/v1/backup/destination', {
      url: 'rest:http://backup.internal:8030/tug',
      env: { RESTIC_REST_USERNAME: 'tug', RESTIC_REST_PASSWORD: 'rest-secret-1' },
    });
    missing.add('rest:http://backup.internal:8030/tug/_control');
    const res = await call(s.base, 'POST', '/api/v1/backup/destination/check', {});
    assert.equal(res.status, 200, await res.clone().text());
    const result = await json(res);
    assert.equal(result.ok, true, 'every repository is usable');
    assert.equal(result.from, 'control', 'the result says where it ran');
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
    const shown = await json(await call(s.base, 'GET', '/api/v1/backup/destination'));
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
    const res = await call(s.base, 'POST', '/api/v1/backup/destination/check', {});
    assert.equal(res.status, 200, 'a failing repository is a result, not an HTTP error');
    const text = await res.text();
    const result = JSON.parse(text);
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
