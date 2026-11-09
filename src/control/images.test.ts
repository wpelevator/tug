import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as tar from 'tar';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
import { json, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { FakeDocker } from '../../tests/fake-docker.ts';
import { inspectEngineImage } from '../images/artifacts.ts';

async function server(openDatabase?: typeof openDb) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-images-'));
  Object.assign(process.env, {
    TUG_DATA_DIR: dir,
  });
  const bytes = Buffer.from('saved image gzip');
  const calls: string[] = [];
  const imageInfo = { imageId: `sha256:${'a'.repeat(64)}`, platform: 'linux/amd64' };
  const info = {
    ...imageInfo,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  let fail = false;
  // By default every build produces a new image; `identicalImages` makes rebuilds produce the one the project already has.
  let identical = false;
  let failMaintenance = false;
  let buildGate: Promise<void> | undefined;
  // Control reaches its daemon through the Engine API; the fake records every mutation as `verb subject`.
  const docker = new FakeDocker();
  const app = await createApp({
    docker,
    identity: testIdentity,
    controlUrl: testControlUrl,
    openDatabase,
    images: {
      build: async (options) => {
        calls.push(`build ${options.imageRef}`);
        if (buildGate) await buildGate;
        if (fail) throw new Error('build broke');
      },
      save: async (_ref, file) => {
        await fs.writeFile(file, bytes);
        return info;
      },
      // The daemon's ID is not the archive's config digest on a containerd-store daemon, so it differs from
      // `info.imageId` here; an unchanged rebuild repeats the same daemon ID, a changed one never does.
      inspect: async (ref) => ({
        ...imageInfo,
        imageId: identical
          ? `sha256:${'b'.repeat(64)}`
          : `sha256:${createHash('sha256').update(String(ref)).digest('hex')}`,
      }),
      validate: async () => info,
      run: async (_cmd, args) => {
        calls.push(args.join(' '));
        if (failMaintenance && args[0] === 'builder') throw new Error('prune broke');
        return { out: '', err: '' };
      },
    },
  });
  const srv = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const headers = { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' };
  const post = async (route: string, body: unknown, token?: string) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: token ? { ...headers, 'x-tug-test-node': token } : headers,
      body: JSON.stringify(body),
    });
  const node = async (name: string) => json(await post('/api/v1/nodes/register', { name }));
  const compose = { services: { app: { build: '.', 'x-tug': { placement: { nodes: ['n1'] } } } } };
  const deploy = async (
    version = 'v1',
    local = false,
    imageRef = 'tug-build/00000000-0000-4000-8000-000000000000/image-0:local',
  ) => {
    const form = new FormData();
    const payload = {
      project: 'app',
      version,
      compose,
      ...(local ? { localImages: [{ service: 'app', field: 'image-0', imageRef, ...info }] } : {}),
    };
    form.set('payload', JSON.stringify(payload));
    if (local) form.set('image-0', new Blob([bytes]), 'image.tar.gz');
    else {
      const context = path.join(dir, 'context.tar.gz');
      await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
      await tar.c({ cwd: dir, gzip: true, file: context }, ['Dockerfile']);
      form.set('context', new Blob([await fs.readFile(context)]), 'context.tar.gz');
    }
    return fetch(`${base}/api/v1/deployments`, {
      method: 'POST',
      headers: { 'x-tug-test-operator': 'operator' },
      body: form,
    });
  };
  const report = async (
    token: string,
    desired: { version: string; revision: string },
    health = 'serving',
  ) =>
    post(
      '/agent/v1/status',
      {
        projects: [
          {
            project: 'app',
            observedVersion: desired.version,
            observedRevision: desired.revision,
            health,
          },
        ],
      },
      token,
    );
  return {
    dir,
    base,
    bytes,
    info,
    calls,
    docker,
    post,
    node,
    deploy,
    report,
    pauseBuild: () => {
      let release!: () => void;
      buildGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failBuild: () => {
      fail = true;
    },
    identicalImages: () => {
      identical = true;
    },
    failMaintenance: () => {
      failMaintenance = true;
    },
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
test('registry-free builds stream only to assigned nodes, preserve rollback images and reject stale reused-version reports', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const n2 = await s.node('n2');
    const firstResponse = await s.deploy();
    assert.equal(
      firstResponse.status,
      200,
      'a source build must deploy without any registry configuration',
    );
    const first = await json(firstResponse);
    const artifact = first.desiredState.services.app.artifact;
    assert.match(
      first.desiredState.services.app.image,
      /^tug-build\//,
      'saved images must have a Tug-owned immutable reference',
    );
    const url = `${s.base}/agent/v1/images/${artifact.buildId}`;
    const downloaded = await fetch(url, { headers: { 'x-tug-test-node': n1.nodeId } });
    assert.equal(downloaded.status, 200, 'an assigned node must be able to download its image');
    assert.deepEqual(
      Buffer.from(await downloaded.arrayBuffer()),
      s.bytes,
      'the download must preserve exact compressed bytes',
    );
    assert.equal(
      (await fetch(url, { headers: { 'x-tug-test-node': n2.nodeId } })).status,
      404,
      'an unassigned node must not read another node image',
    );
    assert.equal((await fetch(url)).status, 401, 'image downloads must require a live node token');
    await s.report(n1.nodeId, first.desiredState);
    const second = await json(await s.deploy('v1'));
    assert.notEqual(
      second.desiredState.revision,
      first.desiredState.revision,
      'reusing a display version must create a new desired-state revision',
    );
    assert.notEqual(
      second.desiredState.services.app.image,
      first.desiredState.services.app.image,
      'reusing a version must not overwrite its prior image',
    );
    await s.report(n1.nodeId, first.desiredState);
    const pending = await json(
      await fetch(`${s.base}/api/v1/deployments/${second.deployment.id}`, {
        headers: { 'x-tug-test-operator': 'operator' },
      }),
    );
    assert.equal(
      pending.state,
      'rolling_out',
      'a stale healthy report must not complete a different same-version revision',
    );
    const rollback = await json(await s.post('/api/v1/rollback', { project: 'app', force: true }));
    assert.equal(
      rollback.desiredState.services.app.artifact.buildId,
      artifact.buildId,
      'rollback must reuse the retained original image artifact',
    );
    assert.notEqual(
      rollback.desiredState.revision,
      first.desiredState.revision,
      'rollback must publish a new revision',
    );
    assert.equal(
      (await fetch(url, { headers: { 'x-tug-test-node': n1.nodeId } })).status,
      200,
      'retained rollback artifacts must survive subsequent publication and cleanup',
    );
  } finally {
    await s.close();
  }
});
test('local uploads import without a remote build and failed builds keep the previous deployment', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const localResponse = await s.deploy('local', true);
    assert.equal(
      localResponse.status,
      200,
      'a complete local image upload must deploy without a source context',
    );
    const local = await json(localResponse);
    assert.ok(
      s.calls.some((call) => call.startsWith('load -i')),
      'local uploads must import their verified archive',
    );
    assert.ok(
      s.docker.calls.includes(
        'image-rm tug-build/00000000-0000-4000-8000-000000000000/image-0:local',
      ),
      'control must remove only the validated generated client tag after retagging its immutable image',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('build ')),
      'local uploads must never rebuild sources on control',
    );
    await s.report(n1.nodeId, local.desiredState);
    s.failBuild();
    assert.equal(
      (await s.deploy('broken')).status,
      500,
      'a failed Docker build must fail the deployment request',
    );
    const work = await json(
      await fetch(`${s.base}/agent/v1/work`, {
        headers: { 'x-tug-test-node': n1.nodeId },
      }),
    );
    assert.equal(
      work.desiredStates[0].revision,
      local.desiredState.revision,
      'a failed build must leave the last desired deployment current',
    );
    assert.equal(
      (await fs.readdir(path.join(s.dir, 'images'))).length,
      1,
      'failed unpublished builds must not leak archive files',
    );
    const missing = await s.post('/api/v1/deployments', {
      project: 'other',
      compose: { services: { app: { build: '.', 'x-tug': { placement: { nodes: ['n1'] } } } } },
    });
    assert.equal(
      missing.status,
      400,
      'artifact-mode build services must reject requests with no image or source upload',
    );
  } finally {
    await s.close();
  }
});
test('control backups contain retained image archives and metadata', async () => {
  const s = await server();
  try {
    await s.node('n1');
    const deployed = await json(await s.deploy());
    const backup = await json(await s.post('/api/v1/control/backups/run', {}));
    const entries: string[] = [];
    await tar.t({
      file: backup.artifactRef,
      onReadEntry: (entry) => {
        entries.push(entry.path);
      },
    });
    assert.ok(
      entries.includes(`images/${deployed.desiredState.services.app.artifact.buildId}.tar.gz`),
      'control backups must include every retained image archive',
    );
    assert.ok(
      entries.includes('tug.db') && entries.includes('master.key'),
      'image backups must preserve the database and secrets key too',
    );
  } finally {
    await s.close();
  }
});
test('restore rejects missing archives before changing live data and requires restart after a valid restore', async () => {
  const s = await server();
  try {
    await s.node('n1');
    const deployed = await json(await s.deploy());
    const backup = await json(await s.post('/api/v1/control/backups/run', {}));
    const damaged = path.join(s.dir, 'damaged');
    await fs.mkdir(damaged);
    await tar.x({ file: backup.artifactRef, cwd: damaged });
    await fs.rm(
      path.join(damaged, 'images', `${deployed.desiredState.services.app.artifact.buildId}.tar.gz`),
    );
    const corrupt = path.join(s.dir, 'corrupt.tar.gz');
    await tar.c({ file: corrupt, gzip: true, cwd: damaged }, [
      'tug.db',
      'master.key',
      'metadata.json',
      'images',
    ]);
    const rejected = await s.post('/api/v1/control/restore', {
      artifactRef: corrupt,
      confirm: true,
    });
    assert.equal(
      rejected.status,
      400,
      'a backup missing referenced image bytes must be rejected before changing live control state',
    );
    assert.equal(
      (await fetch(`${s.base}/api/v1/status`, { headers: { 'x-tug-test-operator': 'operator' } }))
        .status,
      200,
      'control must remain usable after rejecting an invalid backup',
    );
    const restored = await s.post('/api/v1/control/restore', {
      artifactRef: backup.artifactRef,
      confirm: true,
    });
    assert.equal(restored.status, 200, 'a complete verified backup must restore successfully');
    assert.equal(
      (await fetch(`${s.base}/api/v1/status`, { headers: { 'x-tug-test-operator': 'operator' } }))
        .status,
      503,
      'DB-dependent APIs must report restart required after restore',
    );
    assert.equal(
      (await fetch(`${s.base}/healthz`)).status,
      503,
      'a restored process must not advertise readiness before restart',
    );
  } finally {
    await s.close();
  }
});

