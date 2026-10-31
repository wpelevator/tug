import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { validateImageArchive, verifyDownload } from './artifacts.ts';

async function fixture(tag: string, tags = [tag]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tug-artifact-'));
  const config = JSON.stringify({ os: 'linux', architecture: 'arm64', config: {} });
  const digest = createHash('sha256').update(config).digest('hex');
  const configPath = `blobs/sha256/${digest}`;
  await fs.mkdir(path.join(dir, 'blobs/sha256'), { recursive: true });
  await fs.writeFile(path.join(dir, configPath), config);
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify([{ Config: configPath, RepoTags: tags, Layers: [] }]),
  );
  const file = path.join(dir, 'image.tar.gz');
  await tar.c({ cwd: dir, file, gzip: true }, ['manifest.json', configPath]);
  return { dir, file, imageId: `sha256:${digest}` };
}
test('archive validation reads Docker 29 extensionless configuration blobs and rejects extra tags', async () => {
  const good = await fixture('tug-build/test/app:unique');
  const bad = await fixture('tug-build/test/app:unique', [
    'tug-build/test/app:unique',
    'busybox:latest',
  ]);
  try {
    const info = await validateImageArchive(good.file, 'tug-build/test/app:unique');
    assert.equal(
      info.imageId,
      good.imageId,
      'the image identity must be derived from the actual extensionless config bytes',
    );
    assert.equal(
      info.platform,
      'linux/arm64',
      'the platform must come from the archived configuration',
    );
    await assert.rejects(
      validateImageArchive(bad.file, 'tug-build/test/app:unique'),
      /exactly the declared/,
      'an archive must not import unrelated repository tags',
    );
    await assert.rejects(
      validateImageArchive(good.file, 'busybox:latest'),
      /tug-build/,
      'uploads must use a Tug-owned unique reference',
    );
    await assert.rejects(
      validateImageArchive(good.file, 'tug-build/test/app:unique', 1),
      /expanded limits/,
      'expanded archives must respect the configured limit',
    );
  } finally {
    await fs.rm(good.dir, { recursive: true, force: true });
    await fs.rm(bad.dir, { recursive: true, force: true });
  }
});
test('download verification rejects truncated, changed and oversized data', async () => {
  const bytes = Buffer.from('image bytes');
  const expected = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  const transfer = (body: Buffer) =>
    pipeline(
      Readable.from([body]),
      verifyDownload(expected),
      new Writable({
        write(_chunk, _encoding, next) {
          next();
        },
      }),
    );
  await transfer(bytes);
  await assert.rejects(
    transfer(bytes.subarray(1)),
    /checksum or size/,
    'truncated archives must fail verification',
  );
  await assert.rejects(
    transfer(Buffer.from('Image bytes')),
    /checksum or size/,
    'changed bytes must fail verification',
  );
  await assert.rejects(
    transfer(Buffer.concat([bytes, bytes])),
    /exceeds/,
    'oversized responses must stop before Docker load',
  );
});
test('oversized image configuration rejects without an uncaught parser exception', async () => {
  const saved = await fixture('tug-build/test/app:oversized');
  try {
    const [digest] = await fs.readdir(path.join(saved.dir, 'blobs/sha256'));
    const configPath = `blobs/sha256/${digest}`;
    await fs.writeFile(path.join(saved.dir, configPath), 'x'.repeat(4 * 1024 ** 2 + 1));
    await tar.c({ cwd: saved.dir, file: saved.file, gzip: true }, ['manifest.json', configPath]);
    await assert.rejects(
      validateImageArchive(saved.file, 'tug-build/test/app:oversized'),
      /configuration exceeds limit/,
      'oversized configuration must reject the request without crashing the process',
    );
  } finally {
    await fs.rm(saved.dir, { recursive: true, force: true });
  }
});
test('OCI graph content and configuration must match the saved image manifest', async () => {
  const saved = await fixture('tug-build/test/app:oci');
  try {
    const [configHash] = await fs.readdir(path.join(saved.dir, 'blobs/sha256'));
    const makeIndex = async (configDigest: string) => {
      const document = JSON.stringify({
        schemaVersion: 2,
        config: { digest: `sha256:${configDigest}` },
        layers: [],
      });
      const digest = createHash('sha256').update(document).digest('hex');
      await fs.writeFile(path.join(saved.dir, `blobs/sha256/${digest}`), document);
      await fs.writeFile(
        path.join(saved.dir, 'index.json'),
        JSON.stringify({
          manifests: [
            {
              digest: `sha256:${digest}`,
              annotations: { 'io.containerd.image.name': 'docker.io/tug-build/test/app:oci' },
            },
          ],
        }),
      );
      await tar.c({ cwd: saved.dir, gzip: true, file: saved.file }, [
        'manifest.json',
        'index.json',
        'blobs',
      ]);
      return digest;
    };
    await makeIndex(configHash);
    assert.equal(
      (await validateImageArchive(saved.file, 'tug-build/test/app:oci')).imageId,
      `sha256:${configHash}`,
      'a matching OCI graph and compatibility manifest must share one canonical identity',
    );
    const otherConfig = JSON.stringify({
      os: 'linux',
      architecture: 'arm64',
      config: { Cmd: ['different'] },
    });
    const otherHash = createHash('sha256').update(otherConfig).digest('hex');
    await fs.writeFile(path.join(saved.dir, `blobs/sha256/${otherHash}`), otherConfig);
    await makeIndex(otherHash);
    await assert.rejects(
      validateImageArchive(saved.file, 'tug-build/test/app:oci'),
      /configuration does not match/,
      'an OCI image must not load a different config than the one the compatibility manifest claims',
    );
    const digest = await makeIndex(configHash);
    await fs.writeFile(path.join(saved.dir, `blobs/sha256/${digest}`), '{}');
    await tar.c({ cwd: saved.dir, gzip: true, file: saved.file }, [
      'manifest.json',
      'index.json',
      'blobs',
    ]);
    await assert.rejects(
      validateImageArchive(saved.file, 'tug-build/test/app:oci'),
      /content digest mismatch/,
      'OCI metadata bytes must match their content-addressed names',
    );
  } finally {
    await fs.rm(saved.dir, { recursive: true, force: true });
  }
});
test('Docker BuildKit empty-config provenance attestations are bound to the runnable saved image', async () => {
  const saved = await fixture('tug-build/test/app:buildkit');
  try {
    const [configHash] = await fs.readdir(path.join(saved.dir, 'blobs/sha256'));
    const blob = async (value: unknown) => {
      const bytes = JSON.stringify(value);
      const hash = createHash('sha256').update(bytes).digest('hex');
      await fs.writeFile(path.join(saved.dir, `blobs/sha256/${hash}`), bytes);
      return `sha256:${hash}`;
    };
    const runnable = await blob({
      schemaVersion: 2,
      config: { digest: `sha256:${configHash}` },
      layers: [],
    });
    const empty = await blob({});
    const attestation = await blob({
      schemaVersion: 2,
      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: empty },
      layers: [],
      subject: { digest: runnable },
    });
    const root = await blob({
      manifests: [
        { digest: runnable, platform: { os: 'linux', architecture: 'arm64' } },
        {
          digest: attestation,
          platform: { os: 'unknown', architecture: 'unknown' },
          annotations: {
            'vnd.docker.reference.type': 'attestation-manifest',
            'vnd.docker.reference.digest': runnable,
          },
        },
      ],
    });
    await fs.writeFile(
      path.join(saved.dir, 'index.json'),
      JSON.stringify({
        manifests: [
          {
            digest: root,
            annotations: { 'io.containerd.image.name': 'docker.io/tug-build/test/app:buildkit' },
          },
        ],
      }),
    );
    await tar.c({ cwd: saved.dir, gzip: true, file: saved.file }, [
      'manifest.json',
      'index.json',
      'blobs',
    ]);
    assert.equal(
      (await validateImageArchive(saved.file, 'tug-build/test/app:buildkit')).imageId,
      `sha256:${configHash}`,
      'BuildKit provenance must preserve the same canonical runnable image identity',
    );
  } finally {
    await fs.rm(saved.dir, { recursive: true, force: true });
  }
});
// `docker save` on a containerd image store lists build attestations of the image as extra top-level index entries.
async function containerdFixture(
  tag: string,
  extraEntry: (ctx: {
    blob: (value: unknown) => Promise<string>;
    runnable: string;
    configHash: string;
    statement: string;
    empty: string;
  }) => Promise<Record<string, unknown>>,
) {
  const saved = await fixture(tag);
  const [configHash] = await fs.readdir(path.join(saved.dir, 'blobs/sha256'));
  const blob = async (value: unknown) => {
    const bytes = JSON.stringify(value);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(saved.dir, `blobs/sha256/${hash}`), bytes);
    return `sha256:${hash}`;
  };
  const runnable = await blob({
    schemaVersion: 2,
    config: { digest: `sha256:${configHash}` },
    layers: [],
  });
  const root = await blob({
    manifests: [{ digest: runnable, platform: { os: 'linux', architecture: 'arm64' } }],
  });
  const empty = await blob({});
  const statement = await blob({ _type: 'https://in-toto.io/Statement/v0.1' });
  const extra = await extraEntry({ blob, runnable, configHash, statement, empty });
  await fs.writeFile(
    path.join(saved.dir, 'index.json'),
    JSON.stringify({
      manifests: [
        {
          digest: root,
          annotations: {
            'io.containerd.image.name': `docker.io/${tag}`,
            'org.opencontainers.image.ref.name': tag.split(':')[1],
          },
        },
        extra,
      ],
    }),
  );
  await tar.c({ cwd: saved.dir, gzip: true, file: saved.file }, [
    'manifest.json',
    'index.json',
    'blobs',
  ]);
  return { ...saved, configHash };
}
const attestationOf = (
  subject: string,
  ctx: { blob: (value: unknown) => Promise<string>; statement: string; empty: string },
) =>
  ctx.blob({
    schemaVersion: 2,
    artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: ctx.empty },
    layers: [{ mediaType: 'application/vnd.in-toto+json', digest: ctx.statement }],
    subject: { digest: subject },
  });

