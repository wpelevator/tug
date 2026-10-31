import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { ROLES, ROUTE_ROLES, hasRole } from './tokens.ts';
import type { Role } from './tokens.ts';

const OPERATOR = 'op-tokens-test';
async function makeServer(dir?: string) {
  const data = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'tug-tokens-')));
  process.env.TUG_DATA_DIR = data;
  process.env.TUG_CONTROL_BACKUP_DIR = path.join(data, 'control-backups');
  process.env.TUG_CONTROL_RESTORE_DIR = path.join(data, 'control-restore');
  process.env.TUG_OPERATOR_TOKEN = OPERATOR;
  process.env.TUG_REGISTRY = 'registry.test';
  const app = await createApp();
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (bearer: string | null, method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  /** Creates a token as the operator and returns its secret. */
  const mint = async (name: string, role: Role, projects?: string[]) => {
    const res = await call(OPERATOR, 'POST', '/api/v1/tokens', { name, role, projects });
    assert.equal(res.status, 200, `creating token ${name} should succeed: ${res.text}`);
    return res.body.token as string;
  };
  return { app, base, data, call, mint, close: () => new Promise((resolve) => srv.close(resolve)) };
}
const compose = (node = 'n1') => ({
  services: { web: { image: 'nginx:alpine', 'x-tug': { placement: { nodes: [node] } } } },
});

test('named tokens are created once, listed without secrets, unique, validated and revocable immediately', async () => {
  const s = await makeServer();
  try {
    const created = await s.call(OPERATOR, 'POST', '/api/v1/tokens', {
      name: 'ci-bot',
      role: 'deploy',
      projects: ['b', 'a', 'a'],
    });
    assert.equal(created.status, 200, 'the operator should be able to create a token');
    assert.match(
      created.body.token,
      /^tug_tok_/,
      'token secrets should carry the recognizable tug_tok_ prefix',
    );
    assert.deepEqual(
      created.body.projects,
      ['a', 'b'],
      'allowed projects should be deduplicated and sorted',
    );
    assert.equal(
      created.body.createdBy,
      'operator',
      'creation should record the acting credential',
    );
    const listed = await s.call(OPERATOR, 'GET', '/api/v1/tokens');
    assert.equal(listed.body.tokens.length, 1, 'the new token should be listed');
    assert.ok(
      !listed.text.includes(created.body.token) && !/token_hash|"token"/.test(listed.text),
      'listings must never contain the secret or its hash',
    );
    assert.equal(
      (await s.call(created.body.token, 'GET', '/api/v1/status')).status,
      200,
      'a fresh token should authenticate',
    );

    const duplicate = await s.call(OPERATOR, 'POST', '/api/v1/tokens', {
      name: 'ci-bot',
      role: 'read',
    });
    assert.equal(duplicate.status, 409, 'token names must be unique');
    for (const [body, pattern] of [
      [{ name: 'bad name', role: 'read' }, /token name/],
      [{ name: '', role: 'read' }, /token name/],
      [{ name: 'operator', role: 'read' }, /reserved/],
      [{ name: 'system:auto-rollback', role: 'read' }, /token name/],
      [{ name: 'x', role: 'root' }, /role must be/],
      [{ name: 'x', role: 'admin', projects: ['a'] }, /cannot be limited/],
      [{ name: 'x', role: 'read', projects: [] }, /projects must be/],
      [{ name: 'x', role: 'read', projects: ['../etc'] }, /projects must be/],
      [{ name: 'x', role: 'read', expiresInSeconds: 0 }, /expiresInSeconds/],
    ] as [unknown, RegExp][]) {
      const res = await s.call(OPERATOR, 'POST', '/api/v1/tokens', body);
      assert.equal(
        res.status,
        400,
        `invalid token request ${JSON.stringify(body)} should be rejected`,
      );
      assert.match(
        res.body.error,
        pattern,
        `rejection of ${JSON.stringify(body)} should explain the problem`,
      );
    }

    assert.equal(
      (await s.call(OPERATOR, 'DELETE', '/api/v1/tokens/ci-bot')).status,
      200,
      'revoking an existing token should succeed',
    );
    assert.equal(
      (await s.call(created.body.token, 'GET', '/api/v1/status')).status,
      401,
      'a revoked token must stop working immediately',
    );
    assert.equal(
      (await s.call(OPERATOR, 'POST', '/api/v1/tokens', { name: 'ci-bot', role: 'read' })).status,
      409,
      'a revoked token keeps its name so the audit trail stays unambiguous',
    );
    assert.equal(
      (await s.call(OPERATOR, 'DELETE', '/api/v1/tokens/missing')).status,
      404,
      'revoking an unknown token should report not found',
    );
    const after = (await s.call(OPERATOR, 'GET', '/api/v1/tokens')).body.tokens[0];
    assert.ok(after.revokedAt, 'listings should show when a token was revoked');
    assert.equal(
      (await s.call('tug_tok_unknown', 'GET', '/api/v1/status')).status,
      401,
      'unknown tokens are unauthorized',
    );
    assert.equal(
      (await s.call(null, 'GET', '/api/v1/status')).status,
      401,
      'missing credentials are unauthorized',
    );
    assert.equal(
      (await s.call(OPERATOR, 'GET', '/api/v1/status')).status,
      200,
      'the root operator token keeps working',
    );
  } finally {
    await s.close();
  }
});