test('legacy registry environment cannot redirect local builds away from archives', async () => {
  const s = await server();
  try {
    await s.node('n1');
    process.env.TUG_REGISTRY = 'ignored.example';
    const response = await s.deploy('local-registry', true);
    assert.equal(response.status, 200, 'local uploads must always use archive delivery');
    const deployed = await json(response);
    assert.match(
      deployed.desiredState.services.app.image,
      /^tug-build\//,
      'builds must publish Tug-owned immutable references',
    );
    assert.ok(
      deployed.desiredState.services.app.artifact,
      'built images must always use retained archives',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('push ')),
      'control must never push built images to a registry',
    );
    assert.equal(
      (await fs.readdir(path.join(s.dir, 'images'))).length,
      1,
      'each build must retain its compressed delivery archive',
    );
  } finally {
    await s.close();
  }
});
test('cancelled long builds renew their lease but never publish after cancellation', async () => {
  process.env.TUG_LOCK_TTL_MS = '40';
  const s = await server();
  try {
    await s.node('n1');
    const release = s.pauseBuild();
    const request = s.deploy('cancel-me');
    for (
      let attempt = 0;
      attempt < 100 && !s.calls.some((call) => call.startsWith('build '));
      attempt++
    )
      await delay(5);
    assert.ok(
      s.calls.some((call) => call.startsWith('build ')),
      'the build must start before testing cancellation',
    );
    await delay(100);
    const status = await json(
      await fetch(`${s.base}/api/v1/status`, { headers: { 'x-tug-test-operator': 'operator' } }),
    );
    const deployment = status.deployments.find(
      (row: { version: string }) => row.version === 'cancel-me',
    );
    const lockConflict = await s.post('/api/v1/secrets', {
      project: 'app',
      name: 'LOCK_TEST',
      value: 'value',
    });
    assert.equal(
      lockConflict.status,
      409,
      'an active long build must renew its lease beyond its initial expiry',
    );
    const cancelled = await s.post(`/api/v1/deployments/${deployment.id}/cancel`, {});
    assert.equal(
      cancelled.status,
      200,
      'cancellation must stay responsive while a Docker build is in progress',
    );
    release();
    assert.equal(
      (await request).status,
      409,
      'a build cancelled before publication must not publish its desired state',
    );
    const final = await json(
      await fetch(`${s.base}/api/v1/deployments/${deployment.id}`, {
        headers: { 'x-tug-test-operator': 'operator' },
      }),
    );
    assert.equal(
      final.state,
      'cancelled',
      'publication must not overwrite a cancelled deployment state',
    );
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'images')),
      [],
      'cancelled unpublished build images must be cleaned',
    );
  } finally {
    delete process.env.TUG_LOCK_TTL_MS;
    await s.close();
  }
});
// Pause actual filesystem I/O; synchronous SQL has no suspension point.
function filesystemGate(
  t: TestContext,
  method: 'mkdir' | 'copyFile',
  matches: (file: string) => boolean,
) {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = fs[method];
  let armed = true;
  t.mock.method(fs, method, async (...args: unknown[]) => {
    if (armed && matches(String(args[0]))) {
      armed = false;
      entered();
      await pending;
    }
    return Reflect.apply(original, fs, args);
  });
  return { release, reached };
}
test('requests during restore file replacement return 503 without touching the closed database', async (t) => {
  const s = await server();
  try {
    const backup = await json(await s.post('/api/v1/control/backups/run', {}));
    const held = filesystemGate(t, 'copyFile', (file) =>
      /\/control-restore\/r_[^/]+\/tug\.db$/.test(file),
    );
    const restore = s.post('/api/v1/control/restore', {
      artifactRef: backup.artifactRef,
      confirm: true,
    });
    await held.reached;
    try {
      const status = await fetch(`${s.base}/api/v1/status`, {
        headers: { 'x-tug-test-operator': 'operator' },
      });
      assert.equal(
        status.status,
        503,
        'database routes must reject requests while restore replaces live files',
      );
      assert.equal(
        (await json(status)).restartRequired,
        true,
        'restore must advertise the required restart',
      );
    } finally {
      held.release();
    }
    assert.equal((await restore).status, 200, 'restore must complete after files can be replaced');
  } finally {
    await s.close();
  }
});
test('writer operations queued behind a restore recheck restart readiness before using SQLite', async (t) => {
  const s = await server();
  try {
    const backup = await json(await s.post('/api/v1/control/backups/run', {}));
    const held = filesystemGate(t, 'mkdir', (file) => file.endsWith('-staging'));
    const firstWriter = s.post('/api/v1/control/backups/run', {});
    await held.reached;
    const restore = s.post('/api/v1/control/restore', {
      artifactRef: backup.artifactRef,
      confirm: true,
    });
    await delay(10);
    const queued = s.post('/api/v1/control/backups/run', {});
    await delay(10);
    held.release();
    assert.equal(
      (await firstWriter).status,
      200,
      'the writer preceding restore must complete normally',
    );
    assert.equal((await restore).status, 200, 'a queued verified restore must complete normally');
    assert.equal(
      (await queued).status,
      503,
      'a writer queued behind restore must not touch the closed database',
    );
  } finally {
    await s.close();
  }
});
test('upload validation rejects server-owned tags and cleans malformed multipart files', async () => {
  const s = await server();
  try {
    await s.node('n1');
    assert.equal(
      (await s.deploy('wrong-tag', true, 'tug-build/app/app:dep_existing')).status,
      400,
      'client uploads must never be allowed to overwrite server immutable tags',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('load ')),
      'invalid upload references must fail before Docker import',
    );
    const form = new FormData();
    form.set('payload', '{invalid');
    form.set('image-0', new Blob([s.bytes]), 'image.tgz');
    const response = await fetch(`${s.base}/api/v1/deployments`, {
      method: 'POST',
      headers: { 'x-tug-test-operator': 'operator' },
      body: form,
    });
    assert.equal(response.status, 400, 'malformed multipart JSON must produce a client error');
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'uploads')),
      [],
      'rejected multipart files must be removed before the response completes',
    );
  } finally {
    await s.close();
  }
});
test('configured upload limits reject oversized archives and remove partial files', async () => {
  process.env.TUG_MAX_IMAGE_BYTES = '1';
  const s = await server();
  try {
    await s.node('n1');
    assert.equal(
      (await s.deploy('oversized', true)).status,
      400,
      'an uploaded archive larger than the configured compressed-byte limit must be rejected',
    );
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'uploads')),
      [],
      'oversized multipart uploads must not leave partial files',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('load ')),
      'upload size rejection must happen before Docker import',
    );
  } finally {
    delete process.env.TUG_MAX_IMAGE_BYTES;
    await s.close();
  }
});

