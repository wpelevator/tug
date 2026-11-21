import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './control.ts';
import { testControlUrl, testIdentity } from '../../tests/helpers.ts';

async function server() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-build-secrets-'));
  process.env.TUG_DATA_DIR = dir;
  const app = await createApp({ identity: testIdentity, controlUrl: testControlUrl });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'x-tug-test-operator': 'operator', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  await post('/api/v1/nodes/register', { name: 'n1' });
  const deploy = async (compose: unknown) => {
    const res = await post('/api/v1/deployments', { project: 'site', version: 'v1', compose });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  return {
    post,
    deploy,
    close: async () => {
      await new Promise((resolve) => srv.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const withDeclaration = (declaration: unknown, entries: unknown[] = ['token']) => ({
  services: { web: { build: { context: '.', secrets: entries } } },
  secrets: { token: declaration },
});

test('control refuses a raw submission that the CLI would have refused', async () => {
  const s = await server();
  try {
    const cases: [string, unknown, RegExp][] = [
      [
        'an undeclared reference',
        { services: { web: { build: { context: '.', secrets: ['nope'] } } } },
        /build\.secrets refers to nope, which is not declared under secrets/,
      ],
      [
        'content:',
        withDeclaration({ content: 'inline' }),
        /secrets\.token: content is not supported/,
      ],
      [
        'an unknown declaration field',
        withDeclaration({ labels: ['a'] }),
        /secrets\.token: labels is not supported/,
      ],
      [
        'a templated name',
        withDeclaration({ external: true, name: '${NAME}' }),
        /secrets\.token: name must not use a variable reference/,
      ],
      [
        'a mapping to the registry credential',
        withDeclaration({ 'x-tug': { secret: 'TUG_REGISTRY_AUTH' } }),
        /secrets\.token: maps to TUG_REGISTRY_AUTH/,
      ],
      [
        'a service-level secrets:',
        { services: { web: { image: 'nginx', secrets: ['token'] } }, secrets: { token: {} } },
        /web: secrets \(file mounts under \/run\/secrets\) are not built yet/,
      ],
    ];
    for (const [label, compose, expected] of cases) {
      const res = await s.deploy(compose);
      assert.equal(res.status, 400, `${label} is a bad request`);
      assert.match(res.body.error ?? '', expected, `${label} is named in the error`);
    }
  } finally {
    await s.close();
  }
});

test('control maps a declaration to a tug secret, refuses a variable of that name, and names a missing one', async () => {
  const s = await server();
  try {
    const compose = withDeclaration({ environment: 'NPM_TOKEN' });
    const missing = await s.deploy(compose);
    assert.equal(missing.status, 400, 'a missing mapped secret fails the deploy');
    assert.match(
      missing.body.error ?? '',
      /secrets not found in project site: NPM_TOKEN/,
      'the error names the tug secret the declaration maps to, not the declaration key',
    );
    await s.post('/api/v1/vars', { project: 'site', name: 'NPM_TOKEN', value: 'visible' });
    const variable = await s.deploy(compose);
    assert.equal(variable.status, 400, 'a variable does not satisfy a Compose secret');
    assert.match(
      variable.body.error ?? '',
      /token → secret NPM_TOKEN: NPM_TOKEN is a variable.*tug var remove NPM_TOKEN.*tug secret set NPM_TOKEN/s,
      'the error says to use tug secret set',
    );
  } finally {
    await s.close();
  }
});

test('control accepts a declaration it resolved to a secret that exists', async () => {
  const s = await server();
  try {
    await s.post('/api/v1/secrets', { project: 'site', name: 'NPM_TOKEN', value: 'x' });
    const res = await s.deploy(withDeclaration({ 'x-tug': { secret: 'NPM_TOKEN' } }));
    assert.equal(
      res.body.error,
      'build services require a source context or localImages upload',
      'a canonical declaration passes validation and the secret check, and stops only at the missing build input',
    );
  } finally {
    await s.close();
  }
});
