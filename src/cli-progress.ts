/** Line-based stderr progress works in terminals and CI without changing stdout results. */
export function createProgress({
  write = (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
  now = Date.now,
  intervalMs = 10_000,
} = {}) {
  let label = '';
  let started = now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const report = () => write(`[${Math.floor((now() - started) / 1000)}s] ${label}`);
  return {
    stage(next: string) {
      if (next === label) return;
      label = next;
      started = now();
      report();
      if (!timer) {
        timer = setInterval(report, intervalMs);
        timer.unref();
      }
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Own the timer for one operation, including failures and early returns. */
export async function withProgress<T>(
  label: string,
  operation: (progress: ReturnType<typeof createProgress>) => Promise<T>,
): Promise<T> {
  const progress = createProgress();
  try {
    progress.stage(label);
    return await operation(progress);
  } finally {
    progress.stop();
  }
}
