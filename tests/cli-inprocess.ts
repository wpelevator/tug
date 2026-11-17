import { runCli } from '../src/cli/program.ts';
import { testRuntime } from './cli-runtime.ts';
import type { TestRuntimeOptions } from './cli-runtime.ts';

/** What `promisify(execFile)` resolves with, so tests written against a child process keep their assertions. */
export interface CliResult {
  stdout: string;
  stderr: string;
}
export interface CliFailure extends Error, CliResult {
  code: number;
}
export interface CliOptions extends TestRuntimeOptions {
  /** Milliseconds before the call is abandoned as hung; a leaked handle or a command waiting for input fails here. */
  timeout?: number;
}

/** Rejects with `Error(message)` when `work` has not settled within `ms`. */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `tug <args>` inside this test process instead of starting node for it, which costs about half a second per
 * call. The command gets a runtime of its own (tests/cli-runtime.ts): its environment, working directory, streams and
 * signals are plain objects, so nothing global is touched and calls may overlap. Resolves like a promisified
 * `execFile` and rejects with `code`, `stdout` and `stderr` on a non-zero exit. Use a real child process (see
 * tests/cli-process.ts) only for what in-process cannot show: signals, a terminal, a command that must exit while its
 * stdin stays open, and the built `dist` entry.
 */
export async function execCli(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const { rt, stdout, stderr } = testRuntime(options);
  const limit = options.timeout ?? 60_000;
  const code = await withDeadline(
    runCli(args, rt),
    limit,
    `tug ${args.join(' ')} did not finish within ${limit / 1000} s`,
  );
  const result = { stdout: stdout(), stderr: stderr() };
  if (code === 0) return result;
  throw Object.assign(new Error(`tug ${args.join(' ')} exited ${code}\n${result.stderr}`), result, {
    code,
  });
}

/** The exit code and both streams of a command, whether or not it succeeded, for tests of failing invocations. */
export async function cliOutcome(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult & { code: number }> {
  try {
    return { ...(await execCli(args, options)), code: 0 };
  } catch (e) {
    const failure = e as CliFailure;
    if (typeof failure.code !== 'number') throw e;
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}
