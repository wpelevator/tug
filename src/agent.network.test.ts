import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { pollOnce } from './agent.ts';
import type { AgentContext } from './agent.ts';
import { buildDesiredState } from './compose.ts';
import type { ComposeFile, WorkResponse } from './protocol.ts';
import type { HttpClient } from './runners.ts';
import { FakeDocker, normalized } from '../tests/fake-docker.ts';

/** One ordered log across Docker and control calls so tests can assert ordering between them. */
function harness(work: () => Partial<WorkResponse>) {
  const docker = new FakeDocker();
  const log = docker.calls;
  const posts: { route: string; body: any }[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname;
    if (init?.method === 'POST') {
      posts.push({ route, body: JSON.parse(String(init.body)) });
      log.push(`POST ${route}`);
      return Response.json({ ok: true });
    }
    if (route === '/agent/v1/work')
      return Response.json({
        serverTime: 't',
        nodeId: 'n1',
        desiredStates: [],
        commands: [],
        ...work(),
      });
    return Response.json({ secrets: {}, versions: {} });
  }) as HttpClient;
  return { log, posts, docker, http };
}
const makeCtx = async (h: ReturnType<typeof harness>): Promise<AgentContext> => ({
  docker: h.docker,
  http: h.http,
  nodeName: 'n1',
  stateDir: await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-net-')),
  apply: true,
  controlUrl: 'http://control.test',
});

const compose: ComposeFile = {
  services: {
    web: { image: 'nginx', 'x-tug': { placement: { nodes: ['n1'] } } },
    db: { image: 'mariadb', 'x-tug': { placement: { nodes: ['n2'] } } },
  },
};
const desired = buildDesiredState({
  project: 'blog',
  version: 'v1',
  compose: normalized(compose),
});

test('poll injects cross-node service endpoints as plain-address extra hosts', async () => {
  const h = harness(() => ({
    desiredStates: [desired],
    serviceEndpoints: { blog: { db: [{ node: 'n2', address: '192.168.10.2' }] } },
  }));
  const ctx = await makeCtx(h);
  await pollOnce(ctx);

  const extraHosts = h.docker.service('blog', 'web')[0].body.HostConfig?.ExtraHosts as
    string[] | undefined;
  assert.ok(
    extraHosts?.includes('db:192.168.10.2'),
    'the remote service name resolves to the node address through ExtraHosts',
  );
  assert.ok(
    extraHosts?.includes('db.blog.tug:192.168.10.2'),
    'the project-qualified service name resolves to the same plain node address',
  );
});

test('poll resolves hostname node addresses to IPs for extra hosts', async () => {
  const h = harness(() => ({
    desiredStates: [desired],
    serviceEndpoints: { blog: { db: [{ node: 'n2', address: 'localhost' }] } },
  }));
  const ctx = await makeCtx(h);
  await pollOnce(ctx);

  const extraHosts = h.docker.service('blog', 'web')[0].body.HostConfig?.ExtraHosts as
    string[] | undefined;
  const address = extraHosts?.find((host) => host.startsWith('db:'))?.slice(3);
  assert.notEqual(
    isIP(address || ''),
    0,
    'a hostname node address resolves to an IP before Docker creates the client container',
  );
  assert.equal(
    extraHosts?.includes('db:localhost'),
    false,
    'Docker should not receive a hostname as an extra-host IP value',
  );
  assert.ok(
    extraHosts?.includes(`db.blog.tug:${address}`),
    'the project-qualified service name uses the resolved IP too',
  );
});

test('an ingress node runs Caddy and reports its status; losing the role removes the container', async () => {
  const ingress = { caddyfile: 'app.example.com {\n}\n', files: {}, routes: [], warnings: [] };
  let current: Partial<WorkResponse> = { ingress };
  const h = harness(() => current);
  const ctx = await makeCtx(h);
  await pollOnce(ctx);
  assert.ok(h.docker.byName('tug-caddy'), 'the managed Caddy container is created');
  assert.equal(
    h.docker.byName('tug-caddy')?.state,
    'running',
    'the managed Caddy container is started',
  );
  const status = h.posts.find((p) => p.route === '/agent/v1/status')!.body;
  assert.equal(status.ingress.state, 'serving', 'edge state is part of the status report');
  assert.equal(status.ingress.routes, 0, 'the status report includes the ingress route count');

  current = {};
  h.log.length = 0;
  h.posts.length = 0;
  await pollOnce(ctx);
  assert.equal(
    h.docker.byName('tug-caddy'),
    undefined,
    'the container is removed once control stops sending ingress',
  );
  assert.equal(
    h.posts.find((p) => p.route === '/agent/v1/status')!.body.ingress,
    undefined,
    'no ingress status is reported for non-ingress nodes',
  );
});

test('unresolvable endpoints do not block local services or healthy remote endpoints', async () => {
  const h = harness(() => ({
    desiredStates: [desired],
    serviceEndpoints: {
      blog: {
        web: [{ node: 'n1', address: 'missing.invalid' }],
        db: [
          { node: 'n2', address: 'missing.invalid' },
          { node: 'n3', address: '192.168.10.3' },
        ],
      },
    },
  }));
  const ctx = await makeCtx(h);
  const result = await pollOnce(ctx);
  assert.equal(result[0].health, 'serving', 'unresolvable endpoints should not fail the project');
  const hosts = h.docker.service('blog', 'web')[0].body.HostConfig?.ExtraHosts as string[];
  assert.ok(hosts.includes('db:192.168.10.3'), 'resolvable endpoints should remain available');
  assert.equal(
    hosts.some((host) => host.includes('missing.invalid')),
    false,
    'unresolvable endpoints should be omitted',
  );
});