test('publication failure rolls back desired state and keeps the previous deployment current', async () => {
  let failPublication = false;
  let database: Awaited<ReturnType<typeof openDb>>;
  const s = await server(async (filename) => {
    const db = await openDb(filename);
    database = db;
    const run = db.run.bind(db);
    db.run = (sql, ...values) => {
      if (failPublication && sql.startsWith('INSERT INTO desired_states'))
        throw new Error('injected publication failure');
      return run(sql, ...values);
    };
    return db;
  });
  try {
    const node = await s.node('n1');
    const first = await json(await s.deploy('first'));
    await s.report(node.nodeId, first.desiredState);
    failPublication = true;
    const response = await s.deploy('failed');
    assert.equal(response.status, 500, 'publication failures must be returned as server errors');
    assert.match(
      (await json(response)).error,
      /injected publication failure/,
      'rollback must preserve the publication failure',
    );
    assert.deepEqual(
      database!.get('SELECT current_deployment_id FROM projects WHERE id=?', 'app'),
      { current_deployment_id: first.deployment.id },
      'failed publication must keep the previous deployment current',
    );
    assert.deepEqual(
      database!.all('SELECT deployment_id FROM desired_states'),
      [{ deployment_id: first.deployment.id }],
      'failed publication must not leave a partial desired-state record',
    );
    assert.deepEqual(
      database!.get('SELECT state FROM deployments WHERE version=?', 'failed'),
      { state: 'build_failed' },
      'rolling_out transition must roll back before recording build failure',
    );
    failPublication = false;
    assert.equal(
      (await s.deploy('recovered')).status,
      200,
      'a rolled-back transaction must leave the connection and lock usable',
    );
  } finally {
    await s.close();
  }
});

