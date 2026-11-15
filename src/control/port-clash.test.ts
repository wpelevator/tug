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
  process.env.TUG_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-port-clash-'));
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
  const call = (method: string, route: string, body?: unknown, headers = operator) =>
    fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let n1: Record<string, string> = {};
  for (const name of ['n1', 'n2']) {
    const reg = await json(await call('POST', '/api/v1/nodes/register', { name }));
    if (name === 'n1') n1 = { 'x-tug-test-node': reg.nodeId, 'content-type': 'application/json' };
    await call('POST', `/api/v1/nodes/${name}/address`, {
      address: name === 'n1' ? '10.50.0.4' : '10.50.0.5',
    });
  }
  let versions = 0;
  const compose = (ports: unknown[], node = 'n1', extra: Record<string, unknown> = {}) => ({
    services: {
      web: { image: 'nginx', ports, 'x-tug': { placement: { nodes: [node] }, ...extra } },
    },
  });
  return {
    deploy: (project: string, ports: unknown[], node = 'n1', extra = {}, headers = operator) =>
      call(
        'POST',
        '/api/v1/deployments',
        { project, version: `v${++versions}`, compose: compose(ports, node, extra) },
        headers,
      ),
    /** The node reports the deployment serving, so a later deploy of the project is not refused as still rolling out. */
    serve: async (response: Response) => {
      const { deployment, desiredState } = await json(response);
      return call(
        'POST',
        '/agent/v1/status',
        {
          projects: [
            {
              project: desiredState.project,
              observedVersion: deployment.version,
              observedRevision: desiredState.revision,
              health: 'serving',
            },
          ],
        },
        n1,
      );
    },
    check: (project: string, ports: unknown[], node = 'n1') =>
      call('POST', '/api/v1/deployments/check', { project, compose: compose(ports, node) }),
    scoped: async (project: string) => {
      const response = await call('POST', '/api/v1/credentials', {
        name: `ci-${project}`,
        role: 'deploy',
        projects: [project],
      });
      return {
        'x-tug-test-credential': (await json(response)).credential as string,
        'content-type': 'application/json',
      };
    },
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

test('deploy refuses a host port another project publishes on the same node, before anything is built', async () => {
  const s = await server();
  try {
    const first = await s.deploy('phpdb', ['8080:80']);
    assert.equal(first.status, 200, 'the first project deploys');
    await s.serve(first);
    const clash = await s.deploy('laravel', ['8080:80']);
    assert.equal(clash.status, 409, 'the second project is refused');
    assert.match(
      (await json(clash)).error,
      /web: host port 8080 on node n1 \(10\.50\.0\.4\) is already published by web in project phpdb/,
      'the refusal names the other project, the node, the address and the port',
    );
    const again = await s.deploy('phpdb', ['8080:80']);
    assert.equal(
      again.status,
      200,
      `the owning project can redeploy its own port: ${JSON.stringify(await again.clone().json())}`,
    );
    assert.equal(
      (await s.deploy('laravel', ['8080:80'], 'n2')).status,
      200,
      'the same port on another node is free',
    );
    assert.equal(
      (await s.deploy('loopback', ['127.0.0.1:8080:80'])).status,
      200,
      'a loopback bind does not clash with the private address of the node',
    );
  } finally {
    await s.close();
  }
});

test('deploy --dry-run asks control, which reports the same clash and passes a free port', async () => {
  const s = await server();
  try {
    await s.deploy('phpdb', ['8080:80']);
    const clash = await s.check('laravel', ['8080:80']);
    assert.equal(clash.status, 409, 'the check refuses a clashing port');
    assert.match((await json(clash)).error, /project phpdb/, 'the check names the other project');
    assert.equal((await s.check('laravel', ['8081:80'])).status, 200, 'a free port passes');
    assert.equal(
      (await s.check('phpdb', ['8080:80'])).status,
      200,
      'the project that holds the port passes its own check',
    );
  } finally {
    await s.close();
  }
});

test('a rolling service does not claim its declared host port', async () => {
  const s = await server();
  try {
    await s.deploy('phpdb', ['8080:80']);
    const rolling = await s.deploy('rolly', ['8080:80'], 'n1', {
      rollout: { strategy: 'rolling' },
      ingress: { host: 'r.example.com', port: 80 },
      health: { type: 'http', path: '/' },
    });
    assert.equal(
      rolling.status,
      200,
      `a rolling revision takes a port from its own range: ${JSON.stringify(await rolling.clone().json())}`,
    );
  } finally {
    await s.close();
  }
});

test('a credential scoped to one project is not told the name of the other project holding the port', async () => {
  const s = await server();
  try {
    await s.deploy('phpdb', ['8080:80']);
    const ci = await s.scoped('laravel');
    const clash = await s.deploy('laravel', ['8080:80'], 'n1', {}, ci);
    assert.equal(clash.status, 409, 'the scoped deploy is refused');
    const error = (await json(clash)).error as string;
    assert.match(error, /already published by another project/, 'the refusal stays generic');
    assert.doesNotMatch(error, /phpdb/, 'the other project name is not leaked');
  } finally {
    await s.close();
  }
});
