import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { buildDesiredState, composeForNode } from './compose.ts';
import { reconcile, ensureArtifact, pruneManagedImages } from './agent.ts';
import type { AgentContext } from './agent.ts';
import type { ImageArtifact } from './protocol.ts';
let bytes = Buffer.from('compressed image bytes');
const artifact: ImageArtifact = {
  buildId: 'build_test',
  imageRef: 'tug-build/proj/app:unique',
  imageId: `sha256:${'b'.repeat(64)}`,
  platform: 'linux/amd64',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length,
};
async function context() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-agent-image-'));
  const config = JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} });
  artifact.imageId = `sha256:${createHash('sha256').update(config).digest('hex')}`;
  await fs.writeFile(path.join(stateDir, 'config.json'), config);
  await fs.writeFile(
    path.join(stateDir, 'manifest.json'),
    JSON.stringify([{ Config: 'config.json', RepoTags: [artifact.imageRef], Layers: [] }]),
  );
  const archiveFile = path.join(stateDir, 'fixture.tar.gz');
  await tar.c({ cwd: stateDir, gzip: true, file: archiveFile }, ['config.json', 'manifest.json']);
  bytes = await fs.readFile(archiveFile);
  artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
  artifact.sizeBytes = bytes.length;
  let loaded = false;
  let badBytes = false;
  const calls: string[] = [];
  const requests: string[] = [];
  const ctx: AgentContext = {
    nodeName: 'n1',
    stateDir,
    apply: true,
    controlUrl: 'https://control.test',
    token: 'node-token',
    docker: async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (!loaded) throw new Error('missing');
        return {
          out: JSON.stringify([
            { Id: `sha256:${'c'.repeat(64)}`, Os: 'linux', Architecture: 'amd64' },
          ]),
          err: '',
        };
      }
      if (args[0] === 'info')
        return { out: JSON.stringify({ OSType: 'linux', Architecture: 'x86_64' }), err: '' };
      if (args[0] === 'load') {
        assert.deepEqual(
          await fs.readFile(args[2]),
          bytes,
          'Docker must load only verified downloaded bytes',
        );
        loaded = true;
      }
      return { out: '', err: '' };
    },
    http: async (input, init) => {
      requests.push(String(input));
      if (String(input).includes('/images/')) {
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer node-token',
          'image downloads must use the node token',
        );
        return new Response(badBytes ? 'bad' : bytes);
      }
      return Response.json({ secrets: {}, versions: {} });
    },
  };
  return {
    ctx,
    calls,
    requests,
    corrupt: () => {
      badBytes = true;
    },
    close: () => fs.rm(stateDir, { recursive: true, force: true }),
  };
}
test('artifact-backed services load verified images once, never pull and report immutable revisions', async () => {
  const s = await context();
  try {
    const desired = buildDesiredState({
      project: 'proj',
      version: 'v1',
      revision: 'rev1',
      registry: '',
      defaultNode: 'n1',
      compose: {
        services: { app: { build: '.', pull_policy: 'always' }, cache: { image: 'redis:7' } },
      },
    });
    desired.services.app.artifact = artifact;
    desired.services.app.image = artifact.imageRef;
    assert.equal(
      composeForNode(desired, 'n1').services.app.pull_policy,
      'never',
      'artifact policy must override a source pull policy',
    );
    assert.deepEqual(
      Object.keys(composeForNode(desired, 'n2').services),
      [],
      'default placement must be honored by generated Compose on every node',
    );
    const status = await reconcile(desired, s.ctx);
    assert.equal(
      status.observedRevision,
      'rev1',
      'serving reports must acknowledge the immutable desired-state revision',
    );
    assert.ok(
      s.calls.includes('compose -p proj pull cache'),
      'only published-image services must be pulled',
    );
    assert.ok(
      !s.calls.some((call) => call.includes('pull app')),
      'artifact services must never be pulled from a registry',
    );
    await reconcile(desired, s.ctx);
    assert.equal(
      s.requests.filter((url) => url.includes('/images/')).length,
      1,
      'matching local image identity must avoid another transfer',
    );
    assert.equal(
      (await fs.readdir(s.ctx.stateDir)).some((name) => name.startsWith('image-download-')),
      false,
      'completed transfers must remove temporary downloads',
    );
  } finally {
    await s.close();
  }
});
test('corrupt downloads fail before load and dry-run mode performs no image I/O', async () => {
  const s = await context();
  try {
    s.corrupt();
    await assert.rejects(
      ensureArtifact(s.ctx, artifact),
      /checksum or size/,
      'corrupt compressed bytes must never reach Docker load',
    );
    assert.ok(
      !s.calls.some((call) => call.startsWith('load ')),
      'failed verification must prevent image loading',
    );
    assert.equal(
      (await fs.readdir(s.ctx.stateDir)).some((name) => name.startsWith('image-download-')),
      false,
      'failed transfers must remove temporary downloads',
    );
    const desired = buildDesiredState({
      project: 'proj',
      version: 'v1',
      registry: '',
      defaultNode: 'n1',
      compose: { services: { app: { build: '.' } } },
    });
    desired.services.app.artifact = artifact;
    s.calls.length = 0;
    s.requests.length = 0;
    await reconcile(desired, { ...s.ctx, apply: false });
    assert.deepEqual(
      s.calls,
      [],
      'dry-run reconciliation must never inspect, download or load images',
    );
    assert.ok(
      !s.requests.some((url) => url.includes('/images/')),
      'dry-run reconciliation must not download image archives',
    );
  } finally {
    await s.close();
  }
});
test('agent pruning removes only recorded unused Tug images and protects retained and running images', async () => {
  const s = await context();
  try {
    const refs = [
      'tug-build/proj/keep:v1',
      'tug-build/proj/used:v1',
      'tug-build/proj/remove:v1',
      'redis:7',
    ];
    await fs.writeFile(path.join(s.ctx.stateDir, 'managed-images.json'), JSON.stringify(refs));
    const calls: string[] = [];
    await pruneManagedImages(
      {
        ...s.ctx,
        docker: async (args) => {
          calls.push(args.join(' '));
          return { out: args.at(-1)?.includes('used') ? 'container-id' : '', err: '' };
        },
      },
      [refs[0]],
    );
    assert.deepEqual(
      calls.filter((call) => call.startsWith('image rm')),
      ['image rm tug-build/proj/remove:v1'],
      'pruning must remove only an unreferenced unused recorded Tug image',
    );
    assert.ok(
      !calls.some((call) => call.includes('redis:7')),
      'pruning must never touch unrelated published images',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(s.ctx.stateDir, 'managed-images.json'), 'utf8')),
      refs.slice(0, 2),
      'retained and in-use images must remain tracked',
    );
  } finally {
    await s.close();
  }
});
