// Compose durations and sizes, shared by the operator-side reader (load.ts) and the agent's container definitions.

const UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
};

/** Compose durations (`30s`, `1m30s`, `500ms`) or a number of seconds, in milliseconds. */
export function composeDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value * 1000;
  if (typeof value !== 'string' || !value) return undefined;
  let total = 0;
  let rest = value;
  while (rest) {
    const m = rest.match(/^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/);
    if (!m) return undefined;
    total += Number(m[1]) * UNITS[m[2]];
    rest = rest.slice(m[0].length);
  }
  return total;
}

/** Compose sizes: bytes as a number, or `64m` / `1g` style strings. */
export function sizeBytes(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const m = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
  if (!m) return undefined;
  const power = { '': 0, k: 1, m: 2, g: 3, t: 4 }[m[2] as '' | 'k' | 'm' | 'g' | 't'];
  return Math.round(Number(m[1]) * 1024 ** power);
}

const trim = (n: number): string => String(Number(n.toFixed(9)));

/** A duration the way Compose renders it (Go's `time.Duration` text): `500ms`, `30s`, `1m30s`, `1h0m0s`. */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  if (ms < 1)
    return `${trim(ms * 1e6)}ns`.replace(/^(\d+)ns$/, (_all, ns) =>
      Number(ns) >= 1000 ? `${trim(Number(ns) / 1000)}µs` : `${ns}ns`,
    );
  if (ms < 1000) return `${trim(ms)}ms`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = (ms % 60_000) / 1000;
  return `${hours ? `${hours}h` : ''}${hours || minutes ? `${minutes}m` : ''}${trim(seconds)}s`;
}
