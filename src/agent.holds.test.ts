import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcile } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState } from './compose.ts';
import type { HttpClient } from './runners.ts';
import { FakeDocker, normalized } from '../tests/fake-docker.ts';

async function makeCtx(docker: FakeDocker): Promise<AgentContext> {
  const http = (async (url: string | URL | Request) =>
    String(url).includes('/agent/v1/secrets')
      ? Response.json({ secrets: {}, versions: {} })
      : Response.json({ ok: true })) as HttpClient;
  return {
    docker,
    http,
    nodeName: 'n1',
    stateDir: await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-holds-')),
    apply: true,
    controlUrl: 'http://control.test',
    token: 'tok',
  };
}

const desired = buildDesiredState({
  project: 'proj',
  version: 'v1',
  compose: normalized({
    services: {
      web: { image: 'nginx', 'x-tug': { placement: { nodes: ['n1'] } } },
      db: { image: 'mariadb', 'x-tug': { placement: { nodes: ['n1'] } } },
    },
  }),
});

test('a held service is stopped and left alone, and restarts unchanged when the hold is dropped', async () => {
  const docker = new FakeDocker();
  const ctx = await makeCtx(docker);
  await reconcile(desired, ctx);
  assert.deepEqual(docker.running().length, 2, 'both services run before the hold');
  const web = docker.service('proj', 'web')[0].id;

  const held = await reconcile(desired, ctx, undefined, undefined, ['web']);
  assert.equal(docker.service('proj', 'web')[0].state, 'exited', 'the held service is stopped');
  assert.equal(docker.service('proj', 'db')[0].state, 'running', 'other services keep running');
  assert.equal(held.serviceStates?.web.rolloutState, 'held', 'the hold is reported');
  assert.equal(held.health, 'serving', 'a hold is not a failure');

  await reconcile(desired, ctx, undefined, undefined, ['web']);
  assert.equal(
    docker.service('proj', 'web')[0].state,
    'exited',
    'polling again does not restart it',
  );

  await reconcile(desired, ctx);
  assert.equal(
    docker.service('proj', 'web')[0].state,
    'running',
    'the service starts when released',
  );
  assert.equal(
    docker.service('proj', 'web')[0].id,
    web,
    'it is the same container, not a recreation',
  );
});

test('holds for services on other nodes or unknown services are ignored', async () => {
  const docker = new FakeDocker();
  const ctx = await makeCtx(docker);
  await reconcile(desired, ctx, undefined, undefined, ['ghost']);
  assert.equal(docker.running().length, 2, 'an unknown hold changes nothing');
});
