/** Where a live (terminal) status line is drawn. */
export interface LiveOutput {
  write(text: string): void;
  columns(): number;
}

const CLEAR_LINE = '\r\x1b[K';

/** A single rewritten status line only makes sense on an interactive stderr outside CI. */
function terminalOutput(): LiveOutput | undefined {
  if (!process.stderr.isTTY || process.env.CI) return undefined;
  return {
    write: (text) => void process.stderr.write(text),
    columns: () => process.stderr.columns || 80,
  };
}

/**
 * Progress on stderr, so stdout results stay clean. On a terminal it is one live line, `[12s] label · latest output`, and a
 * finished stage stays behind as `[Ns] label`. Without a terminal (or in CI) it prints a line per stage plus an elapsed-time
 * heartbeat, which reads well in logs.
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
  let timer: ReturnType<typeof setInterval> | undefined;
  const elapsed = () => `[${Math.floor((now() - started) / 1000)}s] ${label}`;
  const draw = () => {
    if (!live || paused || !label) return;
    const text = detail ? `${elapsed()} · ${detail}` : elapsed();
    const width = Math.max(20, live.columns() - 1);
    live.write(CLEAR_LINE + (text.length > width ? `${text.slice(0, width - 1)}…` : text));
  };
  const finish = () => {
    if (live && label && !paused) live.write(`${CLEAR_LINE}${elapsed()}\n`);
  };
  const report = () => (live ? draw() : write(elapsed()));
  return {
    stage(next: string) {
      if (next === label) return;
      finish();
      label = next;
      detail = '';
      started = now();
      if (live) draw();
      else report();
      if (!timer) {
        timer = setInterval(report, live ? 1000 : intervalMs);
        timer.unref();
      }
    },
    /** The latest output line of the running step, shown after the label on a terminal. */
    detail(line: string) {
      detail = line.trim();
      draw();
    },
    /** Lift the live line off the screen while another process writes to the terminal directly. */
    suspend() {
      if (live && !paused && label) live.write(CLEAR_LINE);
      paused = true;
    },
    resume() {
      paused = false;
      draw();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      finish();
      label = '';
    },
  };
}

export type Progress = ReturnType<typeof createProgress>;

let current: Progress | undefined;

/** Run a process that writes straight to the terminal without the live status line scribbling over it. */
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
  const progress = createProgress();
  const outer = current;
  current = progress;
  try {
    progress.stage(label);
    return await operation(progress);
  } finally {
    current = outer;
    progress.stop();
  }
}
