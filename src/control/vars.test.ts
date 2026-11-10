import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testControlUrl, testIdentity, testImageResolver } from '../../tests/helpers.ts';

async function server() {
  process.env.TUG_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-vars-'));
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: { resolve: testImageResolver },
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const operator: Record<string, string> = {
    'x-tug-test-operator': 'operator',
    'content-type': 'application/json',
  };
  const call = (method: string, route: string, body?: unknown) =>
    fetch(`${base}${route}`, {
      method,
      headers: operator,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const reg = await json(await call('POST', '/api/v1/nodes/register', { name: 'n1' }));
  const node = { 'x-tug-test-node': reg.nodeId, 'content-type': 'application/json' };
  const compose = (service: Record<string, unknown> = {}) => ({
    services: {
      web: { image: 'nginx', 'x-tug': { placement: { nodes: ['n1'] } }, ...service },
    },
  });
  return {
    call,
    compose,
    setVar: (name: string, value: string, project = 'site') =>
      call('POST', '/api/v1/vars', { project, name, value }),
    setSecret: (name: string, value: string, project = 'site') =>
      call('POST', '/api/v1/secrets', { project, name, value }),
    deploy: (version: string, composeFile: unknown, values?: unknown) =>
      call('POST', '/api/v1/deployments', {
        project: 'site',
        version,
        compose: composeFile,
        values,
      }),
    serve: (version: string, revision: string) =>
      fetch(`${base}/agent/v1/status`, {
        method: 'POST',
        headers: node,
        body: JSON.stringify({
          projects: [
            {
              project: 'site',
              observedVersion: version,
              observedRevision: revision,
              health: 'serving',
            },
          ],
        }),
      }),
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

test('variables are set, versioned, listed without values and read with values', async () => {
  const s = await server();
  try {
    assert.deepEqual(
      await json(await s.setVar('TAG', 'v1')),
      { ok: true, name: 'TAG', version: 1 },
      'a new variable starts at version 1',
    );
    assert.equal(
      (await json(await s.setVar('TAG', 'v2'))).version,
      2,
      'setting it again bumps the version',
    );
    const listed = await json(await s.call('GET', '/api/v1/vars?project=site'));
    assert.deepEqual(
      listed.vars.map((v: Record<string, unknown>) => [v.name, v.version, 'value' in v]),
      [['TAG', 2, false]],
      'the plain listing shows names and versions and never a value',
    );
    const values = await json(await s.call('GET', '/api/v1/vars/values?project=site'));
    assert.equal(values.vars[0].value, 'v2', 'the values route returns the current value');
    const events = await json(await s.call('GET', '/api/v1/events?project=site'));
    const setEvent = events.events.find((e: { type: string }) => e.type === 'var.set');
    assert.ok(setEvent, 'setting a variable is audited');
    assert.ok(!JSON.stringify(setEvent).includes('v2'), 'the audit entry does not carry the value');
    assert.equal((await s.call('DELETE', '/api/v1/vars/TAG?project=site')).status, 200);
    assert.deepEqual(
      (await json(await s.call('GET', '/api/v1/vars?project=site'))).vars,
      [],
      'a removed variable is gone',
    );
  } finally {
    await s.close();
  }
});

test('a name is either a secret or a variable in a project, never both', async () => {
  const s = await server();
  try {
    await s.setSecret('DB_PASSWORD', 'x');
    const asVar = await s.setVar('DB_PASSWORD', 'y');
    assert.equal(asVar.status, 409, 'a variable cannot take the name of a secret');
    assert.match(
      (await json(asVar)).error,
      /secret.*tug secret remove DB_PASSWORD/,
      'the error names the command that frees the name',
    );
    await s.setVar('REGION', 'eu');
    const asSecret = await s.setSecret('REGION', 'z');
    assert.equal(asSecret.status, 409, 'a secret cannot take the name of a variable');
    assert.match(
      (await json(asSecret)).error,
      /tug var remove REGION/,
      'the error names the remedy',
    );
    assert.equal(
      (await s.setVar('DB_PASSWORD', 'y', 'other')).status,
      200,
      'the same name in another project is independent',
    );
  } finally {
    await s.close();
  }
});

test('variable names and sizes are validated', async () => {
  const s = await server();
  try {
    assert.equal(
      (await s.setVar('1BAD', 'x')).status,
      400,
      'a name must be a Compose variable name',
    );
    assert.equal(
      (await s.setVar('TUG_REGISTRY_AUTH', 'x')).status,
      400,
      'the reserved registry secret name cannot be a variable',
    );
    const large = await s.setVar('BIG', 'x'.repeat(70 * 1024));
    assert.equal(large.status, 400, 'a variable is configuration-sized');
    assert.match(
      (await json(large)).error,
      /tug secret set/,
      'the error points large values at secrets',
    );
    assert.equal(
      (await s.setVar('_reserved', 'x', '_internal')).status,
      400,
      'reserved projects are refused',
    );
  } finally {
    await s.close();
  }
});

test('a deployment records where each value came from, with variable and --var values and no secret values', async () => {
  const s = await server();
  try {
    await s.setSecret('DB_PASSWORD', 'hunter2');
    await s.setVar('REGION', 'eu');
    const res = await s.deploy('v1', s.compose({ environment: { REGION: 'eu' } }), [
      { name: 'DB_PASSWORD', source: 'secret' },
      { name: 'REGION', source: 'var', version: 1, value: 'client-supplied-is-ignored' },
      { name: 'TAG', source: '--var', value: 'abc' },
      { name: 'MODE', source: 'default' },
    ]);
    assert.equal(res.status, 200, 'a deployment with a consistent value record is accepted');
    const created = await json(res);
    assert.deepEqual(
      created.deployment.values,
      [
        { name: 'DB_PASSWORD', source: 'secret', version: 1 },
        { name: 'REGION', source: 'var', version: 1, value: 'eu' },
        { name: 'TAG', source: '--var', value: 'abc' },
        { name: 'MODE', source: 'default' },
      ],
      'control fills versions and variable values from its own rows and keeps no secret value',
    );
    const read = await json(await s.call('GET', `/api/v1/deployments/${created.deployment.id}`));
    assert.deepEqual(
      read.values,
      created.deployment.values,
      'the record is readable on the deployment',
    );
    assert.ok(!('values_json' in read), 'the stored column is not exposed');
    assert.ok(!JSON.stringify(read).includes('hunter2'), 'no secret value appears in the record');
  } finally {
    await s.close();
  }
});

test('a deployment is refused when a variable changed while it was prepared, or a --var shadows a secret', async () => {
  const s = await server();
  try {
    await s.setVar('TAG', 'a');
    await s.setVar('TAG', 'b');
    const stale = await s.deploy('v1', s.compose(), [{ name: 'TAG', source: 'var', version: 1 }]);
    assert.equal(
      stale.status,
      409,
      'a variable interpolated at version 1 cannot deploy once it is version 2',
    );
    assert.match(
      (await json(stale)).error,
      /changed while the deployment was being prepared.*run tug deploy again/,
    );
    const removed = await s.deploy('v1', s.compose(), [
      { name: 'GONE', source: 'var', version: 1 },
    ]);
    assert.equal(removed.status, 409, 'a variable that was removed in between is refused');
    await s.setSecret('DB_PASSWORD', 'x');
    const shadow = await s.deploy('v1', s.compose(), [
      { name: 'DB_PASSWORD', source: '--var', value: 'override' },
    ]);
    assert.equal(shadow.status, 400, 'a --var never replaces a secret');
    assert.match((await json(shadow)).error, /conflicts with the project secret DB_PASSWORD/);
    assert.equal(
      (await s.deploy('v1', s.compose(), [{ name: 'X', source: 'cli' }])).status,
      400,
      'an unknown source is refused',
    );
    assert.equal(
      (await s.deploy('v1', s.compose(), 'not-a-list')).status,
      400,
      'a value record must be a list',
    );
    assert.equal(
      (await s.deploy('v1', s.compose())).status,
      200,
      'a client that sends no value record still deploys, with an empty one',
    );
  } finally {
    await s.close();
  }
});

test('a secret is accepted only where the agent substitutes it, and the error suggests a variable', async () => {
  const s = await server();
  try {
    await s.setSecret('TOKEN', 't');
    const sentinel = '@@tug:secret:TOKEN@@';
    const allowed = await s.deploy(
      'v1',
      s.compose({
        environment: { TOKEN: sentinel },
        command: ['serve', sentinel],
        healthcheck: { test: ['CMD', 'check', sentinel] },
      }),
    );
    assert.equal(
      allowed.status,
      200,
      'environment, command and the health-check test take a secret',
    );
    for (const [field, service] of [
      ['image', { image: `nginx:${sentinel}` }],
      ['ports', { ports: [`${sentinel}:80`] }],
      ['labels', { labels: { token: sentinel } }],
    ] as const) {
      const rejected = await s.deploy('v2', s.compose(service));
      assert.equal(rejected.status, 400, `a secret in ${field} is refused`);
      const { error } = await json(rejected);
      assert.match(
        error,
        new RegExp(`services\\.web\\.${field}`),
        `the error names the ${field} field`,
      );
      assert.match(error, /tug var set/, 'the error points at variables');
    }
  } finally {
    await s.close();
  }
});

test('a rollback restores the variable values and the record of the deployment it returns to', async () => {
  const s = await server();
  try {
    await s.setVar('TAG', 'a');
    const first = await json(
      await s.deploy('v1', s.compose({ image: 'nginx:a' }), [
        { name: 'TAG', source: 'var', version: 1 },
      ]),
    );
    await s.serve('v1', first.desiredState.revision);
    await s.setVar('TAG', 'b');
    assert.equal(
      (
        await s.deploy('v2', s.compose({ image: 'nginx:b' }), [
          { name: 'TAG', source: 'var', version: 2 },
        ])
      ).status,
      200,
    );
    const rolled = await json(
      await s.call('POST', '/api/v1/rollback', { project: 'site', force: true }),
    );
    assert.equal(
      rolled.desiredState.services.web.image,
      'nginx:a',
      'the rollback restores the image tag the variable had at v1',
    );
    assert.deepEqual(
      rolled.deployment.values,
      [{ name: 'TAG', source: 'var', version: 1, value: 'a' }],
      'the rollback carries the value record of the deployment it restores, not the current variable',
    );
  } finally {
    await s.close();
  }
});
