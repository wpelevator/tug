import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as tar from 'tar';
import { buildImage, run } from './build.ts';
import { saveImageArchive } from './artifacts.ts';
import type { ComposeFile, LocalImageUpload } from './protocol.ts';
import { CONFIG_NAMES } from './cli-config.ts';

export interface LocalBuildDependencies {
  build: typeof buildImage;
  save: typeof saveImageArchive;
  nonce: () => string;
  remove: (imageRef: string) => Promise<void>;
  cleanupWarning?: (message: string) => void;
}

/** At any depth: the git directory and every file that can hold a token (the untracked config overlays). */
const ALWAYS_EXCLUDED = [
  '.git',
  '.tug.json',
  '.tug.local.json',
  'tug.local.yml',
  'tug.local.yaml',
  'tug.local.json',
];

/** Credential exclusions are mandatory and cannot be re-included by source ignore rules. The tracked config names are excluded at the context root only, so an app's own nested `tug.json` is kept. */
export function sourceArchiveFilter(
  entry: string,
  configPaths: string[],
  ignores: string[],
): boolean {
  const relative = entry
    .replaceAll('\\', '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/$/, '');
  const parts = relative.split('/');
  if (parts.some((part) => ALWAYS_EXCLUDED.includes(part) || CREDENTIAL_FILE.test(part)))
    return false;
  if (parts.length === 1 && CONFIG_NAMES.includes(relative)) return false;
  if (configPaths.some((file) => relative === file || relative.startsWith(`${file}/`)))
    return false;
  return !compileIgnore(ignores)(relative);
}

/** Credential documents written by `control-install --credential-out` (default `tug-root.credential.json`). */
const CREDENTIAL_FILE = /\.credential\.json$/;

const ignoreCache = new WeakMap<string[], (relative: string) => boolean>();

/** Translates one `.dockerignore` pattern: `*`, `?` and `[...]` classes stay within a path segment, `**` crosses them. */
function ignorePattern(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[' && pattern.indexOf(']', i + 2) > 0) {
      const close = pattern.indexOf(']', i + 2);
      const body = pattern.slice(i + 1, close);
      const negated = body[0] === '^' || body[0] === '!';
      source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&')}]`;
      i = close;
    } else if (char === '\\' && i + 1 < pattern.length)
      source += pattern[++i].replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Compiles `.dockerignore` lines with Docker's semantics: patterns are rooted at the context, a pattern that
 * matches a directory excludes everything below it, and the last matching rule wins, so `!` re-includes.
 */
function compileIgnore(lines: string[]): (relative: string) => boolean {
  const cached = ignoreCache.get(lines);
  if (cached) return cached;
  const rules = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const pattern = path.posix
        .normalize((negated ? line.slice(1) : line).trim())
        .replace(/^\/+/, '')
        .replace(/\/$/, '');
      return { negated, pattern: ignorePattern(pattern), valid: pattern !== '' && pattern !== '.' };
    })
    .filter((rule) => rule.valid);
  const matcher = (relative: string): boolean => {
    const segments = relative.split('/');
    let ignored = false;
    for (const { negated, pattern } of rules) {
      for (let end = 1; end <= segments.length; end++) {
        if (pattern.test(segments.slice(0, end).join('/'))) {
          ignored = !negated;
          break;
        }
      }
    }
    return ignored;
  };
  ignoreCache.set(lines, matcher);
  return matcher;
}

export async function createSourceArchive(
  contextDir: string,
  archive: string,
  configFiles: string[],
): Promise<void> {
  const configPaths = configFiles
    .map((file) => path.relative(contextDir, file).split(path.sep).join('/'))
    .filter((file) => file !== '..' && !file.startsWith('../') && !path.isAbsolute(file));
  const ignores = ['node_modules', 'data'];
  try {
    ignores.push(
      ...(await fs.readFile(path.join(contextDir, '.dockerignore'), 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim()),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await tar.c(
    {
      gzip: true,
      file: archive,
      cwd: contextDir,
      filter: (entry) => sourceArchiveFilter(entry, configPaths, ignores),
    },
    ['.'],
  );
}

/** Build only application build services; callers own temporary files and upload transport. */
export async function prepareLocalImages(
  compose: ComposeFile,
  contextDir: string,
  directory: string,
  dependencies: LocalBuildDependencies = {
    build: buildImage,
    save: saveImageArchive,
    nonce: randomUUID,
    remove: async (imageRef) => {
      await run('docker', ['image', 'rm', imageRef]);
    },
  },
): Promise<LocalImageUpload[]> {
  const images: LocalImageUpload[] = [];
  const nonce = dependencies.nonce();
  for (const [service, spec] of Object.entries(compose.services)) {
    if (!spec.build) continue;
    const field = `image-${images.length}`;
    const imageRef = `tug-build/${nonce}/${field}:local`;
    try {
      await dependencies.build({
        contextDir,
        service,
        buildSpec: spec.build,
        imageRef,
      });
      const archive = await dependencies.save(imageRef, path.join(directory, `${field}.tar.gz`));
      images.push({ service, imageRef, ...archive, field });
    } finally {
      try {
        await dependencies.remove(imageRef);
      } catch (error) {
        (dependencies.cleanupWarning || console.warn)(
          `Could not remove temporary application image ${imageRef}: ${(error as Error).message}`,
        );
      }
    }
  }
  return images;
}
