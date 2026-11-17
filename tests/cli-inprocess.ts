import { Readable } from 'node:stream';
/** What `promisify(execFile)` resolves with, so tests written against a child process keep their assertions. */
export interface CliResult {
  stdout: string;
  stderr: string;
}
export interface CliFailure extends Error, CliResult {
  code: number;
}
export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Piped to the command's stdin (not a terminal). Without it stdin is empty, as with `< /dev/null`. */
  input?: string;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `tug <args>` inside this test process instead of starting node for it, which costs about half a second per
 * call. It swaps process.env, the working directory and stdout and stderr for the duration of the run, so calls are
 * serialized. Resolves like a promisified `execFile` and rejects with `code`, `stdout` and `stderr` on a non-zero
 * exit. Use a real child process (see tests/cli-process.ts) only for what in-process cannot show: signals, a
 * terminal, piped stdin, process exit and the built `dist` entry.
 */
export function execCli(args: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  const run = queue.then(() => runOnce(args, options));
  queue = run.catch(() => undefined);
  return run;
}

async function runOnce(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const { runCli } = await import('../src/cli/program.ts');
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedExitCode = process.exitCode;
  const out: string[] = [];
  const err: string[] = [];
  const capture =
    (chunks: string[]) =>
    (chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      const callback = rest.find((value) => typeof value === 'function') as
        (() => void) | undefined;
      callback?.();
      return true;
    };
  const realExit = process.exit;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    value: Readable.from(options.input === undefined ? [] : [options.input]),
    configurable: true,
  });
  const { write: outWrite } = process.stdout;
  const { write: errWrite } = process.stderr;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, options.env ?? savedEnv);
  if (options.cwd) process.chdir(options.cwd);
  process.stdout.write = capture(out) as typeof process.stdout.write;
  process.stderr.write = capture(err) as typeof process.stderr.write;
  // A command that calls process.exit must end this call, not the test runner.
  class Exit extends Error {
    status: number;
    constructor(status: number) {
      super(`process.exit(${status})`);
      this.status = status;
    }
  }
  process.exit = ((status?: number) => {
    throw new Exit(status ?? Number(process.exitCode ?? 0));
  }) as typeof process.exit;
  let code: number;
  try {
    code = await runCli(args).catch((e: unknown) => {
      if (e instanceof Exit) return e.status;
      throw e;
    });
  } finally {
    process.exit = realExit;
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.exitCode = savedExitCode;
  }
  const result = { stdout: out.join(''), stderr: err.join('') };
  if (code === 0) return result;
  throw Object.assign(new Error(`tug ${args.join(' ')} exited ${code}\n${result.stderr}`), result, {
    code,
  });
}

/** A command line for the failing-argument tests: the exit code and both streams, whether or not it succeeded. */
export async function cliOutcome(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult & { code: number }> {
  try {
    return { ...(await execCli(args, options)), code: 0 };
  } catch (e) {
    const failure = e as CliFailure;
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}
