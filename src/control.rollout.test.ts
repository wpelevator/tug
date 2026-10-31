import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json } from '../tests/helpers.ts';
import type { ComposeFile } from './protocol.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-rollout-'));
  for (const key of ['TUG_MESH', 'TUG_SERVICE_DNS']) delete process.env[key];
  Object.assign(process.env, { TUG_DATA_DIR: dir, TUG_OPERATOR_TOKEN: 'op-rollout-token', TUG_REGISTRY: 'registry.test', TUG_PUSH: 'false' });
  const app = await createApp();
  const srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const op = { Authorization: 'Bearer op-rollout-token', 'content-type': 'application/json' };
  const agent = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const post = (route: string, body: unknown, headers: Record<string, string> = op) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = async (route: string) => json(await fetch(`${base}${route}`, { headers: op }));
  const register = async (name: string, body: Record<string, unknown> = {}) => json(await post('/api/v1/nodes/register', { name, ...body }));
  const deploy = async (compose: ComposeFile, version: string, project = 'site') => {
    const res = await post('/api/v1/deployments', { project, version, compose });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    return body as { deployment: { id: string }; desiredState: { revision: string } };
  };
  /** Posts a node status for the project's current desired revision. */
  const report = async (token: string, node: string, health: 'serving' | 'failed', services: Record<string, Record<string, unknown>>, project = 'site') => {
    const w = await json(await fetch(`${base}/agent/v1/work`, { headers: agent(token) }));
    const state = w.desiredStates.find((st: { project: string }) => st.project === project);
    const res = await post('/agent/v1/status', { node, commandResults: [], projects: [{ project, observedVersion: state.version, observedRevision: state.revision, health, services: Object.keys(services), serviceStates: services }] }, agent(token));
    assert.equal(res.status, 200);
  };
  const deployment = async (id: string) => get(`/api/v1/deployments/${id}`);
  const events = async (project = 'site') => (await get(`/api/v1/events?project=${project}&limit=100`)).events as { type: string; message: string; deployment_id: string | null }[];
  const waitFor = async <T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> => {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      assert.ok(Date.now() - started < timeoutMs, `timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  return { base, post, get, agent, register, deploy, report, deployment, events, waitFor, close: () => new Promise(resolve => srv.close(resolve)) };
}

const web = (image: string): ComposeFile['services'][string] => ({
  image, ports: ['8080:80'],
  'x-tug': {
    placement: { nodes: ['app'] }, health: { type: 'http', port: 80 }, ingress: { host: 'app.example.com', port: 80, tls: 'off' },
    rollout: { strategy: 'rolling', drain: '10s' }
  }
});
const stack = (image: string, projectExtension: ComposeFile['x-tug'] | undefined = undefined): ComposeFile => ({ services: { web: web(image) }, ...(projectExtension ? { 'x-tug': projectExtension } : {}) });
const serving = (port?: number, extra: Record<string, unknown> = {}) => ({ web: { rolloutState: 'serving', ...(port ? { port } : {}), ...extra } });

test('ingress follows the port a rolling service reports and keeps the old one when the new revision fails', async () => {
  const s = await server();
  try {
    const edge = await s.register('edge'); const app = await s.register('app', { address: '192.168.1.5' });
    await s.post('/api/v1/nodes/edge/ingress', { enabled: true });
    await s.deploy(stack('web:1'), 'v1');
    await s.report(app.agentToken, 'app', 'serving', serving(20000));
    const edgeWork = async () => json(await fetch(`${s.base}/agent/v1/work`, { headers: s.agent(edge.agentToken) }));
    assert.deepEqual((await edgeWork()).ingress.routes[0].upstreams, ['192.168.1.5:20000'], 'the upstream is the reported revision port, not the declared 8080');

    await s.deploy(stack('web:2'), 'v2');
    assert.deepEqual((await edgeWork()).ingress.routes[0].upstreams, ['192.168.1.5:20000'], 'while the new revision is starting nothing changes');
    await s.report(app.agentToken, 'app', 'serving', serving(20001));
    const switched = await edgeWork();
    assert.deepEqual(switched.ingress.routes[0].upstreams, ['192.168.1.5:20001'], 'the route moves to the new revision as soon as the node reports it');
    assert.match(switched.ingress.caddyfile, /reverse_proxy 192\.168\.1\.5:20001/, 'the rendered Caddyfile changes so the agent reloads Caddy');

    await s.deploy(stack('web:3'), 'v3');
    await s.report(app.agentToken, 'app', 'failed', serving(20001, { rolloutError: 'http 503' }));
    const kept = await edgeWork();
    assert.deepEqual(kept.ingress.routes[0].upstreams, ['192.168.1.5:20001'], 'a rejected revision leaves the route on the serving one');
    assert.deepEqual(kept.ingress.warnings, [], 'no route is withheld');
  } finally { await s.close(); }
});

test('the edge on the app node itself reaches a rolling service on loopback and the reported port', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.post('/api/v1/nodes/app/ingress', { enabled: true });
    await s.deploy(stack('web:1'), 'v1');
    await s.report(app.agentToken, 'app', 'serving', serving(20007));
    const w = await json(await fetch(`${s.base}/agent/v1/work`, { headers: s.agent(app.agentToken) }));
    assert.deepEqual(w.ingress.routes[0].upstreams, ['127.0.0.1:20007'], 'loopback upstream uses the revision port');
  } finally { await s.close(); }
});

test('recreated services still route to their declared published port', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.post('/api/v1/nodes/app/ingress', { enabled: true });
    const plain = stack('web:1'); delete (plain.services.web['x-tug'] as Record<string, unknown>).rollout;
    await s.deploy(plain, 'v1');
    await s.report(app.agentToken, 'app', 'serving', serving());
    const w = await json(await fetch(`${s.base}/agent/v1/work`, { headers: s.agent(app.agentToken) }));
    assert.deepEqual(w.ingress.routes[0].upstreams, ['127.0.0.1:8080'], 'without a reported port the declared one is used, as before');
  } finally { await s.close(); }
});

test('deployment convergence: serving succeeds, a failed node marks the deployment failed', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    const v1 = await s.deploy(stack('web:1'), 'v1');
    assert.equal((await s.deployment(v1.deployment.id)).state, 'rolling_out', 'a new deployment is rolling out');
    await s.report(app.agentToken, 'app', 'serving', serving(20000));
    assert.equal((await s.deployment(v1.deployment.id)).state, 'succeeded', 'all nodes serving the revision succeeds the deployment');

    const v2 = await s.deploy(stack('web:2'), 'v2');
    await s.report(app.agentToken, 'app', 'failed', serving(20000, { rolloutError: 'http 503' }));
    const failed = await s.deployment(v2.deployment.id);
    assert.equal(failed.state, 'failed', 'a node reporting failed health for the new revision fails the deployment');
    assert.match(failed.error_message, /failed health/, 'the reason is recorded');
    assert.equal((await s.events()).some(e => e.type.startsWith('deployment.auto_rollback')), false, 'nothing rolls back without opting in');
  } finally { await s.close(); }
});

test('with rollback: auto a failed deployment is rolled back to the previous succeeded one and recorded', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    const v1 = await s.deploy(stack('web:1', { rollback: 'auto' }), 'v1');
    await s.report(app.agentToken, 'app', 'serving', serving(20000));
    const v2 = await s.deploy(stack('web:2', { rollback: 'auto' }), 'v2');
    await s.report(app.agentToken, 'app', 'failed', serving(20000, { rolloutError: 'http 503' }));

    const event = await s.waitFor('the auto rollback event', async () => (await s.events()).find(e => e.type === 'deployment.auto_rollback'));
    assert.match(event.message, new RegExp(`${v2.deployment.id}.*rolled back to v1`), 'the event explains what failed and what it went back to');
    assert.equal((await s.deployment(v2.deployment.id)).state, 'failed', 'the failed deployment stays failed');
    const work = await json(await fetch(`${s.base}/agent/v1/work`, { headers: s.agent(app.agentToken) }));
    const rollback = work.desiredStates[0];
    assert.equal(rollback.version, 'v1', 'agents now receive the previous desired state');
    assert.equal(rollback.services.web.image, 'web:1', 'it carries the previous service definition');
    assert.equal(rollback.compose.services.web.image, 'web:1', 'the previous image is desired again');
    assert.notEqual(rollback.revision, v1.desiredState.revision, 'the rollback has its own revision so nodes report it separately');
    const rollbackDeployment = await s.deployment(rollback.revision);
    assert.match(rollbackDeployment.version, /^rollback-v1-/, 'the rollback deployment is marked by its version prefix');
    assert.equal(rollbackDeployment.state, 'rolling_out', 'the rollback converges like any deployment');

    await s.report(app.agentToken, 'app', 'serving', serving(20000));
    assert.equal((await s.deployment(rollback.revision)).state, 'succeeded', 'the rollback succeeds when the node serves it');
  } finally { await s.close(); }
});

test('a failing rollback deployment is never rolled back again', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.deploy(stack('web:1', { rollback: 'auto' }), 'v1');
    await s.report(app.agentToken, 'app', 'serving', serving(20000));
    await s.deploy(stack('web:2', { rollback: 'auto' }), 'v2');
    await s.report(app.agentToken, 'app', 'failed', serving(20000));
    await s.waitFor('the first auto rollback', async () => (await s.events()).find(e => e.type === 'deployment.auto_rollback'));

    await s.report(app.agentToken, 'app', 'failed', serving(20000));
    const skipped = await s.waitFor('the loop guard event', async () => (await s.events()).find(e => e.type === 'deployment.auto_rollback_skipped'));
    assert.match(skipped.message, /not rolling back a rollback/, 'the event says why nothing happened');
    await new Promise(resolve => setTimeout(resolve, 100));
    const all = await s.events();
    assert.equal(all.filter(e => e.type === 'deployment.auto_rollback').length, 1, 'exactly one automatic rollback happened');
    const status = await s.get('/api/v1/status');
    assert.equal(status.deployments.filter((d: { project_id: string }) => d.project_id === 'site').length, 3, 'no further deployment was created (v1, v2, one rollback)');
  } finally { await s.close(); }
});

test('auto rollback needs a previous succeeded deployment', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    const v1 = await s.deploy(stack('web:1', { rollback: 'auto' }), 'v1');
    await s.report(app.agentToken, 'app', 'failed', {});
    const skipped = await s.waitFor('the skipped event', async () => (await s.events()).find(e => e.type === 'deployment.auto_rollback_skipped'));
    assert.match(skipped.message, /no previous deployment found/, 'a first deployment has nothing to go back to');
    assert.equal((await s.deployment(v1.deployment.id)).state, 'failed', 'the deployment stays failed');
    assert.equal((await s.events()).some(e => e.type === 'deployment.auto_rollback'), false, 'no rollback was created');

    // A previous deployment that never succeeded is not a rollback target either.
    const v2 = await s.deploy(stack('web:2', { rollback: 'auto' }), 'v2');
    const v3 = await s.deploy(stack('web:3', { rollback: 'auto' }), 'v3').catch(() => null);
    assert.equal(v3, null, 'a deployment is refused while another is still rolling out');
    await s.report(app.agentToken, 'app', 'failed', {});
    await s.waitFor('the second skipped event', async () => (await s.events()).filter(e => e.type === 'deployment.auto_rollback_skipped').length >= 2);
    assert.equal((await s.deployment(v2.deployment.id)).state, 'failed');
  } finally { await s.close(); }
});

test('manual rollback still works and deployments cannot use the reserved rollback version prefix', async () => {
  const s = await server();
  try {
    const app = await s.register('app', { address: '192.168.1.5' });
    await s.deploy(stack('web:1'), 'v1');
    await s.report(app.agentToken, 'app', 'serving', serving(20000));
    await s.deploy(stack('web:2'), 'v2');
    await s.report(app.agentToken, 'app', 'failed', serving(20000));
    const rb = await s.post('/api/v1/rollback', { project: 'site' });
    const body = await json(rb);
    assert.equal(rb.status, 200, JSON.stringify(body));
    assert.equal(body.desiredState.version, 'v1', 'manual rollback copies the previous desired state');
    assert.equal((await s.post('/api/v1/rollback', { project: 'nothing' })).status, 404, 'a project without history reports no previous deployment');

    const reserved = await s.post('/api/v1/deployments', { project: 'site', version: 'rollback-v1-1', compose: stack('web:9') });
    assert.equal(reserved.status, 400, 'the reserved prefix is rejected');
    assert.match((await json(reserved)).error, /reserved for rollback/, 'the error says why');
  } finally { await s.close(); }
});

test('deploy validates rollout and rollback options', async () => {
  const s = await server();
  try {
    await s.register('app', { address: '192.168.1.5' });
    const noIngress = stack('web:1'); delete (noIngress.services.web['x-tug'] as Record<string, unknown>).ingress;
    const res = await s.post('/api/v1/deployments', { project: 'site', version: 'v1', compose: noIngress });
    assert.equal(res.status, 400, 'rolling without ingress is rejected at deploy time');
    assert.match((await json(res)).error, /requires x-tug\.ingress/);
    const bad = await s.post('/api/v1/deployments', { project: 'site', version: 'v1', compose: stack('web:1', { rollback: 'sometimes' as 'auto' }) });
    assert.equal(bad.status, 400, 'an unknown rollback mode is rejected');
  } finally { await s.close(); }
});
