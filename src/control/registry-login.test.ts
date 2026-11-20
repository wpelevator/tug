import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { json, testControlUrl, testIdentity } from '../../tests/helpers.ts';
import { resolveImage } from '../images/registry.ts';
import type { RegistryCredentials } from '../images/registry.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-registry-login-'));
  process.env.TUG_DATA_DIR = dir;
  const seen: (RegistryCredentials | undefined)[] = [];
  const app = await createApp({
    identity: testIdentity,
    controlUrl: testControlUrl,
    images: {
      resolve: (image, credentials) => {
        seen.push(credentials);
        return resolveImage(image, credentials, async () =>
          Response.json({ schemaVersion: 2, config: { digest: '1' }, layers: [] }),
        );
      },
    },
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const deploy = (version: string, image: string) =>
    post('/api/v1/deployments', {
      project: 'site',
      version,
      compose: { services: { app: { image } } },
    });
  return {
    post,
    deploy,
    seen,
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('registry login adds a host to TUG_REGISTRY_AUTH, keeps the others, and replaces the same host', async () => {
  const s = await server();
  try {
    const first = await json(
      await s.post('/api/v1/registry/login', {
        project: 'site',
        host: 'ghcr.io',
        username: 'octo',
        password: 'token-one',
      }),
    );
    assert.deepEqual(first.hosts, ['ghcr.io'], 'the first login stores one host');
    const second = await json(
      await s.post('/api/v1/registry/login', {
        project: 'site',
        host: 'registry.example.com',
        username: 'ci',
        password: 'token-two',
      }),
    );
    assert.deepEqual(
      second.hosts,
      ['ghcr.io', 'registry.example.com'],
      'a second host is added beside the first, not instead of it',
    );
    assert.equal(second.version, 2, 'each login is a new version of the secret');
    const replaced = await json(
      await s.post('/api/v1/registry/login', {
        project: 'site',
        host: 'ghcr.io',
        username: 'octo',
        password: 'token-three',
      }),
    );
    assert.deepEqual(replaced.hosts, ['ghcr.io', 'registry.example.com'], 'a repeat replaces');
    assert.ok(
      !JSON.stringify([first, second, replaced]).includes('token-'),
      'the responses never contain a token',
    );
    assert.equal(
      (await s.deploy('v1', 'ghcr.io/acme/app:v1')).status,
      200,
      'the stored credentials let the deployment resolve its image',
    );
    assert.deepEqual(
      s.seen.at(-1),
      {
        'ghcr.io': { username: 'octo', password: 'token-three' },
        'registry.example.com': { username: 'ci', password: 'token-two' },
      },
      'control resolves with the replaced entry and the untouched one',
    );
  } finally {
    await s.close();
  }
});

test('registry login rejects a bad host, a missing token, and a corrupt existing secret', async () => {
  const s = await server();
  try {
    const login = (body: object) =>
      s.post('/api/v1/registry/login', { project: 'site', username: 'u', password: 'p', ...body });
    assert.equal((await login({ host: 'not a host' })).status, 400, 'a malformed host is refused');
    assert.equal((await login({ host: 'ghcr.io', password: '' })).status, 400, 'a token is needed');
    assert.equal((await login({ host: 'ghcr.io', username: '' })).status, 400, 'a user is needed');
    assert.equal(
      (await login({ host: 'ghcr.io', project: '_control' })).status,
      400,
      'reserved projects are refused',
    );
    await s.post('/api/v1/secrets', {
      project: 'site',
      name: 'TUG_REGISTRY_AUTH',
      value: 'not json',
    });
    const corrupt = await login({ host: 'ghcr.io' });
    assert.equal(corrupt.status, 409, 'a secret that is not registry JSON is not overwritten');
    assert.match(
      (await json(corrupt)).error,
      /tug secret set TUG_REGISTRY_AUTH/,
      'the error names the way to replace it',
    );
  } finally {
    await s.close();
  }
});
