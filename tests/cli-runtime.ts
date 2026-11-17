import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { packageVersion } from '../src/images/image.ts';
import { freshState } from '../src/cli/runtime.ts';
import type { CliInput, CliOutput, CliRuntime } from '../src/cli/runtime.ts';

export interface TestRuntimeOptions {
  /** The whole environment of the run; defaults to a copy of this process's. */
  env?: NodeJS.ProcessEnv;
  /** The working directory relative paths resolve against; defaults to this process's. */
  cwd?: string;
  /** Piped to stdin; without it stdin is empty, as with `< /dev/null`. */
  input?: string;
  /** The version the CLI reports; defaults to this package's. */
  version?: string;
  /**
   * Answers the registry lookup of the install commands; defaults to "published". The real lookup is false on the
   * commit that cuts a release, whose image builds minutes later, so a test must never reach it unless it says so.
   */
  inspectImage?: CliRuntime['inspectImage'];
  /** Present stdin and stdout as terminals. */
  tty?: boolean;
  columns?: number;
}

const sink = (chunks: string[], tty: boolean, columns: number): CliOutput => {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as CliOutput;
  if (tty) {
    stream.isTTY = true;
    stream.columns = columns;
  }
  return stream;
};

/**
 * A runtime made of plain objects, so a command runs in-process with its own environment, streams and signals and
 * nothing global is touched. Read what it wrote with `stdout()` and `stderr()`, and the exit code it asked for from
 * `rt.exitCode`.
 */
export function testRuntime(options: TestRuntimeOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env = options.env ?? { ...process.env };
  const stdin = Readable.from(options.input === undefined ? [] : [options.input]) as CliInput;
  if (options.tty) stdin.isTTY = true;
  const rt: CliRuntime = {
    env,
    cwd: options.cwd ?? process.cwd(),
    stdin,
    stdout: sink(out, Boolean(options.tty), options.columns ?? 100),
    stderr: sink(err, false, 100),
    inheritStdio: false,
    version: options.version ?? packageVersion(),
    inspectImage: options.inspectImage ?? (() => ({ status: 0, stderr: '' })),
    signals: new EventEmitter(),
    raise: () => {},
    state: freshState(env),
  };
  return { rt, stdout: () => out.join(''), stderr: () => err.join('') };
}
