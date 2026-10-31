import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Registry repository the release workflow publishes the Tug image to. */
export const IMAGE_REPOSITORY = 'ghcr.io/wpelevator/tug';
/** Tag `--build-local-image` builds and ships when no `--image` is given; for development against a checkout. */
export const LOCAL_IMAGE = 'tug:local';

// package.json sits one level above this file in src/ (dev), dist/ (build) and the installed package.
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

/** The published image matching this CLI's version, so the CLI and the agents it installs stay in step. */
export function defaultImage(version = packageVersion()): string {
  return `${IMAGE_REPOSITORY}:${version}`;
}

/** An explicit `--image` always wins; otherwise a locally built image is `tug:local` and anything else is the published image. */
export function resolveImage(image: string | undefined, buildLocalImage = false, version = packageVersion()): string {
  return image || (buildLocalImage ? LOCAL_IMAGE : defaultImage(version));
}
