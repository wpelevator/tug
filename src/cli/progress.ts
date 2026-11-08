import { clipToColumns, plainText } from './width.ts';
import { markWorkStarted } from './usage.ts';

/** Where a live (terminal) status line is drawn. */
export interface LiveOutput {
  write(text: string): void;
  columns(): number;
  /** Run `hook` around every other write to the terminal, so output never lands on the status line. Returns an undo. */
  intercept?(hook: { before(): void; after(endedLine: boolean): void }): () => void;
}

const CLEAR_LINE = '\r\x1b[K';

/** A single rewritten status line only makes sense on an interactive stderr outside CI. */
function terminalOutput(): LiveOutput | undefined {
  if (!process.stderr.isTTY || process.env.CI) return undefined;
  const raw = process.stderr.write.bind(process.stderr);
  return {
    write: (text) => void raw(text),
    columns: () => process.stderr.columns || 80,
    intercept(hook) {
      const restores = [process.stdout, process.stderr].map((stream) => {
        const original = stream.write;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          hook.before();
          try {
            return (original as (...a: unknown[]) => boolean).apply(stream, args);
          } finally {
            const chunk = args[0];
            const last =
              typeof chunk === 'string'
                ? chunk.at(-1)
                : chunk instanceof Uint8Array
                  ? chunk.at(-1)
                  : undefined;
            hook.after(last === '\n' || last === 10);
          }
        };
        stream.write = wrapped as typeof stream.write;
        return () => {
          if (stream.write === wrapped) stream.write = original;
        };
      });
      return () => restores.reverse().forEach((restore) => restore());
    },
  };
}

let current: ReturnType<typeof createProgress> | undefined;

/**
 * Progress on stderr, so stdout results stay clean. On a terminal it is one live line, `[12s] label · latest output`, and a
 * finished stage stays behind as `[Ns] label`; other output written meanwhile appears above it. Without a terminal (or in
 * CI) it prints a line per stage plus an elapsed-time heartbeat, which reads well in logs.
 */
export function createProgress({
  write = (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
  now = Date.now,
  intervalMs = 10_000,
  live = terminalOutput(),
}: {
  write?: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
  live?: LiveOutput;
} = {}) {
  let label = '';
  let detail = '';
  let started = now();
  let paused = false;
  let drawn = false;
  /** Another writer left a line unfinished: the status stays off the screen until a newline ends it. */
  let partial = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let undoIntercept: (() => void) | undefined;
  let outer: typeof current;
  const elapsed = () => `[${Math.floor((now() - started) / 1000)}s] ${label}`;
  const clear = () => {
    if (live && drawn) live.write(CLEAR_LINE);
    drawn = false;
  };
  const draw = () => {
    if (!live || paused || partial || !label) return;
    const text = detail ? `${elapsed()} · ${detail}` : elapsed();
    live.write(CLEAR_LINE + clipToColumns(text, Math.max(20, live.columns() - 1)));
    drawn = true;
  };
  const finish = () => {
    if (live && label && !paused) live.write(`${CLEAR_LINE}${elapsed()}\n`);
    drawn = false;
  };
  const report = () => (live ? draw() : write(elapsed()));
  const self = {
    stage(next: string) {
      if (next === label) return;
      finish();
      label = next;
      detail = '';
      started = now();
      if (!timer) {
        outer = current;
        current = self;
        timer = setInterval(report, live ? 1000 : intervalMs);
        timer.unref();
        undoIntercept = live?.intercept?.({
          before: clear,
          after: (endedLine) => {
            partial = !endedLine;
            draw();
          },
        });
      }
      if (live) draw();
      else report();
    },
    /** The latest output line of the running step, shown after the label on a terminal. */
    detail(line: string) {
      // Output of a remote host is shown as data: control characters must not reach the terminal.
      detail = plainText(line).trim();
      draw();
    },
    /** Print a line of output above the live line, which is then drawn again below it. */
    print(line: string) {
      if (live && !paused && label) {
        clear();
        live.write(`${line}\n`);
      } else write(line);
      draw();
    },
    /** Lift the live line off the screen while something else owns the terminal (a prompt, a menu, another process). */
    suspend() {
      clear();
      paused = true;
    },
    resume() {
      paused = false;
      draw();
    },
    stop() {
      clearInterval(timer);
      if (timer) {
        timer = undefined;
        if (current === self) current = outer;
      }
      undoIntercept?.();
      undoIntercept = undefined;
      finish();
      label = '';
    },
  };
  return self;
}

export type Progress = ReturnType<typeof createProgress>;

/** Run a process, prompt or menu that writes straight to the terminal without the live status line scribbling over it. */
export function suspendProgress(): () => void {
  const progress = current;
  progress?.suspend();
  return () => progress?.resume();
}

/** Own the timer for one operation, including failures and early returns. */
export async function withProgress<T>(
  label: string,
  operation: (progress: Progress) => Promise<T>,
): Promise<T> {
  markWorkStarted();
  const progress = createProgress();
  try {
    progress.stage(label);
    return await operation(progress);
  } finally {
    progress.stop();
  }
}
