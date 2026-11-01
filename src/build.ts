import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { scanArchive } from './archive.ts';
import { ensureDir, exists } from './util.ts';

export interface RunResult {
  out: string;
  err: string;
}
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the process after this long; defaults to {@link RUN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Longest a child process may run before it is killed, so a stalled build cannot hold the control writer forever. */
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Per-stream cap on retained output; the tail is kept because failures are reported last. */
export const RUN_OUTPUT_LIMIT = 1024 * 1024;

const tail = (text: string, chunk: string) =>
  (text + chunk).length > RUN_OUTPUT_LIMIT ? (text + chunk).slice(-RUN_OUTPUT_LIMIT) : text + chunk;
export interface BuildSpec {
  context?: string;
  dockerfile?: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { timeoutMs = RUN_TIMEOUT_MS, ...spawnOptions } = opts;
    const p = spawn(cmd, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => (out = tail(out, String(d))));
    p.stderr.on('data', (d) => (err = tail(err, String(d))));
    p.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(
          new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs} ms\n${out}\n${err}`),
        );
      else if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${out}\n${err}`));
    });
  });
}

export async function unpackContext(tarball: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await ensureDir(dest);
  let expanded = 0;
  let entries = 0;
  await scanArchive(tarball, (entry) => {
    expanded += entry.size;
    entries++;
    if (
      expanded > 20 * 1024 ** 3 ||
      entries > 100000 ||
      path.isAbsolute(entry.path) ||
      entry.path.split('/').includes('..') ||
      !['File', 'Directory'].includes(entry.type)
    )
      throw new Error('source context has unsafe entries or exceeds expanded limits');
  });
  await tar.x({ file: tarball, cwd: dest, strict: true });
}

export interface BuildImageOptions {
  contextDir: string;
  service: string;
  buildSpec: string | BuildSpec;
  imageRef: string;
}

export async function buildImage({
  contextDir,
  service,
  buildSpec,
  imageRef,
}: BuildImageOptions): Promise<void> {
  const buildPath = typeof buildSpec === 'string' ? buildSpec : buildSpec?.context || '.';
  const dockerfilePath =
    typeof buildSpec === 'object' && buildSpec.dockerfile
      ? path.resolve(contextDir, buildPath, buildSpec.dockerfile)
      : undefined;
  if (dockerfilePath && !dockerfilePath.startsWith(`${path.resolve(contextDir)}${path.sep}`))
    throw new Error(`Dockerfile escapes uploaded root for ${service}`);
  const dockerfile = dockerfilePath ? ['-f', dockerfilePath] : [];
  const fullContext = path.resolve(contextDir, buildPath);
  if (
    fullContext !== path.resolve(contextDir) &&
    !fullContext.startsWith(`${path.resolve(contextDir)}${path.sep}`)
  )
    throw new Error(`build context escapes uploaded root for ${service}`);
  if (!(await exists(fullContext)))
    throw new Error(`build context not found for ${service}: ${buildPath}`);
  await run('docker', ['build', ...dockerfile, '-t', imageRef, fullContext]);
}
