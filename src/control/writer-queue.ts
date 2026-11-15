export const WRITER_OVERDUE_AFTER_MS = 35 * 60 * 1000;

export function createWriterQueue(now: () => number = Date.now) {
  let tail = Promise.resolve();
  let activeSince: number | null = null;

  return {
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      activeSince = now();
      try {
        return await operation();
      } finally {
        activeSince = null;
        release();
      }
    },
    activeForMs(): number | null {
      return activeSince === null ? null : now() - activeSince;
    },
  };
}