test('a build attestation listed beside the image in a containerd image store archive is accepted', async () => {
  const saved = await containerdFixture('tug-build/test/app:referrer', async (ctx) => ({
    digest: await attestationOf(ctx.runnable, ctx),
    annotations: { 'io.containerd.manifest.subject': ctx.runnable },
  }));
  try {
    assert.equal(
      (await validateImageArchive(saved.file, 'tug-build/test/app:referrer')).imageId,
      `sha256:${saved.configHash}`,
      'an attestation of the saved image must not change its identity or make the archive invalid',
    );
  } finally {
    await fs.rm(saved.dir, { recursive: true, force: true });
  }
});

test('extra top-level index entries are rejected unless they are attestations of the saved image', async () => {
  const cases: [
    string,
    (
      ctx: Parameters<Parameters<typeof containerdFixture>[1]>[0],
    ) => Promise<Record<string, unknown>>,
    RegExp,
    string,
  ][] = [
    [
      'named',
      async (ctx) => ({
        digest: await attestationOf(ctx.runnable, ctx),
        annotations: {
          'io.containerd.manifest.subject': ctx.runnable,
          'io.containerd.image.name': 'docker.io/library/busybox:latest',
        },
      }),
      /unexpected extra manifest/,
      'an extra entry that names an image could make Docker import an attacker-chosen tag',
    ],
    [
      'runnable',
      async (ctx) => ({
        digest: ctx.runnable,
        annotations: { 'io.containerd.manifest.subject': ctx.runnable },
      }),
      /unexpected extra manifest/,
      'a second runnable image must not hide behind the attestation annotation',
    ],
    [
      'other-image',
      async (ctx) => {
        const otherConfig = await ctx.blob({
          os: 'linux',
          architecture: 'arm64',
          config: { Cmd: ['other'] },
        });
        const other = await ctx.blob({
          schemaVersion: 2,
          config: { digest: otherConfig },
          layers: [],
        });
        return {
          digest: await attestationOf(other, ctx),
          annotations: { 'io.containerd.manifest.subject': other },
        };
      },
      /attestation subject does not match/,
      'an attestation of a different image must be rejected',
    ],
    [
      'mismatched-subject',
      async (ctx) => ({
        digest: await attestationOf(ctx.runnable, ctx),
        annotations: { 'io.containerd.manifest.subject': `sha256:${'0'.repeat(64)}` },
      }),
      /unexpected extra manifest/,
      'the index annotation must agree with the attestation document',
    ],
  ];
  for (const [name, entry, expected, why] of cases) {
    const saved = await containerdFixture(`tug-build/test/app:${name}`, entry);
    try {
      await assert.rejects(
        validateImageArchive(saved.file, `tug-build/test/app:${name}`),
        expected,
        why,
      );
    } finally {
      await fs.rm(saved.dir, { recursive: true, force: true });
    }
  }
});

test('trusted runtime saves may use ordinary image tags while uploads remain in the managed namespace', async () => {
  const saved = await fixture('tug:local');
  try {
    assert.equal(
      (await validateImageArchive(saved.file, 'tug:local', 20 * 1024 ** 3, false)).imageId,
      saved.imageId,
      'trusted runtime image transfer must permit its actual image tag',
    );
    await assert.rejects(
      validateImageArchive(saved.file, 'tug:local'),
      /tug-build/,
      'untrusted uploads must retain the managed-reference policy',
    );
  } finally {
    await fs.rm(saved.dir, { recursive: true, force: true });
  }
});