test('expired tokens are rejected and last_used_at is recorded', async () => {
  const s = await makeServer();
  try {
    const res = await s.call(OPERATOR, 'POST', '/api/v1/tokens', {
      name: 'short',
      role: 'read',
      expiresInSeconds: 1,
    });
    assert.ok(res.body.expiresAt, 'a token created with expiry should report it');
    assert.equal(
      (await s.call(res.body.token, 'GET', '/api/v1/status')).status,
      200,
      'a token works before it expires',
    );
    let lastUsed: string | null = null;
    for (let i = 0; i < 20 && !lastUsed; i++) {
      lastUsed = (await s.call(OPERATOR, 'GET', '/api/v1/tokens')).body.tokens[0].lastUsedAt;
      if (!lastUsed) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(lastUsed, 'using a token should record last_used_at without blocking the request');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(
      (await s.call(res.body.token, 'GET', '/api/v1/status')).status,
      401,
      'an expired token must be unauthorized',
    );
  } finally {
    await s.close();
  }
});

/** A concrete, harmless request for each route; the matrix test fails if a route in ROUTE_ROLES has no sample. */
const SAMPLES: Record<string, { path: string; body?: unknown }> = {
  'GET /api/v1/live': { path: '/api/v1/live' },
  'GET /api/v1/status': { path: '/api/v1/status' },
  'GET /api/v1/events': { path: '/api/v1/events' },
  'GET /api/v1/projects/:project': { path: '/api/v1/projects/site' },
  'GET /api/v1/deployments/:id': { path: '/api/v1/deployments/dep_x' },
  'GET /api/v1/volumes': { path: '/api/v1/volumes' },
  'GET /api/v1/secrets': { path: '/api/v1/secrets' },
  'POST /api/v1/projects': { path: '/api/v1/projects', body: { name: 'site' } },
  'POST /api/v1/deployments': {
    path: '/api/v1/deployments',
    body: { project: 'site', compose: { services: {} } },
  },
  'POST /api/v1/deployments/:id/cancel': { path: '/api/v1/deployments/dep_x/cancel', body: {} },
  'POST /api/v1/rollback': { path: '/api/v1/rollback', body: { project: 'site' } },
  'POST /api/v1/scale': {
    path: '/api/v1/scale',
    body: { project: 'site', service: 'web', replicas: 1 },
  },
  'POST /api/v1/restart': { path: '/api/v1/restart', body: { project: 'site' } },
  'POST /api/v1/logs': { path: '/api/v1/logs', body: { project: 'site' } },
  'GET /api/v1/commands/:id': { path: '/api/v1/commands/cmd_x' },
  'POST /api/v1/secrets': { path: '/api/v1/secrets', body: { project: 'site' } },
  'DELETE /api/v1/secrets/:name': { path: '/api/v1/secrets/X' },
  'DELETE /api/v1/volumes/:name': { path: '/api/v1/volumes/x' },
  'DELETE /api/v1/nodes/:name': { path: '/api/v1/nodes/ghost' },
  'GET /api/v1/nodes': { path: '/api/v1/nodes' },
  'POST /api/v1/nodes/register': { path: '/api/v1/nodes/register', body: {} },
  'POST /api/v1/nodes/enroll-token': { path: '/api/v1/nodes/enroll-token', body: {} },
  'POST /api/v1/nodes/:name/rotate-registry-token': {
    path: '/api/v1/nodes/ghost/rotate-registry-token',
    body: {},
  },
  'POST /api/v1/nodes/:name/revoke-registry-token': {
    path: '/api/v1/nodes/ghost/revoke-registry-token',
    body: {},
  },
  'POST /api/v1/nodes/:name/rotate-wg-key': { path: '/api/v1/nodes/ghost/rotate-wg-key', body: {} },
  'POST /api/v1/nodes/:name/ingress': { path: '/api/v1/nodes/ghost/ingress', body: {} },
  'POST /api/v1/control/backups/run': { path: '/api/v1/control/backups/run', body: {} },
  'POST /api/v1/control/restore': { path: '/api/v1/control/restore', body: {} },
  'GET /api/v1/diagnostics': { path: '/api/v1/diagnostics' },
  'POST /api/v1/diagnostics/nodes': { path: '/api/v1/diagnostics/nodes', body: {} },
  'POST /api/v1/tokens': { path: '/api/v1/tokens', body: {} },
  'GET /api/v1/tokens': { path: '/api/v1/tokens' },
  'DELETE /api/v1/tokens/:name': { path: '/api/v1/tokens/ghost' },
};

test('every operator route enforces its declared role for read, deploy and admin tokens', async () => {
  const s = await makeServer();
  try {
    const tokens: Record<Role, string> = {
      read: await s.mint('r', 'read'),
      deploy: await s.mint('d', 'deploy'),
      admin: await s.mint('a', 'admin'),
    };
    for (const [key, required] of Object.entries(ROUTE_ROLES)) {
      if (required === 'public') continue;
      const sample = SAMPLES[key];
      assert.ok(sample, `${key} needs a request in SAMPLES so its role is exercised`);
      const method = key.split(' ')[0];
      for (const role of ROLES) {
        const res = await s.call(tokens[role], method, sample.path, sample.body);
        if (hasRole({ name: 'x', role, projects: null }, required))
          assert.ok(
            ![401, 403].includes(res.status),
            `${role} token should be allowed on ${key} (needs ${required}) but got ${res.status}: ${res.text}`,
          );
        else {
          assert.equal(
            res.status,
            403,
            `${role} token should get 403 on ${key} (needs ${required}); got ${res.status}`,
          );
          assert.match(
            res.body.error,
            new RegExp(`requires the ${required} role`),
            `403 on ${key} should say which role is required`,
          );
        }
      }
      assert.equal(
        (await s.call('tug_tok_wrong', method, sample.path, sample.body)).status,
        401,
        `${key} should reject unknown tokens with 401`,
      );
      assert.equal(
        (await s.call(null, method, sample.path, sample.body)).status,
        401,
        `${key} should reject missing credentials with 401`,
      );
    }
    assert.deepEqual(
      Object.keys(SAMPLES).sort(),
      Object.keys(ROUTE_ROLES)
        .filter((k) => ROUTE_ROLES[k] !== 'public')
        .sort(),
      'SAMPLES should cover exactly the classified routes',
    );
  } finally {
    await s.close();
  }
});

test('the registry auth hook and agent endpoints ignore API tokens', async () => {
  const s = await makeServer();
  try {
    const admin = await s.mint('a', 'admin');
    assert.equal(
      (await s.call(admin, 'GET', '/agent/v1/work')).status,
      401,
      'agent endpoints accept agent tokens only, even admin API tokens are refused',
    );
    assert.equal(
      (await s.call(OPERATOR, 'GET', '/agent/v1/secrets?project=site')).status,
      401,
      'the operator token cannot read the agent secrets endpoint',
    );
    assert.equal(
      (await s.call(null, 'POST', '/api/v1/registry/auth', { username: 'n', password: 'p' }))
        .status,
      401,
      'the registry hook still rejects invalid node credentials without bearer auth',
    );
    assert.equal(
      (await s.call(null, 'GET', '/healthz')).status,
      200,
      'health checks stay unauthenticated',
    );
  } finally {
    await s.close();
  }
});

test('the route table matches the live router, so a new /api/v1 route without a declared role fails here', async () => {
  const s = await makeServer();
  try {
    interface Layer {
      route?: { path: string; methods: Record<string, boolean> };
    }
    const stack = (s.app as unknown as { _router: { stack: Layer[] } })._router.stack;
    const live = stack
      .flatMap((layer) =>
        layer.route && layer.route.path.startsWith('/api/v1')
          ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`)
          : [],
      )
      .sort();
    assert.deepEqual(
      live,
      Object.keys(ROUTE_ROLES).sort(),
      'every live /api/v1 route must be declared in ROUTE_ROLES and every declared route must exist',
    );
    const guarded = [...(s.app.locals.apiRoutes as Map<string, string>).keys()].sort();
    assert.deepEqual(
      guarded,
      Object.keys(ROUTE_ROLES)
        .filter((k) => ROUTE_ROLES[k] !== 'public')
        .sort(),
      'every non-public route must be registered through the role guard rather than raw handlers',
    );
    const docs = await fs.readFile(path.resolve('docs/access-control.md'), 'utf8');
    for (const key of Object.keys(ROUTE_ROLES))
      assert.ok(docs.includes(`\`${key}\``), `docs/access-control.md should list ${key}`);
  } finally {
    await s.close();
  }
});