test('a build that loses its lease cannot publish or delete the replacement lease', async () => {
  let database: Awaited<ReturnType<typeof openDb>>;
  const s = await server(async (filename) => {
    database = await openDb(filename);
    return database;
  });
  const release = s.pauseBuild();
  try {
    await s.node('n1');
    const request = s.deploy('lost-lease');
    for (
      let attempt = 0;
      attempt < 100 && !s.calls.some((call) => call.startsWith('build '));
      attempt++
    )
      await delay(5);
    assert.ok(
      s.calls.some((call) => call.startsWith('build ')),
      'the build must reach external I/O before replacing its lease',
    );
    database!.run('UPDATE locks SET owner=? WHERE name=?', 'replacement-owner', 'project:app');
    release();
    assert.equal(
      (await request).status,
      409,
      'a build without its original lease must not publish',
    );
    assert.deepEqual(
      database!.all('SELECT * FROM desired_states'),
      [],
      'lease loss must leave no published desired state',
    );
    assert.deepEqual(
      database!.get('SELECT current_deployment_id FROM projects WHERE id=?', 'app'),
      { current_deployment_id: null },
      'lease loss must not make the failed deployment current',
    );
    assert.deepEqual(
      database!.get('SELECT owner FROM locks WHERE name=?', 'project:app'),
      { owner: 'replacement-owner' },
      'owner-checked cleanup must preserve the replacement lease',
    );
  } finally {
    release();
    await s.close();
  }
});
test('image prune keeps the newest deployments, refuses rollback to pruned ones and backups can omit images', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const builds: string[] = [];
    for (const version of ['v1', 'v2', 'v3']) {
      const deployed = await json(await s.deploy(version));
      builds.push(deployed.desiredState.services.app.artifact.buildId);
      await s.report(n1.nodeId, deployed.desiredState);
    }
    const archive = (id: string) => path.join(s.dir, 'images', `${id}.tar.gz`);
    const exists = (id: string) =>
      fs.stat(archive(id)).then(
        () => true,
        () => false,
      );

    const dry = await json(await s.post('/api/v1/images/prune', { keep: 1, dryRun: true }));
    assert.deepEqual(
      dry.pruned.map((build: { id: string }) => build.id).sort(),
      [builds[0], builds[1]].sort(),
      'a dry run should list every archive older than the newest deployment',
    );
    assert.ok(await exists(builds[0]), 'a dry run must not delete anything');

    const result = await json(await s.post('/api/v1/images/prune', { keep: 1 }));
    assert.equal(result.pruned.length, 2, 'two older archives should be pruned');
    assert.equal(result.freedBytes, s.bytes.length * 2, 'the freed size should be reported');
    assert.ok(!(await exists(builds[0])) && !(await exists(builds[1])), 'old archives are deleted');
    assert.ok(await exists(builds[2]), 'the current deployment archive is kept');

    const rollback = await s.post('/api/v1/rollback', { project: 'app', force: true });
    assert.equal(rollback.status, 409, 'rolling back to a pruned deployment should be refused');
    assert.match(
      (await json(rollback)).error,
      /pruned.*deploy it again/,
      'the refusal should say the archive was pruned and what to do',
    );
    assert.equal(
      (await s.post('/api/v1/images/prune', { keep: 0 })).status,
      400,
      'keep must be a positive integer',
    );

    const backup = await json(await s.post('/api/v1/control/backups/run', { images: false }));
    const entries: string[] = [];
    await tar.t({
      file: backup.artifactRef,
      onReadEntry: (entry) => void entries.push(entry.path),
    });
    assert.ok(
      !entries.some((entry) => entry.startsWith('images')),
      'a backup taken with images: false should contain no image archives',
    );
  } finally {
    await s.close();
  }
});

