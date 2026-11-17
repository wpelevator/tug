import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { RUN_OUTPUT_LIMIT } from '../images/build.ts';
import { suspendProgress } from './progress.ts';
import { markWorkStarted } from './runtime.ts';
import type { CliRuntime } from './runtime.ts';

const HOST_KEY_FAILED = /Host key verification failed/i;

/** The host an `ssh` or `scp` call connects to: the first operand after `--`, without `user@` and `:path`. */
function sshHost(cmd: string, args: string[]): string | undefined {
  const rest = args.slice(args.indexOf('--') + 1);
  const operand = cmd === 'scp' ? rest.find((a) => a.includes(':')) : rest[0];
  if (!operand) return undefined;
  const host = operand.slice(operand.lastIndexOf('@') + 1);
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  return bracketed ? bracketed[1] : cmd === 'scp' ? host.split(':')[0] : host;
}

/**
 * What to tell the operator when ssh or scp ended with `Host key verification failed`, which is OpenSSH refusing the
 * host and not a network failure: usually a stale `~/.ssh/known_hosts` entry left by a provider that reused the IP
 * for a new server, or an unknown host when there is no terminal to ask on. Undefined for any other output.
 * tug never edits `known_hosts` or loosens host key checking; removing the entry is the operator's decision.
 */
export function sshHostKeyHint(cmd: string, args: string[], output: string): string | undefined {
  if ((cmd !== 'ssh' && cmd !== 'scp') || !HOST_KEY_FAILED.test(output)) return undefined;
  const host = sshHost(cmd, args) ?? '<host>';
  return [
    `ssh refused ${host} because it could not verify the host key; the connection itself did not fail.`,
    `Either ~/.ssh/known_hosts holds an entry for ${host} with a different key (common when a provider reuses an IP for a new server), or ${host} is not in known_hosts and there was no terminal to ask on.`,
    `If you expect a new key, for example because you rebuilt the server, remove the stale entry with \`ssh-keygen -R ${host}\` and run the command again. For an unknown host, connect once with \`ssh ${host}\`, check the fingerprint and accept it.`,
    'tug never edits known_hosts or turns off host key checking for you.',
  ].join('\n');
}

/** An ssh or scp step that OpenSSH refused over the host key, so callers can pass it on instead of describing it as a missing installation. */
export class SshHostKeyError extends Error {}

/** The error for a failed ssh or scp step: an `SshHostKeyError` carrying the explanation when the output shows a host key failure. */
function sshFailure(message: string, cmd: string, args: string[], output: string): Error {
  const hint = sshHostKeyHint(cmd, args, output);
  return hint ? new SshHostKeyError(`${message}\n${hint}`) : new Error(message);
}

/** Keep the event loop free for progress timers during SSH, Docker and file transfers. */
export function runProcess(
  rt: CliRuntime,
  cmd: string,
  args: string[],
  { capture = false, input }: { capture?: boolean; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  markWorkStarted(rt);
  // ssh and scp may prompt on the terminal even when their output is captured.
  const mayPrompt = Boolean(rt.stdin.isTTY) && (cmd === 'ssh' || cmd === 'scp');
  const resume = capture && !mayPrompt ? () => {} : suspendProgress(rt);
  const mirror = !capture && (cmd === 'ssh' || cmd === 'scp');
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      // Output goes straight to this process's terminal only when the runtime's streams are the real ones;
      // otherwise it is piped and forwarded, so an in-process run captures it like any other output.
      const through = rt.inheritStdio ? 'inherit' : 'pipe';
      const child = spawn(cmd, args, {
        env: rt.env,
        cwd: rt.cwd,
        stdio: [
          input === undefined ? (rt.inheritStdio ? 'inherit' : 'ignore') : 'pipe',
          capture ? 'pipe' : through,
          // ssh and scp stderr is mirrored to the terminal and kept, so a failure can be explained.
          capture || mirror ? 'pipe' : through,
        ],
      });
      if (!capture && !rt.inheritStdio) child.stdout?.on('data', (chunk) => rt.stdout.write(chunk));
      if (!capture && !mirror && !rt.inheritStdio)
        child.stderr?.on('data', (chunk) => rt.stderr.write(chunk));
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + String(chunk)).slice(-RUN_OUTPUT_LIMIT);
      });
      child.stderr?.on('data', (chunk) => {
        if (mirror) rt.stderr.write(chunk);
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

export async function runLocal(rt: CliRuntime, cmd: string, args: string[]): Promise<void> {
  const result = await runProcess(rt, cmd, args);
  if (result.status !== 0)
    throw sshFailure(`${cmd} failed (exit ${result.status})`, cmd, args, result.stderr);
}

export async function runCapture(
  rt: CliRuntime,
  cmd: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<string> {
  const result = await runProcess(rt, cmd, args, { ...opts, capture: true });
  if (result.status !== 0)
    throw sshFailure(
      `${cmd} failed (exit ${result.status})\n${result.stderr}`,
      cmd,
      args,
      result.stderr,
    );
  return result.stdout;
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
  rt: CliRuntime,
  cmd: string,
  args: string[],
  { progress, input }: { progress?: StepProgress; input?: string } = {},
): Promise<void> {
  markWorkStarted(rt);
  const tail: string[] = [];
  // ssh and scp may ask for a password or passphrase on the terminal, which a redrawn status line would wipe: keep the
  // line off the screen until the step produces its first output.
  const mayPrompt = Boolean(rt.stdin.isTTY) && (cmd === 'ssh' || cmd === 'scp');
  let resumed = !mayPrompt;
  const resume = () => {
    if (resumed) return;
    resumed = true;
    progress?.resume?.();
  };
  if (mayPrompt) progress?.suspend?.();
  const emit = (text: string) =>
    progress?.print ? progress.print(text) : void rt.stderr.write(`${text}\n`);
  const child = spawn(cmd, args, {
    env: rt.env,
    cwd: rt.cwd,
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
      if (rt.state.verbose) emit(text);
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
    throw sshFailure(
      `${cmd} failed (exit ${status})${rt.state.verbose || !tail.length ? '' : `\n${tail.join('\n')}`}`,
      cmd,
      args,
      tail.join('\n'),
    );
}