test('project-scoped tokens only reach their own projects and learn nothing about others', async () => {
  const s = await makeServer();
  try {
    await s.call(OPERATOR, 'POST', '/api/v1/nodes/register', { name: 'n1' });
    const ci = await s.mint('ci-a', 'deploy', ['a']);
    const viewer = await s.mint('view-a', 'read', ['a']);
    const unscoped = await s.mint('all', 'deploy');
    const deployA = await s.call(ci, 'POST', '/api/v1/deployments', {
      project: 'a',
      version: 'v1',
      compose: compose(),
    });
    assert.equal(deployA.status, 200, `scoped token deploys its own project: ${deployA.text}`);
    const deployB = await s.call(unscoped, 'POST', '/api/v1/deployments', {
      project: 'b',
      version: 'v1',
      compose: compose(),
    });
    assert.equal(deployB.status, 200, 'unscoped deploy token deploys any project');
    await s.call(OPERATOR, 'POST', '/api/v1/secrets', {
      project: 'b',
      name: 'KEY',
      value: 'hunter2',
    });

    const denied = await s.call(ci, 'POST', '/api/v1/deployments', {
      project: 'b',
      version: 'v2',
      compose: compose(),
    });
    const unknown = await s.call(ci, 'POST', '/api/v1/deployments', {
      project: 'never-created',
      version: 'v2',
      compose: compose(),
    });
    assert.equal(denied.status, 403, 'deploying another project is forbidden');
    assert.deepEqual(
      denied.body,
      unknown.body,
      'the 403 must not reveal whether the other project exists',
    );
    for (const [method, route, body] of [
      ['POST', '/api/v1/rollback', { project: 'b' }],
      ['POST', '/api/v1/restart', { project: 'b', service: 'web' }],
      ['POST', '/api/v1/logs', { project: 'b', service: 'web' }],
      ['GET', '/api/v1/projects/b'],
      ['GET', '/api/v1/events?project=b'],
      ['GET', '/api/v1/volumes?project=b'],
      ['GET', `/api/v1/deployments/${deployB.body.deployment.id}`],
      ['POST', `/api/v1/deployments/${deployB.body.deployment.id}/cancel`, {}],
      ['GET', '/api/v1/deployments/dep_does_not_exist'],
      ['GET', '/api/v1/commands/cmd_does_not_exist'],
    ] as [string, string, unknown?][]) {
      const token = method === 'GET' && !route.includes('/commands/') ? viewer : ci;
      const res = await s.call(token, method, route, body);
      assert.equal(
        res.status,
        403,
        `${method} ${route} must be forbidden for a token scoped to project a; got ${res.status}`,
      );
      assert.equal(
        res.body.error,
        denied.body.error,
        `${method} ${route} should return the same message whether or not the target exists`,
      );
    }
    assert.equal(
      (await s.call(viewer, 'GET', '/api/v1/secrets?project=b')).status,
      403,
      'secret names of other projects are hidden from scoped tokens',
    );
    assert.equal(
      (await s.call(ci, 'POST', '/api/v1/projects', { name: 'b' })).status,
      403,
      'a scoped token cannot create a project outside its scope',
    );

    const status = (await s.call(viewer, 'GET', '/api/v1/status')).body;
    assert.deepEqual(
      status.projects.map((p: { id: string }) => p.id),
      ['a'],
      'status lists only the allowed projects',
    );
    assert.ok(
      status.deployments.every((d: { project_id: string }) => d.project_id === 'a'),
      'status deployments are limited to the allowed projects',
    );
    const events = (await s.call(viewer, 'GET', '/api/v1/events')).body.events;
    assert.ok(
      events.length > 0 && events.every((e: { project_id: string }) => e.project_id === 'a'),
      'unfiltered events are limited to the allowed projects',
    );
    assert.equal(
      (await s.call(viewer, 'GET', '/api/v1/projects/a')).status,
      200,
      'the allowed project is readable',
    );
    assert.equal(
      (await s.call(ci, 'POST', '/api/v1/rollback', { project: 'a', force: true })).status,
      404,
      'allowed project reaches the handler (no previous deployment yet)',
    );
    const operatorEvents = (await s.call(OPERATOR, 'GET', '/api/v1/events')).body.events;
    assert.ok(
      operatorEvents.some((e: { project_id: string }) => e.project_id === 'b'),
      'the operator still sees every project',
    );
  } finally {
    await s.close();
  }
});

