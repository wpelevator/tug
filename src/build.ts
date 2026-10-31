import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { ensureDir, exists } from './util.ts';

export interface RunResult { out: string; err: string }
export interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv }
export interface BuildSpec { context?: string; dockerfile?: string }

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${out}\n${err}`)));
  });
}

export async function unpackContext(tarball: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await ensureDir(dest);
  await tar.x({ file: tarball, cwd: dest });
}

export interface BuildAndPushOptions { contextDir: string; service: string; buildSpec: string | BuildSpec; imageRef: string; push?: boolean }

export async function buildAndPush({ contextDir, service, buildSpec, imageRef, push = true }: BuildAndPushOptions): Promise<void> {
  const buildPath = typeof buildSpec === 'string' ? buildSpec : buildSpec?.context || '.';
  const dockerfile = typeof buildSpec === 'object' && buildSpec.dockerfile ? ['-f', path.join(contextDir, buildPath, buildSpec.dockerfile)] : [];
  const fullContext = path.resolve(contextDir, buildPath);
  if (!(await exists(fullContext))) throw new Error(`build context not found for ${service}: ${buildPath}`);
  await run('docker', ['build', ...dockerfile, '-t', imageRef, fullContext]);
  if (push) await run('docker', ['push', imageRef]);
}
