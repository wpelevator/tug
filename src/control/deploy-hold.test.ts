import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { openDb } from '../db/db.ts';
import { testImageResolver, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import type { Role } from '../roles.ts';

const OPERATOR = 'op-hold-test';
async function makeServer() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-hold-'));
  process.env.TUG_DATA_DIR = data;
  process.env.TUG_CONTROL_BACKUP_DIR = path.join(data, 'control-backups');
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (bearer: string | null, method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(bearer === OPERATOR
          ? { 'x-tug-test-operator': 'operator' }
          : bearer && bearer.length > 200
            ? { 'x-tug-test-credential': bearer }
            : bearer
              ? { 'x-tug-test-node': bearer }
              : {}),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      body:
        text && res.headers.get('content-type')?.includes('application/json')
          ? JSON.parse(text)
          : null,
      text,
    };
  };
  const mint = async (name: string, role: Role, projects?: string[]) =>
    (await call(OPERATOR, 'POST', '/api/v1/credentials', { name, role, projects })).body
      .credential as string;
  return {
    dbFile: path.join(data, 'tug.db'),
    call,
    mint,
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
const twoServices = {
  services: {
    db: { image: 'mariadb:11', 'x-tug': { placement: { nodes: ['n1'] } } },
    web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: ['n1'] } } },
  },
};

test('a deploy credential places a deploy hold and releases it, but an admin keeps every other hold', async () => {
  const s = await makeServer();
  try {
    const node = await s.call(OPERATOR, 'POST', '/api/v1/nodes/register', { name: 'n1' });
    const ci = await s.mint('ci-hold', 'deploy', ['a']);
    const unknown = await s.call(ci, 'POST', '/api/v1/deployments', {
      project: 'a',
      version: 'v1',
      compose: twoServices,
      holds: ['nope'],
    });
    assert.equal(unknown.status, 400, 'holding a service that is not in the file is refused');
    assert.match(unknown.body.error, /--hold names nope/, 'the refusal names the service');
    const deployed = await s.call(ci, 'POST', '/api/v1/deployments', {
      project: 'a',
      version: 'v1',
      compose: twoServices,
      holds: ['web', 'web'],
    });
    assert.equal(
      deployed.status,
      200,
      `a deploy credential may deploy with a hold: ${deployed.text}`,
    );
    const work = await s.call(node.body.nodeId, 'GET', '/agent/v1/work');
    assert.deepEqual(work.body.holds, { a: ['web'] }, 'the agent is told to keep web stopped');
    const holds = async () =>
      (await s.call(OPERATOR, 'GET', '/api/v1/holds?project=a')).body.holds as {
        service: string;
        reason: string;
      }[];
    assert.deepEqual(
      (await holds()).map((h) => [h.service, h.reason]),
      [['web', 'deploy hold']],
      'the hold records why it exists',
    );
    // The first rollout has to finish before another deploy is accepted.
    await s.call(node.body.nodeId, 'POST', '/agent/v1/status', {
      projects: [
        {
          project: 'a',
          observedVersion: 'v1',
          observedRevision: work.body.desiredStates[0].revision,
          health: 'serving',
        },
      ],
      commandResults: [],
    });
    const again = await s.call(ci, 'POST', '/api/v1/deployments', {
      project: 'a',
      version: 'v2',
      compose: twoServices,
    });
    assert.equal(again.status, 200, `a later deploy succeeds: ${again.text}`);
    assert.equal((await holds()).length, 1, 'the hold persists across later deploys, once');

    // An admin's hold for another reason, such as a moved service, stays with an admin. A move hold is written with
    // INSERT OR REPLACE, so a move acknowledged on a service that already carried a `deploy hold` overwrites its reason
    // with `moved <service>`: that hold then needs an admin to release it, which is intended, because the moved
    // service is empty until its data is restored.
    (await openDb(s.dbFile)).run(
      "INSERT INTO service_holds(project_id,service,reason,restore_id,created_at) VALUES('a','db','moved db',NULL,'2026-11-01T00:00:00Z')",
    );
    const named = await s.call(ci, 'POST', '/api/v1/holds/release', {
      project: 'a',
      services: ['db'],
    });
    assert.equal(named.status, 403, 'a deploy credential cannot release a move hold by name');
    assert.match(named.body.error, /only an admin credential/, 'the refusal says who can');
    const all = await s.call(ci, 'POST', '/api/v1/holds/release', { project: 'a' });
    assert.deepEqual(
      all.body.released,
      ['web'],
      'releasing all as a deploy credential releases only the deploy holds',
    );
    assert.deepEqual(
      (await holds()).map((h) => h.service),
      ['db'],
      'the move hold is still there',
    );
    const admin = await s.call(OPERATOR, 'POST', '/api/v1/holds/release', { project: 'a' });
    assert.deepEqual(admin.body.released, ['db'], 'an admin releases the rest');
    const viewer = await s.mint('view-hold', 'read', ['a']);
    assert.equal(
      (await s.call(viewer, 'POST', '/api/v1/holds/release', { project: 'a' })).status,
      403,
      'a read credential cannot release holds',
    );
  } finally {
    await s.close();
  }
});
