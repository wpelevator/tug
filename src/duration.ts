/** Parses `500ms` / `2s` / `1m` or a millisecond number; `fallback` when it does not parse. */
export function parseDuration(value: string | number, fallback = 2000): number {
  if (typeof value === 'number') return value;
  const m = String(value).match(/^(\d+)(ms|s|m)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60000 : m[2] === 'ms' ? n : n * 1000;
}
export const isDuration = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
  (typeof value === 'string' && /^\d+(ms|s|m)?$/.test(value));
