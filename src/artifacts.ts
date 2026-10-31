import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { run } from './build.ts';
import { scanArchive } from './archive.ts';
import type { RunResult } from './build.ts';

export type ImageRunner = (cmd: string, args: string[]) => Promise<RunResult>;
export interface ImageInfo { imageId: string; platform: string }
export interface ArchiveInfo extends ImageInfo { sha256: string; sizeBytes: number }
export async function inspectImage(imageRef: string, runner: ImageRunner = run): Promise<ImageInfo> {
  const images = JSON.parse((await runner('docker', ['image', 'inspect', imageRef])).out);
  const image = images[0];
  if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id) || !image.Os || !image.Architecture) throw new Error(`invalid Docker image metadata for ${imageRef}`);
  return { imageId: image.Id, platform: `${image.Os}/${image.Architecture}` };
}
export async function hashArchive(file: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256'); let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); sizeBytes += chunk.length; }
  return { sha256: hash.digest('hex'), sizeBytes };
}
export async function saveImageArchive(imageRef: string, file: string): Promise<ArchiveInfo> {
  const child = spawn('docker', ['save', imageRef], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
  const finished = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`docker save failed (${code}): ${error}`))); });
  try { await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(file, { mode: 0o600 })), finished]); }
  catch (e) { child.kill(); await fs.rm(file, { force: true }); throw e; }
  return validateImageArchive(file, imageRef, 20 * 1024 ** 3, false);
}
/** Validate Docker save metadata before Docker can import attacker-selected repository tags. */
export async function validateImageArchive(file: string, expectedRef: string, maxExpandedBytes = 20 * 1024 ** 3, requireManagedReference = true): Promise<ArchiveInfo> {
  if (requireManagedReference && !/^tug-build\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$/.test(expectedRef)) throw new Error('local image reference must be a unique tug-build/ reference');
  const names = new Set<string>(); const regular = new Set<string>(); let expanded = 0; let entries = 0; let invalid: string | undefined;
  const blobMetadata = new Map<string, Buffer>(); const blobHashes = new Map<string, string>(); let metadataBytes = 0;
  let manifestBytes: Buffer | undefined; let indexBytes: Buffer | undefined; let repositoriesBytes: Buffer | undefined;
  await scanArchive(file, entry => {
    const name = entry.path.replace(/^\.\//, '');
    if (++entries > 100000 || (expanded += entry.size) > maxExpandedBytes) invalid = 'image archive exceeds expanded limits';
    if (name.startsWith('/') || name.split('/').includes('..') || !['File', 'Directory'].includes(entry.type) || names.has(name)) invalid = 'unsafe image archive entry';
    if (invalid) throw new Error(invalid);
    names.add(name); if (entry.type === 'File') regular.add(name);
    if (/^blobs\/sha256\/[a-f0-9]{64}$/.test(name)) {
      const hash = createHash('sha256'); const chunks: Buffer[] = []; let json = false; let first = true;
      entry.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (first) { json = entry.size <= 4 * 1024 ** 2 && (chunk[0] === 123 || chunk[0] === 91); first = false; }
        if (json) {
          metadataBytes += chunk.length;
          if (metadataBytes > 16 * 1024 ** 2) { invalid = 'OCI metadata exceeds limit'; json = false; chunks.length = 0; }
          else chunks.push(Buffer.from(chunk));
        }
      });
      entry.on('end', () => { blobHashes.set(name, hash.digest('hex')); if (json) blobMetadata.set(name, Buffer.concat(chunks)); });
    }
    if (['manifest.json', 'index.json', 'repositories'].includes(name) && !invalid) {
      if (entry.size > 1024 ** 2) { throw new Error('image manifest exceeds limit'); }
      const chunks: Buffer[] = []; entry.on('data', chunk => chunks.push(Buffer.from(chunk))); entry.on('end', () => { const value = Buffer.concat(chunks); if (name === 'manifest.json') manifestBytes = value; else if (name === 'index.json') indexBytes = value; else repositoriesBytes = value; });
    }
  });
  if (invalid) throw new Error(invalid);
  const manifest = JSON.parse(manifestBytes?.toString() || 'null');
  if (!Array.isArray(manifest) || manifest.length !== 1 || JSON.stringify(manifest[0].RepoTags) !== JSON.stringify([expectedRef])) throw new Error('archive must contain exactly the declared Tug image tag');
  if (typeof manifest[0].Config !== 'string' || !regular.has(manifest[0].Config)) throw new Error('image archive is missing its configuration');
  if (!Array.isArray(manifest[0].Layers) || manifest[0].Layers.some((layer: string) => typeof layer !== 'string' || !regular.has(layer))) throw new Error('image archive is missing layers');
  let configBytes: Buffer | undefined;
  await scanArchive(file, entry => {
    if (entry.path.replace(/^\.\//, '') !== manifest[0].Config) return;
    if (entry.size > 4 * 1024 ** 2) { throw new Error('image configuration exceeds limit'); }
    const chunks: Buffer[] = []; entry.on('data', chunk => chunks.push(Buffer.from(chunk))); entry.on('end', () => { configBytes = Buffer.concat(chunks); });
  });
  if (invalid) throw new Error(invalid);
  if (!configBytes) throw new Error('image archive is missing its configuration');
  if (indexBytes) {
    const index = JSON.parse(indexBytes.toString());
    const descriptor = index.manifests?.[0];
    const annotations = descriptor?.annotations || {};
    const allowedNames = new Set([expectedRef, `docker.io/${expectedRef}`, ...(!expectedRef.includes('/') ? [`docker.io/library/${expectedRef}`] : [])]);
    if (!Array.isArray(index.manifests) || index.manifests.length < 1 || !allowedNames.has(annotations['io.containerd.image.name']) || (annotations['org.opencontainers.image.ref.name'] && !allowedNames.has(annotations['org.opencontainers.image.ref.name']) && annotations['org.opencontainers.image.ref.name'] !== expectedRef.split(':').at(-1))) throw new Error('OCI index contains unexpected image names');
    const expectedConfig = `sha256:${createHash('sha256').update(configBytes).digest('hex')}`;
    const expectedLayers = manifest[0].Layers as string[];
    const visited = new Set<string>(); let runnable = 0;
    const readBlob = (digest: string): Record<string, unknown> => {
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('invalid OCI content digest');
      const name = `blobs/sha256/${digest.slice(7)}`; const bytes = blobMetadata.get(name);
      if (!bytes || blobHashes.get(name) !== digest.slice(7)) throw new Error('OCI metadata content digest mismatch or missing blob');
      return JSON.parse(bytes.toString());
    };
    interface Descriptor { digest: string; annotations?: Record<string, string>; platform?: { os?: string; architecture?: string } }
    const isAttestationDocument = (document: Record<string, unknown>, imageConfig: Record<string, unknown>): boolean =>
      (Object.keys(imageConfig).length === 0 && document.artifactType === 'application/vnd.docker.attestation.manifest.v1+json') || (imageConfig.os === 'unknown' && imageConfig.architecture === 'unknown');
    /** An attestation is acceptable only when it describes this exact saved image and carries nothing but in-toto statements. */
    const verifyAttestation = (document: Record<string, unknown>, subject: string | undefined): void => {
      const subjectConfig = subject ? readBlob(subject).config as Descriptor | undefined : undefined;
      if (subjectConfig?.digest !== expectedConfig) throw new Error('attestation subject does not match saved image');
      for (const layer of document.layers as (Descriptor & { mediaType?: string })[]) {
        const name = `blobs/sha256/${layer.digest?.slice(7)}`;
        if (layer.mediaType !== 'application/vnd.in-toto+json' || !/^sha256:[a-f0-9]{64}$/.test(layer.digest) || blobHashes.get(name) !== layer.digest.slice(7)) throw new Error('invalid attestation layer');
      }
    };
    const walk = (desc: Descriptor): void => {
      if (visited.has(desc.digest)) return; visited.add(desc.digest);
      if (desc.annotations?.['io.containerd.image.name'] || desc.annotations?.['org.opencontainers.image.ref.name']) throw new Error('nested OCI metadata contains unexpected image names');
      const document = readBlob(desc.digest);
      if (Array.isArray(document.manifests)) {
        for (const child of document.manifests as Descriptor[]) {
          if (typeof child.digest !== 'string') throw new Error('invalid OCI descriptor');
          if (regular.has(`blobs/sha256/${child.digest.slice(7)}`)) walk(child);
        }
        return;
      }
      const configDescriptor = document.config as Descriptor | undefined;
      if (!configDescriptor?.digest || !Array.isArray(document.layers)) throw new Error('invalid OCI image manifest');
      const imageConfig = readBlob(configDescriptor.digest);
      const attestation = desc.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' && desc.platform?.os === 'unknown' && desc.platform?.architecture === 'unknown';
      if (attestation && isAttestationDocument(document, imageConfig)) {
        verifyAttestation(document, (document.subject as Descriptor | undefined)?.digest || desc.annotations?.['vnd.docker.reference.digest']);
        return;
      }
      if (configDescriptor.digest !== expectedConfig) throw new Error('OCI graph configuration does not match saved image');
      const layerPaths = (document.layers as Descriptor[]).map(layer => {
        if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest)) throw new Error('invalid OCI layer digest');
        const name = `blobs/sha256/${layer.digest.slice(7)}`;
        if (!regular.has(name) || blobHashes.get(name) !== layer.digest.slice(7)) throw new Error('OCI layer content digest mismatch');
        return name;
      });
      if (JSON.stringify(layerPaths) !== JSON.stringify(expectedLayers)) throw new Error('OCI graph layers do not match saved image');
      runnable++;
    };
    walk({ ...descriptor, annotations: {} });
    if (runnable !== 1) throw new Error('OCI archive must contain exactly one runnable saved image');
    // On a containerd image store, `docker save` also lists build attestations that refer to the image as extra
    // top-level entries. They carry no image name, so they cannot create tags; accept them only when they are
    // genuine attestations of this exact image and reject any other extra manifest.
    for (const extra of index.manifests.slice(1) as Descriptor[]) {
      const annotationNames = Object.keys(extra.annotations || {});
      const unexpected = () => new Error('OCI index contains an unexpected extra manifest');
      if (annotationNames.length !== 1 || annotationNames[0] !== 'io.containerd.manifest.subject' || !/^sha256:[a-f0-9]{64}$/.test(extra.digest)) throw unexpected();
      const document = readBlob(extra.digest);
      const configDescriptor = document.config as Descriptor | undefined;
      const subject = (document.subject as Descriptor | undefined)?.digest;
      if (!configDescriptor?.digest || !Array.isArray(document.layers) || subject !== extra.annotations!['io.containerd.manifest.subject'] || !isAttestationDocument(document, readBlob(configDescriptor.digest))) throw unexpected();
      verifyAttestation(document, subject);
    }
  }
  if (repositoriesBytes) {
    const repositories = JSON.parse(repositoriesBytes.toString()); const colon = expectedRef.lastIndexOf(':');
    const repo = expectedRef.slice(0, colon); const tag = expectedRef.slice(colon + 1);
    if (JSON.stringify(Object.keys(repositories)) !== JSON.stringify([repo]) || JSON.stringify(Object.keys(repositories[repo])) !== JSON.stringify([tag])) throw new Error('archive repositories contain unexpected image tags');
  }
  const config = JSON.parse(configBytes.toString());
  if (config.os !== 'linux' || !['amd64', 'arm64'].includes(config.architecture)) throw new Error('only linux/amd64 and linux/arm64 image archives are supported');
  return { imageId: `sha256:${createHash('sha256').update(configBytes).digest('hex')}`, platform: `${config.os}/${config.architecture}`, ...await hashArchive(file) };
}
export function verifyDownload(expected: { sha256: string; sizeBytes: number }): Transform {
  const hash = createHash('sha256'); let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > expected.sizeBytes) return callback(new Error('image download exceeds expected size')); hash.update(chunk); callback(null, chunk); }, flush(callback) { callback(bytes === expected.sizeBytes && hash.digest('hex') === expected.sha256 ? undefined : new Error('image download checksum or size mismatch')); } });
}
