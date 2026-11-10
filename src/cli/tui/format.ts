import { clipToColumns, columnWidth } from '../width.ts';
import type { Tone } from './types.ts';

export { sanitizeTerminalText as sanitize } from '../width.ts';

/** "3s", "12m", "2h", "3d": the largest whole unit, for a table cell. */
export function ageOf(iso: string | null | undefined, now: number): string {
  if (!iso) return '-';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '-';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Whole seconds between an ISO time and `now`, or undefined for a missing or invalid time. */
export function secondsSince(iso: string | null | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  return Number.isFinite(then) ? Math.max(0, Math.round((now - then) / 1000)) : undefined;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024 ** 2) return `${Math.ceil(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** `text` padded with spaces to `width` terminal columns, clipped with an ellipsis when longer. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const clipped = clipToColumns(text, width);
  return clipped + ' '.repeat(Math.max(0, width - columnWidth(clipped)));
}

/** Colour and emphasis, or nothing at all: state is always also carried by a word or symbol. */
export interface Style {
  tone(tone: Tone | undefined, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  inverse(text: string): string;
  enabled: boolean;
}
export function createStyle(enabled: boolean): Style {
  const wrap = (open: string, close: string) => (text: string) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  const red = wrap('31', '39');
  const yellow = wrap('33', '39');
  const green = wrap('32', '39');
  const dim = wrap('2', '22');
  return {
    enabled,
    bold: wrap('1', '22'),
    dim,
    inverse: wrap('7', '27'),
    tone: (tone, text) =>
      tone === 'error'
        ? red(text)
        : tone === 'warn'
          ? yellow(text)
          : tone === 'ok'
            ? green(text)
            : tone === 'dim'
              ? dim(text)
              : text,
  };
}

/** Whether colour should be on: a terminal, and `NO_COLOR` not set to anything (https://no-color.org). */
export const wantsColor = (isTTY: boolean | undefined, env: NodeJS.ProcessEnv): boolean =>
  Boolean(isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
