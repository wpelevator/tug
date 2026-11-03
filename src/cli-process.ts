import { spawn } from 'node:child_process';
import { RUN_OUTPUT_LIMIT } from './build.ts';

/** Keep the event loop free for progress timers during SSH, Docker and file transfers. */
export function runProcess(
  cmd: string,
  args: string[],
  { capture = false, input }: { capture?: boolean; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [
        input === undefined ? 'inherit' : 'pipe',
        capture ? 'pipe' : 'inherit',
        capture ? 'pipe' : 'inherit',
      ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-RUN_OUTPUT_LIMIT);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-RUN_OUTPUT_LIMIT);
    });
    child.on('error', reject);
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    if (input !== undefined) child.stdin?.end(input);
    child.on('close', (status, signal) => {
      if (signal) reject(new Error(`${cmd} terminated by ${signal}`));
      else resolve({ status, stdout, stderr });
    });
  });
}

export async function runLocal(cmd: string, args: string[]): Promise<void> {
  const result = await runProcess(cmd, args);
  if (result.status !== 0) throw new Error(`${cmd} failed (exit ${result.status})`);
}

export async function runCapture(
  cmd: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<string> {
  const result = await runProcess(cmd, args, { ...opts, capture: true });
  if (result.status !== 0)
    throw new Error(`${cmd} failed (exit ${result.status})\n${result.stderr}`);
  return result.stdout;
}
