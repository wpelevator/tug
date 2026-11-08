import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { imageLocation, parseRegistryCredentials, resolveImage } from './registry.ts';

const manifest = JSON.stringify({
  schemaVersion: 2,
  manifests: [{ platform: { architecture: 'amd64' } }, { platform: { architecture: 'arm64' } }],
});
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
const response = () => new Response(manifest);

test('image references normalize Docker Hub, ports and implicit latest and reject malformed digests', () => {
  assert.deepEqual(
    imageLocation('nginx'),
    {
      host: 'docker.io',
      repository: 'library/nginx',
      tag: 'latest',
      digest: undefined,
      name: 'nginx',
    },
    'short names must use the official Hub namespace and latest tag',
  );
  assert.equal(
    imageLocation('registry.example:5000/team/app:v1').tag,
    'v1',
    'registry ports must not be parsed as image tags',
  );
  assert.equal(
    imageLocation('index.docker.io/team/app').host,
    'docker.io',
    'Docker Hub aliases must use the same credential key',
  );
  for (const ref of [
    'nginx@sha256:123',
    'nginx@oops',
    'https://example.com/app',
    'UPPER/app',
    'app:',
  ])
    assert.throws(
      () => imageLocation(ref),
      /invalid image/,
      'malformed image references must fail before network access',
    );
  assert.throws(
    () => parseRegistryCredentials('{"x":{"password":"secret"}}'),
    /username\/password/,
    'malformed credentials must give a redacted configuration error',
  );
});

test('resolution hashes the full multi-platform manifest and keeps explicit digests offline', async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.match(
      String((init!.headers as Record<string, string>).Accept),
      /image.index/,
      'resolution must request multi-platform index media types',
    );
    return response();
  };
  assert.equal(
    await resolveImage('nginx:alpine', {}, request),
    `nginx:alpine@${digest}`,
    'the pinned reference must identify the entire index without selecting control host architecture',
  );
  assert.equal(
    calls[0],
    'https://registry-1.docker.io/v2/library/nginx/manifests/alpine',
    'short published image names must resolve against Docker Hub',
  );
  assert.equal(
    await resolveImage(`nginx@${digest}`, {}, request),
    `nginx@${digest}`,
    'explicit pins must remain unchanged',
  );
  assert.equal(calls.length, 1, 'explicit pins must need no registry lookup');
});

test('registry Bearer challenges support anonymous and project-secret authentication', async () => {
  for (const privateRegistry of [false, true]) {
    let count = 0;
    const request: typeof fetch = async (url, init) => {
      count++;
      const headers = init!.headers as Record<string, string>;
      if (count === 1) {
        assert.equal(
          headers.Authorization,
          undefined,
          'credentials must wait for an authentication challenge',
        );
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.example/token",service="registry.example",scope="wrong"',
          },
        });
      }
      if (count === 2) {
        const parsed = new URL(String(url));
        assert.equal(
          parsed.searchParams.get('scope'),
          'repository:team/app:pull',
          'tokens must request only pull access to the resolved repository',
        );
        assert.equal(
          headers.Authorization,
          privateRegistry ? `Basic ${Buffer.from('user:secret').toString('base64')}` : undefined,
          'private token exchanges must use only the matching project credential',
        );
        return Response.json({ access_token: 'issued-token' });
      }
      assert.equal(
        headers.Authorization,
        'Bearer issued-token',
        'manifest retry must use the exchanged token',
      );
      return response();
    };
    assert.equal(
      await resolveImage(
        'registry.example/team/app:v1',
        privateRegistry ? { 'registry.example': { username: 'user', password: 'secret' } } : {},
        request,
      ),
      `registry.example/team/app:v1@${digest}`,
      'both anonymous and authenticated registries must produce immutable pins',
    );
  }
});

test('Basic auth and registry errors never leak passwords or upstream bodies', async () => {
  let count = 0;
  const auth = { 'private.example': { username: 'u', password: 'sensitive-password' } };
  const request: typeof fetch = async (_url, init) => {
    if (++count === 1)
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="registry"' },
      });
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      `Basic ${Buffer.from('u:sensitive-password').toString('base64')}`,
      'Basic registries must receive the matching credential after a challenge',
    );
    return response();
  };
  assert.match(
    await resolveImage('private.example/app', auth, request),
    /@sha256:/,
    'Basic-authenticated manifests must resolve',
  );
  for (const badResponse of [
    new Response('sensitive-password', { status: 403 }),
    new Response(manifest, { headers: { 'docker-content-digest': `sha256:${'0'.repeat(64)}` } }),
    new Response('{}'),
  ]) {
    await assert.rejects(
      resolveImage('private.example/app', auth, async () => badResponse),
      (error) =>
        error instanceof Error &&
        /cannot resolve image/.test(error.message) &&
        !error.message.includes('sensitive-password'),
      'failed pulls and invalid manifests must fail with a redacted error',
    );
  }
  await assert.rejects(
    resolveImage(
      'private.example/app',
      auth,
      async () =>
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="http://auth.example/token"' },
        }),
    ),
    /cannot resolve/,
    'credentials must never travel over a plaintext token endpoint',
  );
});
