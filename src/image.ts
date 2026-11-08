import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedVersion } from './embedded.ts';

/** Registry repository the release workflow publishes the Tug image to. */
export const IMAGE_REPOSITORY = 'ghcr.io/wpelevator/tug';
/** Tag `--build-local-image` builds and ships when no `--image` is given; for development against a checkout. */
export const LOCAL_IMAGE = 'tug:local';

// package.json sits one level above this file in src/ (dev), dist/ (build) and the installed package.
const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);

export function packageVersion(): string {
  const embedded = embeddedVersion();
  if (embedded) return embedded;
  return (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

/** The published image matching this CLI's version, so the CLI and the agents it installs stay in step. */
export function defaultImage(version = packageVersion()): string {
  return `${IMAGE_REPOSITORY}:${version}`;
}

/** An explicit `--image` always wins; otherwise a locally built image is `tug:local` and anything else is the published image. */
export function resolveImage(
  image: string | undefined,
  buildLocalImage = false,
  version = packageVersion(),
): string {
  return image || (buildLocalImage ? LOCAL_IMAGE : defaultImage(version));
}

/**
 * Fails before any host is touched when the published image for this CLI version does not exist yet. A release
 * publishes the npm package a few minutes before its image, so a fresh CLI can briefly name a missing tag. Only a
 * definitive "no such manifest" answer fails; no Docker, no network or a private registry carry on silently.
 */
export function assertImagePublished(
  image: string,
  inspect: (image: string) => { status: number | null; stderr: string } = (ref) => {
    const result = spawnSync('docker', ['manifest', 'inspect', ref], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stderr: String(result.stderr ?? '') };
  },
): void {
  if (!image.startsWith(`${IMAGE_REPOSITORY}:`)) return;
  const result = inspect(image);
  if (result.status !== 0 && /no such manifest|manifest unknown|not found/i.test(result.stderr))
    throw new Error(
      `${image} is not published yet: a release builds its image a few minutes after the npm package. Retry shortly, or pass --image ${IMAGE_REPOSITORY}:latest to use the latest release.`,
    );
}
