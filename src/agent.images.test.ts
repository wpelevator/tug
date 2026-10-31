import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { buildDesiredState } from './compose.ts';
import { containerSpecs } from './container-spec.ts';
import { FakeDocker } from '../tests/fake-docker.ts';
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
  let badBytes = false;
  const docker = new FakeDocker();
  docker.addImage('redis:7');
  docker.onLoad = () =>
    docker.images.set(artifact.imageRef, {
      Id: `sha256:${'c'.repeat(64)}`,
      Os: 'linux',
      Architecture: 'amd64',
    });
  const requests: string[] = [];
  const ctx: AgentContext = {
    nodeName: 'n1',
    stateDir,
    apply: true,
    controlUrl: 'https://control.test',
    token: 'node-token',
    docker,
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
    docker,
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
      defaultNode: 'n1',
      compose: {
        services: { app: { build: '.', pull_policy: 'always' }, cache: { image: 'redis:7' } },
      },
    });
    desired.services.app.artifact = artifact;
    desired.services.app.image = artifact.imageRef;
    assert.equal(
      containerSpecs(desired, 'n1').specs.app.body.Image,
      artifact.imageRef,
      'artifact services run the loaded image reference, whatever pull_policy the source declares',
    );
    assert.deepEqual(
      Object.keys(containerSpecs(desired, 'n2').specs),
      [],
      'default placement must be honored by container specs on every node',
    );
    const status = await reconcile(desired, s.ctx);
    assert.equal(
      status.observedRevision,
      'rev1',
      'serving reports must acknowledge the immutable desired-state revision',
    );
    assert.deepEqual(
      s.docker.verbs('pull'),
      ['pull redis:7'],
      'only published-image services must be pulled, never artifact services',
    );
    assert.deepEqual(s.docker.verbs('load'), ['load'], 'the artifact is loaded exactly once');
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
    assert.deepEqual(s.docker.verbs('load'), [], 'failed verification must prevent image loading');
    assert.equal(
      (await fs.readdir(s.ctx.stateDir)).some((name) => name.startsWith('image-download-')),
      false,
      'failed transfers must remove temporary downloads',
    );
    const desired = buildDesiredState({
      project: 'proj',
      version: 'v1',
      defaultNode: 'n1',
      compose: { services: { app: { build: '.' } } },
    });
    desired.services.app.artifact = artifact;
    s.docker.calls.length = 0;
    s.requests.length = 0;
    await reconcile(desired, { ...s.ctx, apply: false });
    assert.deepEqual(
      s.docker.calls,
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
    for (const ref of refs) s.docker.addImage(ref);
    s.docker.addImage('busybox');
    const used = await s.docker.createContainer('uses-image', { Image: 'tug-build/proj/used:v1' });
    await s.docker.startContainer(used);
    s.docker.calls.length = 0;
    await pruneManagedImages(s.ctx, [refs[0]]);
    assert.deepEqual(
      s.docker.verbs('image-rm'),
      ['image-rm tug-build/proj/remove:v1'],
      'pruning must remove only an unreferenced unused recorded Tug image',
    );
    assert.ok(
      s.docker.images.has('redis:7'),
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
