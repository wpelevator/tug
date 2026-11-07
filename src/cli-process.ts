import { spawn } from 'node:child_process';
import { RUN_OUTPUT_LIMIT } from './build.ts';
import { suspendProgress } from './cli-progress.ts';

/** Keep the event loop free for progress timers during SSH, Docker and file transfers. */
export function runProcess(
  cmd: string,
  args: string[],
  { capture = false, input }: { capture?: boolean; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const resume = capture ? () => {} : suspendProgress();
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
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
    },
  ).finally(resume);
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

let verbose = ['1', 'true'].includes(process.env.TUG_VERBOSE ?? '');
/** `--verbose` (or `TUG_VERBOSE=1`): stream the output of quiet steps instead of keeping it for failures. */
export function setVerbose(value: boolean): void {
  verbose = value || verbose;
}

/** A line a script prints to start a named stage of its work: `::tug:: Pulling the image`. */
export const STAGE_MARKER = '::tug:: ';
const TAIL_LINES = 40;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export interface StepProgress {
  stage(label: string): void;
  detail?(line: string): void;
}

/**
 * Run a long step, such as a script over SSH or an image build, without flooding the terminal: its output is not
 * shown while it works. `::tug::` marker lines become progress stages, other lines feed the live status line, and a
 * failure reports the last lines it printed. With `--verbose` every line is streamed as it arrives.
 */
export async function runStep(
  cmd: string,
  args: string[],
  { progress, input }: { progress?: StepProgress; input?: string } = {},
): Promise<void> {
  const tail: string[] = [];
  const child = spawn(cmd, args, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const lines = (stream: NodeJS.ReadableStream) => {
    let pending = '';
    const take = (line: string) => {
      const text = line.replace(ANSI, '').trimEnd();
      if (!text) return;
      if (text.startsWith(STAGE_MARKER)) return progress?.stage(text.slice(STAGE_MARKER.length));
      if (verbose) process.stderr.write(`${text}\n`);
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      progress?.detail?.(text);
    };
    stream.on('data', (chunk) => {
      // Docker redraws progress with carriage returns, which count as line ends here.
      const parts = (pending + String(chunk)).split(/\r\n|\r|\n/);
      pending = parts.pop() ?? '';
      parts.forEach(take);
    });
    stream.on('end', () => take(pending));
  };
  lines(child.stdout!);
  lines(child.stderr!);
  child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') child.emit('error', error);
  });
  if (input !== undefined) child.stdin?.end(input);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) reject(new Error(`${cmd} terminated by ${signal}`));
      else resolve(code);
    });
  });
  if (status !== 0)
    throw new Error(
      `${cmd} failed (exit ${status})${verbose || !tail.length ? '' : `\n${tail.join('\n')}`}`,
    );
}
