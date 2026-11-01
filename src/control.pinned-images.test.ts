import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testIdentity } from '../tests/helpers.ts';
import { resolveImage } from './registry.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-pinning-'));
  process.env.TUG_DATA_DIR = dir;
  let generation = 1;
  let fail = false;
  const calls: string[] = [];
  const app = await createApp({
    identity: testIdentity,
    images: {
      resolve: (image, credentials) => {
        calls.push(image);
        assert.deepEqual(
          credentials?.['private.example'],
          { username: 'ci', password: 'private-password' },
          'control must decrypt the project registry credential for resolution',
        );
        return resolveImage(image, credentials, async () => {
          if (fail) return new Response('', { status: 503 });
          return Response.json({
            schemaVersion: 2,
            config: { digest: String(generation) },
            layers: [],
          });
        });
      },
    },
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown, token = 'pin-op') =>
    fetch(base + route, {
      method: 'POST',
      headers: {
        ...(token === 'pin-op'
          ? { 'x-tug-test-operator': 'operator' }
          : { 'x-tug-test-node': token }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const node = async (name: string) => json(await post('/api/v1/nodes/register', { name }));
  const secret = await post('/api/v1/secrets', {
    project: 'site',
    name: 'TUG_REGISTRY_AUTH',
    value: JSON.stringify({
      'private.example': { username: 'ci', password: 'private-password' },
      'unrelated.example': { username: 'other', password: 'other-password' },
    }),
  });
  assert.equal(secret.status, 200, 'project registry credentials must be stored as a secret');
  const deploy = (version: string) =>
    post('/api/v1/deployments', {
      project: 'site',
      version,
      compose: {
        services: {
          app: {
            image: 'private.example/team/app:latest',
            'x-tug': { placement: { nodes: ['n1'] } },
          },
          worker: {
            image: 'private.example/team/app:latest',
            'x-tug': { placement: { nodes: ['n1'] } },
          },
        },
      },
    });
  const report = (token: string, desired: { version: string; revision: string }) =>
    post(
      '/agent/v1/status',
      {
        projects: [
          {
            project: 'site',
            observedVersion: desired.version,
            observedRevision: desired.revision,
            health: 'serving',
          },
        ],
      },
      token,
    );
  const get = (route: string, token: string) =>
    fetch(base + route, { headers: { 'x-tug-test-node': token } });
  return {
    dir,
    base,
    post,
    get,
    node,
    deploy,
    report,
    calls,
    moveTag: () => generation++,
    fail: () => {
      fail = true;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        srv.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('published images pin once per deployment, rollback and late nodes keep the original digest', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    assert.equal(n1.registryToken, undefined, 'registration must issue only an agent credential');
    const firstResponse = await s.deploy('one');
    assert.equal(
      firstResponse.status,
      200,
      'published images must resolve before desired state is published',
    );
    const first = await json(firstResponse);
    const pin = first.desiredState.services.app.image;
    assert.match(
      pin,
      /^private\.example\/team\/app:latest@sha256:[a-f0-9]{64}$/,
      'desired state must contain an immutable registry digest',
    );
    assert.equal(
      first.desiredState.compose.services.app.image,
      pin,
      'the canonical Compose definition must retain the same image pin',
    );
    assert.equal(
      first.desiredState.services.worker.image,
      pin,
      'services sharing a moving tag must share its single resolved digest',
    );
    assert.equal(
      s.calls.length,
      1,
      'each distinct image must be resolved only once per deployment',
    );
    assert.ok(
      !JSON.stringify(first).includes('private-password'),
      'desired state and deployment responses must never contain registry passwords',
    );
    await s.report(n1.agentToken, first.desiredState);
    s.moveTag();
    const n2 = await s.node('n2');
    await s.post('/api/v1/scale', { project: 'site', service: 'app', replicas: 2 });
    const late = await json(await s.get('/agent/v1/work', n2.agentToken));
    assert.equal(
      late.desiredStates[0].services.app.image,
      pin,
      'a node added after a tag moves must receive the original image pin',
    );
    assert.equal(s.calls.length, 1, 'scaling must not resolve moving image tags again');
    const second = await json(await s.deploy('two'));
    assert.notEqual(
      second.desiredState.services.app.image,
      pin,
      'a new deployment must resolve the updated tag',
    );
    const rollback = await json(await s.post('/api/v1/rollback', { project: 'site', force: true }));
    assert.equal(
      rollback.desiredState.services.app.image,
      pin,
      'rollback must restore the original digest even after the upstream tag moves',
    );
    assert.equal(s.calls.length, 2, 'rollback must never contact the registry to re-resolve a tag');
  } finally {
    await s.close();
  }
});

test('resolution failures preserve the previous deployment and private credentials follow placement only', async () => {
  const s = await server();
  try {
    const n1 = await s.node('n1');
    const n2 = await s.node('n2');
    const first = await json(await s.deploy('good'));
    await s.report(n1.agentToken, first.desiredState);
    const auth = await json(
      await s.get('/agent/v1/secrets?project=site&services=app', n1.agentToken),
    );
    assert.deepEqual(
      Object.keys(auth.registryAuth),
      ['private.example'],
      'assigned agents must receive only credentials for their published image hosts',
    );
    assert.deepEqual(
      auth.secrets,
      {},
      'registry authentication must never enter the container environment secret map',
    );
    for (const query of [
      '?project=site&services=app',
      '?project=site',
      '?project=other&services=app',
    ]) {
      const denied = await json(await s.get('/agent/v1/secrets' + query, n2.agentToken));
      assert.equal(
        denied.registryAuth,
        undefined,
        'unassigned nodes must not obtain registry credentials through service or project query overrides',
      );
    }
    const reserved = await s.post('/api/v1/deployments', {
      project: 'site',
      compose: {
        services: {
          app: {
            image: 'private.example/team/app',
            environment: { BAD: '@@tug:secret:TUG_REGISTRY_AUTH@@' },
            'x-tug': { placement: { nodes: ['n1'] } },
          },
        },
      },
    });
    assert.equal(
      reserved.status,
      400,
      'the reserved registry secret must not be interpolated into service definitions',
    );
    s.fail();
    const failed = await s.deploy('broken');
    assert.equal(failed.status, 500, 'a registry resolution failure must reject the deployment');
    assert.ok(
      !JSON.stringify(await json(failed)).includes('private-password'),
      'resolution errors must not expose registry credentials',
    );
    const work = await json(await s.get('/agent/v1/work', n1.agentToken));
    assert.equal(
      work.desiredStates[0].revision,
      first.desiredState.revision,
      'failed resolution must leave the current desired state untouched',
    );
    for (const route of [
      '/api/v1/registry/auth',
      '/api/v1/nodes/n1/rotate-registry-token',
      '/api/v1/nodes/n1/revoke-registry-token',
    ])
      assert.equal(
        (await s.post(route, {})).status,
        404,
        'removed registry credential APIs must no longer exist',
      );
  } finally {
    await s.close();
  }
});
