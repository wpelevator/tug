import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

/** Pulls the restic image when the runner does not have it: these tests create helper containers directly. */
export function ensureResticImage(image: string): void {
  if (docker('image', 'inspect', image).status !== 0) docker('pull', image);
}

/** restic runs as root in its container, so on Linux the repository it writes is neither readable nor removable by this user. */
export function openUp(dir: string): void {
  docker('run', '--rm', '-v', `${dir}:/work`, 'alpine', 'chmod', '-R', 'a+rwX', '/work');
}

/** Removes a directory restic wrote as root. */
export async function removeAsRoot(dir: string): Promise<void> {
  docker('run', '--rm', '-v', `${dir}:/work`, 'alpine', 'sh', '-c', 'rm -rf /work/* /work/.[!.]*');
  await fs.rm(dir, { recursive: true, force: true });
}

/** Counts the lock files in a repository on disk, reading them as root. */
export function lockFiles(repo: string): number {
  const out = docker(
    'run',
    '--rm',
    '-v',
    `${repo}:/work:ro`,
    'alpine',
    'sh',
    '-c',
    'ls /work/locks 2>/dev/null | wc -l',
  ).stdout;
  return Number(out.trim()) || 0;
}
