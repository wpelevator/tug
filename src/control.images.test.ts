import test from 'node:test';
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
import { openDb } from './db.ts';
import { json } from '../tests/helpers.ts';

async function server(registry = '', openDatabase?: typeof openDb) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-images-'));
  Object.assign(process.env, {
    TUG_DATA_DIR: dir,
    TUG_OPERATOR_TOKEN: 'images-op',
    TUG_REGISTRY: registry,
  });
  delete process.env.TUG_REGISTRY_AUTH_PATH;
  delete process.env.TUG_REGISTRY_CONTAINER;
  const bytes = Buffer.from('saved image gzip');
  const calls: string[] = [];
  const imageInfo = { imageId: `sha256:${'a'.repeat(64)}`, platform: 'linux/amd64' };
  const info = {
    ...imageInfo,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  let fail = false;
  let buildGate: Promise<void> | undefined;
  const app = await createApp({
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
      inspect: async () => imageInfo,
      validate: async () => info,
      run: async (_cmd, args) => {
        calls.push(args.join(' '));
        return { out: '', err: '' };
      },
    },
  });
  const srv = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const headers = { Authorization: 'Bearer images-op', 'content-type': 'application/json' };
  const post = async (route: string, body: unknown, token?: string) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
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
      headers: { Authorization: 'Bearer images-op' },
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
    const downloaded = await fetch(url, { headers: { Authorization: `Bearer ${n1.agentToken}` } });
    assert.equal(downloaded.status, 200, 'an assigned node must be able to download its image');
    assert.deepEqual(
      Buffer.from(await downloaded.arrayBuffer()),
      s.bytes,
      'the download must preserve exact compressed bytes',
    );
    assert.equal(
      (await fetch(url, { headers: { Authorization: `Bearer ${n2.agentToken}` } })).status,
      404,
      'an unassigned node must not read another node image',
    );
    assert.equal((await fetch(url)).status, 401, 'image downloads must require a live node token');
    await s.report(n1.agentToken, first.desiredState);
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
    await s.report(n1.agentToken, first.desiredState);
    const pending = await json(
      await fetch(`${s.base}/api/v1/deployments/${second.deployment.id}`, {
        headers: { Authorization: 'Bearer images-op' },
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
      (await fetch(url, { headers: { Authorization: `Bearer ${n1.agentToken}` } })).status,
      200,
      'retained rollback artifacts must survive subsequent publication and cleanup',
    );
    await s.node('n1');
    assert.equal(
      (await fetch(url, { headers: { Authorization: `Bearer ${n1.agentToken}` } })).status,
      401,
      'rotating registration credentials must revoke previous download access',
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
      s.calls.includes('image rm tug-build/00000000-0000-4000-8000-000000000000/image-0:local'),
      'control must remove only the validated generated client tag after retagging its immutable image',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('build ')),
      'local uploads must never rebuild sources on control',
    );
    await s.report(n1.agentToken, local.desiredState);
    s.failBuild();
    assert.equal(
      (await s.deploy('broken')).status,
      500,
      'a failed Docker build must fail the deployment request',
    );
    const work = await json(
      await fetch(`${s.base}/agent/v1/work`, {
        headers: { Authorization: `Bearer ${n1.agentToken}` },
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
      (await fetch(`${s.base}/api/v1/status`, { headers: { Authorization: 'Bearer images-op' } }))
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
      (await fetch(`${s.base}/api/v1/status`, { headers: { Authorization: 'Bearer images-op' } }))
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

test('configured registry still accepts local builds and pushes them without storing an image archive', async () => {
  const s = await server('registry.test');
  try {
    await s.node('n1');
    const response = await s.deploy('local-registry', true);
    assert.equal(
      response.status,
      200,
      'local image uploads must remain available with a bring-your-own registry',
    );
    const deployed = await json(response);
    assert.match(
      deployed.desiredState.services.app.image,
      /^registry\.test\//,
      'registry mode must publish registry-qualified immutable references',
    );
    assert.equal(
      deployed.desiredState.services.app.artifact,
      undefined,
      'registry-backed desired state must use pulls instead of artifact downloads',
    );
    assert.ok(
      s.calls.some((call) => call.startsWith('push registry.test/')),
      'control must push verified local images to the configured registry',
    );
    assert.deepEqual(
      await fs.readdir(path.join(s.dir, 'images')),
      [],
      'registry builds must not leave compressed delivery archives',
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
      await fetch(`${s.base}/api/v1/status`, { headers: { Authorization: 'Bearer images-op' } }),
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
        headers: { Authorization: 'Bearer images-op' },
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
function databaseGate() {
  let pattern: string | undefined;
  let release!: () => void;
  let entered!: () => void;
  let pending: Promise<void>;
  let reached: Promise<void>;
  const openDatabase: typeof openDb = async (filename) => {
    const db = await openDb(filename);
    const run = db.run.bind(db);
    const exec = db.exec.bind(db);
    db.run = async (...args: Parameters<typeof db.run>) => {
      if (pattern && String(args[0]).startsWith(pattern)) {
        pattern = undefined;
        entered();
        await pending;
      }
      return run(...args);
    };
    db.exec = async (...args: Parameters<typeof db.exec>) => {
      if (pattern && String(args[0]).startsWith(pattern)) {
        pattern = undefined;
        entered();
        await pending;
      }
      return exec(...args);
    };
    return db;
  };
  return {
    openDatabase,
    hold: (sql: string) => {
      pattern = sql;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { release: () => release(), reached };
    },
  };
}
test('an in-flight status request returns 503 after restore instead of rejecting outside Express', async () => {
  const gate = databaseGate();
  const s = await server('', gate.openDatabase);
  try {
    const backup = await json(await s.post('/api/v1/control/backups/run', {}));
    const held = gate.hold("UPDATE nodes SET status='stale'");
    const status = fetch(`${s.base}/api/v1/status`, {
      headers: { Authorization: 'Bearer images-op' },
    });
    await held.reached;
    assert.equal(
      (await s.post('/api/v1/control/restore', { artifactRef: backup.artifactRef, confirm: true }))
        .status,
      200,
      'restore must finish while an earlier status request is waiting',
    );
    held.release();
    assert.equal(
      (await status).status,
      503,
      'in-flight routes must convert closed-database failures to restart-required responses',
    );
  } finally {
    await s.close();
  }
});
test('writer operations queued behind a restore recheck restart readiness before using SQLite', async () => {
  const gate = databaseGate();
  const s = await server('', gate.openDatabase);
  try {
    const backup = await json(await s.post('/api/v1/control/backups/run', {}));
    const held = gate.hold('VACUUM INTO');
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
      headers: { Authorization: 'Bearer images-op' },
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