test('an unchanged rebuild reuses the existing archive instead of saving another copy', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const first = await json(await s.deploy('v1'));
    await s.report(n1.nodeId, first.desiredState);
    s.identicalImages();
    const second = await json(await s.deploy('v2'));
    const a = first.desiredState.services.app;
    const b = second.desiredState.services.app;
    assert.equal(
      b.artifact.buildId,
      a.artifact.buildId,
      'an identical image must point at the archive already stored',
    );
    assert.deepEqual(
      b.artifact,
      a.artifact,
      'the reused artifact must keep its original tag, image ID, checksum and size',
    );
    assert.equal(b.image, a.image, 'the service must run the reused image reference');
    assert.notEqual(
      second.desiredState.revision,
      first.desiredState.revision,
      'a reused archive must still create a new deployment revision',
    );
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'images')),
      [`${a.artifact.buildId}.tar.gz`],
      'no second archive may be written for an identical image',
    );
    assert.ok(
      s.docker.calls.includes(`image-rm tug-build/app/app:${second.desiredState.revision}`),
      'the unused per-deployment tag must be removed from the daemon',
    );
    const download = await fetch(`${s.base}/agent/v1/images/${b.artifact.buildId}`, {
      headers: { 'x-tug-test-node': n1.nodeId },
    });
    assert.equal(download.status, 200, 'the reused archive must stay downloadable by its node');
    const rollback = await json(await s.post('/api/v1/rollback', { project: 'app', force: true }));
    assert.equal(
      rollback.desiredState.services.app.artifact.buildId,
      a.artifact.buildId,
      'rollback must still resolve to the shared archive',
    );
  } finally {
    await s.close();
  }
});

