import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { RUN_OUTPUT_LIMIT } from '../images/build.ts';
import { suspendProgress } from './progress.ts';
import { markWorkStarted } from './usage.ts';

/** Keep the event loop free for progress timers during SSH, Docker and file transfers. */
export function runProcess(
  cmd: string,
  args: string[],
  { capture = false, input }: { capture?: boolean; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  markWorkStarted();
  // ssh and scp may prompt on the terminal even when their output is captured.
  const mayPrompt = Boolean(process.stdin.isTTY) && (cmd === 'ssh' || cmd === 'scp');
  const resume = capture && !mayPrompt ? () => {} : suspendProgress();
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
  verbose = value;
}

/**
 * A line a script prints to start a named stage of its work: `::tug:1a2b3c4d5e6f:: Pulling the image`. The random part is
 * chosen per run and only the scripts this CLI sends know it, so output of the programs they run cannot spoof a stage.
 */
export const STAGE_MARKER = `::tug:${randomBytes(6).toString('hex')}:: `;
const TAIL_LINES = 40;
/** A step that prints without ever ending a line must not grow memory without bound. */
const MAX_LINE = 4096;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export interface StepProgress {
  stage(label: string): void;
  detail?(line: string): void;
  /** Print a line above the live status line (used by `--verbose`). */
  print?(line: string): void;
  suspend?(): void;
  resume?(): void;
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
  markWorkStarted();
  const tail: string[] = [];
  // ssh and scp may ask for a password or passphrase on the terminal, which a redrawn status line would wipe: keep the
  // line off the screen until the step produces its first output.
  const mayPrompt = Boolean(process.stdin.isTTY) && (cmd === 'ssh' || cmd === 'scp');
  let resumed = !mayPrompt;
  const resume = () => {
    if (resumed) return;
    resumed = true;
    progress?.resume?.();
  };
  if (mayPrompt) progress?.suspend?.();
  const emit = (text: string) =>
    progress?.print ? progress.print(text) : void process.stderr.write(`${text}\n`);
  const child = spawn(cmd, args, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const lines = (stream: NodeJS.ReadableStream) => {
    stream.setEncoding('utf8');
    let pending = '';
    const take = (line: string) => {
      const text = line.replace(ANSI, '').trimEnd().slice(0, MAX_LINE);
      if (!text) return;
      resume();
      if (text.startsWith(STAGE_MARKER)) return progress?.stage(text.slice(STAGE_MARKER.length));
      if (verbose) emit(text);
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      progress?.detail?.(text);
    };
    stream.on('data', (chunk) => {
      // Docker redraws progress with carriage returns, which count as line ends here.
      const parts = (pending + String(chunk)).split(/\r\n|\r|\n/);
      pending = (parts.pop() ?? '').slice(-MAX_LINE);
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
      resume();
      if (signal) reject(new Error(`${cmd} terminated by ${signal}`));
      else resolve(code);
    });
  });
  if (status !== 0)
    throw new Error(
      `${cmd} failed (exit ${status})${verbose || !tail.length ? '' : `\n${tail.join('\n')}`}`,
    );
}
