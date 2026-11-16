export const WRITER_OVERDUE_AFTER_MS = 35 * 60 * 1000;

export function createWriterQueue(now: () => number = Date.now, maxPending = 100) {
  let tail = Promise.resolve();
  let activeSince: number | null = null;
  let pending = 0;

  return {
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      if (pending >= maxPending)
        throw Object.assign(new Error('control writer queue is full; retry later'), {
          status: 503,
          retryAfter: 5,
        });
      pending++;
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      pending--;
      activeSince = now();
      try {
        return await operation();
      } finally {
        activeSince = null;
        release();
      }
    },
    get pending(): number {
      return pending;
    },
    activeForMs(): number | null {
      return activeSince === null ? null : now() - activeSince;
    },
  };
}
