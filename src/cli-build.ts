import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as tar from 'tar';
import { buildAndPush, run } from './build.ts';
import { saveImageArchive } from './artifacts.ts';
import type { ComposeFile, LocalImageUpload } from './protocol.ts';

export interface LocalBuildDependencies { build: typeof buildAndPush; save: typeof saveImageArchive; nonce: () => string; remove: (imageRef: string) => Promise<void>; cleanupWarning?: (message: string) => void }

/** Credential exclusions are mandatory and cannot be re-included by source ignore rules. */
export function sourceArchiveFilter(entry: string, configPaths: string[], ignores: string[]): boolean {
  const relative = entry.replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/$/, '');
  if (relative.split('/').some(part => ['.git', '.tug.json'].includes(part))) return false;
  return ![...configPaths, ...ignores].some(ignore => relative === ignore || relative.startsWith(`${ignore}/`));
}

export async function createSourceArchive(contextDir: string, archive: string, configFiles: string[]): Promise<void> {
  const configPaths = configFiles.map(file => path.relative(contextDir, file).split(path.sep).join('/')).filter(file => file !== '..' && !file.startsWith('../') && !path.isAbsolute(file));
  const ignores = ['node_modules', 'data', 'registry-data'];
  try { ignores.push(...(await fs.readFile(path.join(contextDir, '.dockerignore'), 'utf8')).split(/\r?\n/).map(line => line.trim().replace(/\/$/, '')).filter(line => line && !line.startsWith('#') && !line.startsWith('!'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await tar.c({ gzip: true, file: archive, cwd: contextDir, filter: entry => sourceArchiveFilter(entry, configPaths, ignores) }, ['.']);
}

/** Build only application build services; callers own temporary files and upload transport. */
export async function prepareLocalImages(compose: ComposeFile, contextDir: string, directory: string, dependencies: LocalBuildDependencies = { build: buildAndPush, save: saveImageArchive, nonce: randomUUID, remove: async imageRef => { await run('docker', ['image', 'rm', imageRef]); } }): Promise<LocalImageUpload[]> {
  const images: LocalImageUpload[] = [];
  const nonce = dependencies.nonce();
  for (const [service, spec] of Object.entries(compose.services)) {
    if (!spec.build) continue;
    const field = `image-${images.length}`;
    const imageRef = `tug-build/${nonce}/${field}:local`;
    try {
      await dependencies.build({ contextDir, service, buildSpec: spec.build, imageRef, push: false });
      const archive = await dependencies.save(imageRef, path.join(directory, `${field}.tar.gz`));
      images.push({ service, imageRef, ...archive, field });
    } finally {
      try { await dependencies.remove(imageRef); }
      catch (error) { (dependencies.cleanupWarning || console.warn)(`Could not remove temporary application image ${imageRef}: ${(error as Error).message}`); }
    }
  }
  return images;
}