test('a changed image is saved as a new archive even when an older one exists', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const first = await json(await s.deploy('v1'));
    await s.report(n1.nodeId, first.desiredState);
    const second = await json(await s.deploy('v2'));
    assert.notEqual(
      second.desiredState.services.app.artifact.buildId,
      first.desiredState.services.app.artifact.buildId,
      'a different image ID must get its own archive',
    );
    assert.equal(
      (await fs.readdir(path.join(s.dir, 'images'))).length,
      2,
      'both archives must be retained for rollback',
    );
  } finally {
    await s.close();
  }
});

async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}
const until = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
};

test('a successful deploy prunes old archives to TUG_IMAGE_KEEP and caps the build cache', async () => {
  await withEnv({ TUG_IMAGE_KEEP: '1', TUG_BUILD_CACHE_KEEP: '2GB' }, async () => {
    const s = await server();
    try {
      const n1 = await s.node('n1');
      const builds: string[] = [];
      for (const version of ['v1', 'v2', 'v3']) {
        const deployed = await json(await s.deploy(version));
        builds.push(deployed.desiredState.services.app.artifact.buildId);
        await s.report(n1.nodeId, deployed.desiredState);
      }
      const archives = () => fs.readdir(path.join(s.dir, 'images'));
      await until(async () => !(await archives()).includes(`${builds[0]}.tar.gz`));
      // The node still reported v2 when v3 was published, so v2 is kept as a lagging version.
      assert.deepEqual(
        (await archives()).sort(),
        [`${builds[1]}.tar.gz`, `${builds[2]}.tar.gz`].sort(),
        'only the archive beyond TUG_IMAGE_KEEP that no node reports should be pruned',
      );
      await until(() => s.calls.some((call) => call.startsWith('builder prune')));
      assert.ok(
        s.calls.includes('builder prune --all --force --keep-storage 2GB'),
        'the build cache must be capped at TUG_BUILD_CACHE_KEEP',
      );
    } finally {
      await s.close();
    }
  });
});