test('deploy tokens cannot manage secrets, nodes, backups, diagnostics or tokens, and no endpoint returns secret values', async () => {
  const s = await makeServer();
  try {
    await s.call(OPERATOR, 'POST', '/api/v1/secrets', {
      project: 'site',
      name: 'DB_PASSWORD',
      value: 'hunter2',
    });
    const deploy = await s.mint('d', 'deploy');
    const read = await s.mint('r', 'read');
    for (const [method, route, body] of [
      ['POST', '/api/v1/secrets', { name: 'X', value: 'y' }],
      ['DELETE', '/api/v1/secrets/DB_PASSWORD'],
      ['GET', '/api/v1/nodes'],
      ['POST', '/api/v1/nodes/register', { name: 'evil' }],
      ['POST', '/api/v1/nodes/enroll-token', {}],
      ['POST', '/api/v1/control/backups/run', {}],
      ['POST', '/api/v1/control/restore', { artifactRef: '/x', confirm: true }],
      ['GET', '/api/v1/diagnostics'],
      ['POST', '/api/v1/diagnostics/nodes', {}],
      ['GET', '/api/v1/tokens'],
      ['POST', '/api/v1/tokens', { name: 'esc', role: 'admin' }],
      ['DELETE', '/api/v1/tokens/d'],
      ['DELETE', '/api/v1/volumes/x'],
    ] as [string, string, unknown?][])
      assert.equal(
        (await s.call(deploy, method, route, body)).status,
        403,
        `deploy token must not ${method} ${route}`,
      );
    assert.equal(
      (await s.call(OPERATOR, 'GET', '/api/v1/secrets')).body.secrets[0].name,
      'DB_PASSWORD',
      'the secret from the operator is still intact',
    );
    for (const token of [deploy, read]) {
      const listing = await s.call(token, 'GET', '/api/v1/secrets');
      assert.equal(listing.status, 200, 'listing secret names is allowed for read and deploy');
      assert.ok(
        !listing.text.includes('hunter2') && !/encrypted_value|"value"/.test(listing.text),
        'secret listings never contain values',
      );
    }
  } finally {
    await s.close();
  }
});

