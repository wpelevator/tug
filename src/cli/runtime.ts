import type { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import type { ResolvedCliConfig } from './config.ts';
import type { Progress } from './progress.ts';

// The CLI's boundary with the process it runs in. Everything in src/cli that would otherwise read `process.env`,
// `process.cwd()`, `process.stdin/stdout/stderr`, `console`, a process signal or `process.exitCode` receives a
// `CliRuntime` instead. `tug` builds one from the real process (`processRuntime`); tests build one from plain objects
// (`tests/cli-inprocess.ts`), so a command runs in-process, in parallel with others, without patching any global.
// ESLint (eslint.config.js) rejects the ambient forms in src/cli outside this file and the entry point.

/** A readable stream that may be a terminal. */
export interface CliInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  ref?(): unknown;
  unref?(): unknown;
}

/** A writable stream that may be a terminal. */
export interface CliOutput extends Writable {
  isTTY?: boolean;
  columns?: number;
}

/**
 * What one run of the CLI remembers. It lives on the runtime, so two runs never share it and nothing needs resetting
 * between them.
 */
export interface CliState {
  /** `--verbose` or `TUG_VERBOSE=1`: stream the output of quiet steps. */
  verbose: boolean;
  /** Set once a command begins real work; an error after that is not a usage mistake (no `--help` footer). */
  workStarted: boolean;
  /** The configuration the root `preAction` hook resolved for this run. */
  config?: ResolvedCliConfig;
  /** Controls whose version agreement was already checked in this run (base, trusted CA mark and address override). */
  versionChecked: Set<string>;
  /** The innermost running progress display, so a prompt can pause it. */
  progress?: Progress;
}

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: CliInput;
  stdout: CliOutput;
  stderr: CliOutput;
  /** True when the streams are this process's own, so child processes may inherit them instead of being piped. */
  inheritStdio: boolean;
  /** The version this CLI reports and compares against the control's. */
  version: string;
  /** Process signals and exit, which a command subscribes to for cleanup; a test runtime has its own emitter. */
  signals: EventEmitter;
  /** Sends the signal to this process, for a handler that restored the terminal and now lets the signal act. */
  raise(signal: NodeJS.Signals): void;
  /**
   * Answers whether a registry image exists, as `docker manifest inspect` would. Unset runs that command with this
   * run's environment; a test runtime sets it so no test depends on the registry or on which release is published.
   */
  inspectImage?: (image: string) => { status: number | null; stderr: string };
  /** The exit code a command asked for; the entry point applies it. Unset means success. */
  exitCode?: number;
  state: CliState;
}

export const isVerboseEnv = (env: NodeJS.ProcessEnv): boolean =>
  ['1', 'true'].includes(env.TUG_VERBOSE ?? '');

export const freshState = (env: NodeJS.ProcessEnv): CliState => ({
  verbose: isVerboseEnv(env),
  workStarted: false,
  versionChecked: new Set(),
});

/** The runtime of the real process. */
export function processRuntime(version: string): CliRuntime {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    inheritStdio: true,
    version,
    signals: process,
    raise: (signal) => void process.kill(process.pid, signal),
    state: freshState(process.env),
  };
}

/** Writes a line to stdout, formatted like `console.log`. */
export function out(rt: CliRuntime, ...args: unknown[]): void {
  rt.stdout.write(`${format(...args)}\n`);
}

/** Writes a line to stderr, formatted like `console.error`. */
export function err(rt: CliRuntime, ...args: unknown[]): void {
  rt.stderr.write(`${format(...args)}\n`);
}

/** The user's home directory according to this run's environment. */
export function homeDir(rt: CliRuntime): string {
  return rt.env.HOME || rt.env.USERPROFILE || os.homedir();
}

/** A path from the command line, resolved against this run's working directory like a shell would. */
export function resolvePath(rt: CliRuntime, file: string): string {
  return path.resolve(rt.cwd, file);
}

/** Records that real work started, so a later error does not point at `--help`. */
export function markWorkStarted(rt: CliRuntime): void {
  rt.state.workStarted = true;
}