test('automatic image maintenance can be turned off', async () => {
  await withEnv({ TUG_IMAGE_KEEP: '0', TUG_BUILD_CACHE_KEEP: '0' }, async () => {
    const s = await server();
    try {
      const n1 = await s.node('n1');
      for (const version of ['v1', 'v2', 'v3'])
        await s.report(n1.nodeId, (await json(await s.deploy(version))).desiredState);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        (await fs.readdir(path.join(s.dir, 'images'))).length,
        3,
        'every archive must be kept when TUG_IMAGE_KEEP=0',
      );
      assert.ok(
        !s.calls.some((call) => call.startsWith('builder prune')),
        'the build cache must be left alone when TUG_BUILD_CACHE_KEEP=0',
      );
    } finally {
      await s.close();
    }
  });
});

test('an invalid TUG_BUILD_CACHE_KEEP is rejected at startup', async () => {
  for (const value of ['plenty', '10', '-1GB'])
    await withEnv({ TUG_BUILD_CACHE_KEEP: value }, async () => {
      await assert.rejects(
        server(),
        /TUG_BUILD_CACHE_KEEP must be a size with a unit/,
        `${JSON.stringify(value)} must fail startup: a bare number would be read as bytes and wipe the cache`,
      );
    });
});

test('an empty TUG_BUILD_CACHE_KEEP uses the default cap', async () => {
  await withEnv({ TUG_BUILD_CACHE_KEEP: '' }, async () => {
    const s = await server();
    try {
      await s.node('n1');
      await json(await s.deploy('v1'));
      await until(() => s.calls.some((call) => call.startsWith('builder prune')));
      assert.ok(
        s.calls.includes('builder prune --all --force --keep-storage 10GB'),
        'an empty value must mean the 10GB default, not a startup failure',
      );
    } finally {
      await s.close();
    }
  });
});

test('a reused archive that is missing from disk is rebuilt and saved again', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const first = await json(await s.deploy('v1'));
    await s.report(n1.nodeId, first.desiredState);
    s.identicalImages();
    await fs.rm(
      path.join(s.dir, 'images', `${first.desiredState.services.app.artifact.buildId}.tar.gz`),
    );
    const second = await json(await s.deploy('v2'));
    assert.notEqual(
      second.desiredState.services.app.artifact.buildId,
      first.desiredState.services.app.artifact.buildId,
      'an earlier archive that is gone from disk must not be reused',
    );
    assert.deepEqual(
      (await fs.readdir(path.join(s.dir, 'images'))).sort(),
      [`${second.desiredState.services.app.artifact.buildId}.tar.gz`],
      'the new archive must be written',
    );
  } finally {
    await s.close();
  }
});