test('mutations record the acting token on deployments and events', async () => {
  const s = await makeServer();
  try {
    const registered = (await s.call(OPERATOR, 'POST', '/api/v1/nodes/register', { name: 'n1' }))
      .body;
    const ci = await s.mint('ci-bot', 'deploy');
    const first = (
      await s.call(ci, 'POST', '/api/v1/deployments', {
        project: 'site',
        version: 'v1',
        compose: compose(),
      })
    ).body;
    assert.equal(first.deployment.actor, 'ci-bot', 'the deploy response should name the token');
    assert.equal(
      (await s.call(ci, 'GET', `/api/v1/deployments/${first.deployment.id}`)).body.actor,
      'ci-bot',
      'the deployment record should store the acting token',
    );
    await s.call(registered.agentToken, 'POST', '/agent/v1/status', {
      projects: [
        {
          project: 'site',
          observedVersion: 'v1',
          observedRevision: first.desiredState.revision,
          health: 'serving',
          services: {},
        },
      ],
    });
    const second = (
      await s.call(OPERATOR, 'POST', '/api/v1/deployments', {
        project: 'site',
        version: 'v2',
        compose: compose(),
      })
    ).body;
    assert.equal(second.deployment.actor, 'operator', 'the root token is recorded as operator');
    const rollback = (
      await s.call(ci, 'POST', '/api/v1/rollback', { project: 'site', force: true })
    ).body;
    assert.equal(
      rollback.deployment.actor,
      'ci-bot',
      'rollback deployments record who rolled back',
    );
    const cancel = await s.call(
      ci,
      'POST',
      `/api/v1/deployments/${rollback.deployment.id}/cancel`,
      {},
    );
    assert.equal(cancel.status, 200, `cancel should work for a deploy token: ${cancel.text}`);
    assert.equal(
      (await s.call(ci, 'POST', '/api/v1/restart', { project: 'site', service: 'web' })).status,
      200,
      'restart is allowed for deploy tokens',
    );
    await s.call(OPERATOR, 'POST', '/api/v1/secrets', {
      project: 'site',
      name: 'API_KEY',
      value: 'super-secret-value',
    });
    await s.call(OPERATOR, 'DELETE', '/api/v1/secrets/API_KEY?project=site');
    await s.call(OPERATOR, 'DELETE', '/api/v1/tokens/ci-bot');

    const events = (await s.call(OPERATOR, 'GET', '/api/v1/events?limit=100')).body.events as {
      type: string;
      actor: string | null;
      message: string;
      project_id: string | null;
      deployment_id: string | null;
      metadata_json: string;
    }[];
    const find = (type: string, actor: string) =>
      events.find((e) => e.type === type && e.actor === actor);
    assert.ok(
      find('deploy', 'ci-bot')?.deployment_id === first.deployment.id,
      'deploy event names the token and deployment',
    );
    assert.ok(
      find('deploy', 'operator'),
      'deploy event by the root token is attributed to operator',
    );
    assert.ok(find('rollback', 'ci-bot'), 'rollback event names the token');
    assert.ok(find('cancel', 'ci-bot'), 'cancel event names the token');
    assert.ok(find('restart', 'ci-bot'), 'restart event names the token');
    assert.ok(
      find('secret.set', 'operator') && find('secret.delete', 'operator'),
      'secret changes are attributed',
    );
    assert.ok(
      find('token.create', 'operator') && find('token.revoke', 'operator'),
      'token creation and revocation are attributed',
    );
    assert.ok(
      !JSON.stringify(events).includes('super-secret-value') &&
        !JSON.stringify(events).includes('tug_tok_'),
      'audit events never contain secret values or token secrets',
    );
  } finally {
    await s.close();
  }
});

test('control backup and restore keep tokens working', async () => {
  const s = await makeServer();
  const kept = await s.mint('kept', 'deploy');
  const revoked = await s.mint('soon-revoked', 'read');
  const backup = (await s.call(OPERATOR, 'POST', '/api/v1/control/backups/run', {})).body;
  const later = await s.mint('later', 'read');
  await s.call(OPERATOR, 'DELETE', '/api/v1/tokens/soon-revoked');
  const restored = await s.call(OPERATOR, 'POST', '/api/v1/control/restore', {
    artifactRef: backup.artifactRef,
    confirm: true,
  });
  assert.equal(
    restored.status,
    200,
    `restore should succeed with the api_tokens table present: ${restored.text}`,
  );
  assert.equal(restored.body.restartRequired, true, 'restore still requires a restart');
  assert.equal(
    (await s.call(kept, 'GET', '/api/v1/status')).status,
    503,
    'the restored process refuses work until restarted',
  );
  await s.close();
  const again = await makeServer(s.data);
  try {
    assert.equal(
      (await again.call(kept, 'GET', '/api/v1/status')).status,
      200,
      'a token present in the backup works after restore and restart',
    );
    assert.equal(
      (await again.call(kept, 'POST', '/api/v1/tokens', { name: 'x', role: 'read' })).status,
      403,
      'restored tokens keep their role',
    );
    assert.equal(
      (await again.call(later, 'GET', '/api/v1/status')).status,
      401,
      'a token created after the backup is gone, as the restore replaces control state',
    );
    assert.equal(
      (await again.call(revoked, 'GET', '/api/v1/status')).status,
      200,
      'the backup predates that revocation, so the token is valid again as of the snapshot',
    );
    assert.equal(
      (await again.call(OPERATOR, 'GET', '/api/v1/tokens')).body.tokens
        .map((t: { name: string }) => t.name)
        .sort()
        .join(),
      'kept,soon-revoked',
      'only the tokens from the backup remain',
    );
  } finally {
    await again.close();
  }
});