test('image prune counts distinct builds, so redeploying an unchanged image keeps the last different one', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const builds: string[] = [];
    const deployAndReport = async (version: string) => {
      const deployed = await json(await s.deploy(version));
      builds.push(deployed.desiredState.services.app.artifact.buildId);
      await s.report(n1.nodeId, deployed.desiredState);
    };
    await deployAndReport('v1');
    await deployAndReport('v2');
    s.identicalImages();
    await deployAndReport('v3');
    await deployAndReport('v4');
    assert.equal(builds[3], builds[2], 'the unchanged redeploys must share one archive');
    const keepTwo = await json(await s.post('/api/v1/images/prune', { keep: 2, dryRun: true }));
    assert.equal(
      keepTwo.pruned.length,
      0,
      'keeping two builds must keep both distinct archives even though four deployments exist',
    );
    const keepOne = await json(await s.post('/api/v1/images/prune', { keep: 1, dryRun: true }));
    assert.deepEqual(
      keepOne.pruned.map((build: { id: string }) => build.id),
      [builds[0]],
      'keeping one build must prune only the older, different archive',
    );
  } finally {
    await s.close();
  }
});

test('a failing build-cache prune is logged without breaking later deploys', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    s.failMaintenance();
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(' '));
    try {
      const first = await json(await s.deploy('v1'));
      await until(() => logged.some((line) => line.includes('image maintenance failed')));
      await s.report(n1.nodeId, first.desiredState);
    } finally {
      console.error = originalError;
    }
    assert.ok(
      logged.some((line) => line.includes('image maintenance failed: prune broke')),
      'a failing maintenance step must be logged with its reason',
    );
    assert.equal(
      (await s.deploy('v2')).status,
      200,
      'a failed maintenance run must not block the next deploy',
    );
  } finally {
    await s.close();
  }
});

test('nodes stop being told to keep the image of a pruned archive', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const refs: string[] = [];
    for (const version of ['v1', 'v2']) {
      const deployed = await json(await s.deploy(version));
      refs.push(deployed.desiredState.services.app.image);
      await s.report(n1.nodeId, deployed.desiredState);
    }
    const retained = async (): Promise<string[]> =>
      (
        await json(
          await fetch(`${s.base}/agent/v1/work`, { headers: { 'x-tug-test-node': n1.nodeId } }),
        )
      ).retainedImages;
    assert.deepEqual(
      (await retained()).sort(),
      [...refs].sort(),
      'every image with an archive must stay on the nodes that run it, for rollback',
    );
    await json(await s.post('/api/v1/images/prune', { keep: 1 }));
    assert.deepEqual(
      await retained(),
      [refs[1]],
      'the image of a pruned archive must leave the retained list so the agent can remove it',
    );
  } finally {
    await s.close();
  }
});

test('a refused image removal does not fail the deployment that triggered it', async () => {
  const s = await server();
  try {
    s.docker.removeImage = async (ref: string) => {
      s.docker.calls.push(`image-rm ${ref}`);
      throw new Error('conflict: image is being used by a running container');
    };
    const n1 = await s.node('n1');
    const first = await json(await s.deploy('v1'));
    await s.report(n1.nodeId, first.desiredState);
    s.identicalImages();
    const second = await s.deploy('v2');
    assert.equal(
      second.status,
      200,
      'a daemon that refuses to remove the unused per-deployment tag must not fail the deploy',
    );
    assert.ok(
      s.docker.calls.some((call) => call.startsWith('image-rm tug-build/app/app:')),
      'control still asked the engine to remove the tag, through the Engine API',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('image rm')),
      'image removal does not run the docker CLI',
    );
  } finally {
    await s.close();
  }
});

test('an image the engine does not know or cannot describe is rejected with a clear message', async () => {
  const docker = new FakeDocker();
  await assert.rejects(
    inspectEngineImage('missing:1', docker),
    /no such image: missing:1/,
    'an unknown reference names the image',
  );
  docker.images.set('odd:1', { Id: 'sha256:' + 'a'.repeat(64) });
  await assert.rejects(
    inspectEngineImage('odd:1', docker),
    /invalid Docker image metadata for odd:1/,
    'an image without an OS or architecture is not accepted as a build result',
  );
  docker.addImage('ok:1', 'sha256:' + 'b'.repeat(64));
  assert.deepEqual(
    await inspectEngineImage('ok:1', docker),
    { imageId: 'sha256:' + 'b'.repeat(64), platform: 'linux/amd64' },
    'a complete record yields the image ID and platform',
  );
});
