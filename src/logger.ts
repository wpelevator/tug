export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

const levelValue: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitiveKey =
  /(?:secret|token|password|passwd|credential|authorization|cookie|private.?key|api.?key|join.?key|error|\.key$)/i;
const validLevel = (value: string | undefined): LogLevel =>
  value && value in levelValue ? (value as LogLevel) : 'info';

function clean(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => clean(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          sensitiveKey.test(key) ? '[REDACTED]' : clean(item, depth + 1),
        ]),
    );
  }
  return String(value);
}

export interface LoggerOptions {
  component: string;
  format?: 'text' | 'json';
  level?: LogLevel;
  write?: (line: string, level: LogLevel) => void;
}

/** Remove common accidental credential disclosures from debug-only exception text. */
function sanitizeFailureMessage(message: string): string {
  const sanitized = message
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[PEM REDACTED]',
    )
    .replace(
      /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/gi,
      'authorization=[REDACTED]',
    )
    .replace(/\b(?:cookie|set-cookie)\s*:[^\r\n]*/gi, 'cookie=[REDACTED]')
    .replace(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|credentials?|password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (assignment) => `${assignment.slice(0, assignment.search(/[:=]/))}=[REDACTED]`,
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}…` : sanitized;
}

/** Create a logger whose messages are fixed descriptions and whose context is sanitized before output. */
export function createLogger(options: LoggerOptions) {
  const format = options.format ?? (process.env.TUG_LOG_FORMAT === 'json' ? 'json' : 'text');
  const threshold = levelValue[options.level ?? validLevel(process.env.TUG_LOG_LEVEL)];
  const write =
    options.write ??
    ((line: string, level: LogLevel) =>
      (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));

  const log = (level: LogLevel, message: string, context: LogContext = {}): void => {
    if (levelValue[level] < threshold) return;
    const safeContext = clean(context) as LogContext;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      component: options.component,
      message,
      ...Object.fromEntries(
        Object.entries(safeContext).filter(
          ([key]) => !['timestamp', 'level', 'component', 'message'].includes(key),
        ),
      ),
    };
    if (format === 'json') write(JSON.stringify(record), level);
    else {
      const details = Object.entries(record)
        .filter(([key]) => !['timestamp', 'level', 'component', 'message'].includes(key))
        .map(
          ([key, value]) =>
            `${key}=${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`,
        )
        .join(' ');
      write(
        `${level.toUpperCase()} ${options.component}: ${message}${details ? ` ${details}` : ''}`,
        level,
      );
    }
  };

  return {
    debug: (message: string, context?: LogContext) => log('debug', message, context),
    info: (message: string, context?: LogContext) => log('info', message, context),
    warn: (message: string, context?: LogContext) => log('warn', message, context),
    error: (message: string, context?: LogContext) => log('error', message, context),
    /**
     * Log safe classification at `level` and the sanitized cause only when debug logging is enabled.
     * Set `TUG_LOG_LEVEL=debug` to opt in. Sanitization covers common patterns; it cannot detect every secret.
     */
    failure: (
      message: string,
      error: unknown,
      context: LogContext = {},
      level: 'warn' | 'error' = 'error',
    ) => {
      log(level, message, { ...context, ...failureContext(error) });
      if (threshold <= levelValue.debug) {
        const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
        const detail = typeof value.message === 'string' ? value.message : String(error);
        log('debug', 'failure cause', {
          ...context,
          failureEvent: message,
          cause: sanitizeFailureMessage(detail),
        });
      }
    },
  };
}

export const logger = createLogger({ component: 'tug' });

/** Preserve actionable failure categories without serializing arbitrary exception messages. */
export function failureContext(error: unknown): LogContext {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const classes = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'AbortError',
    'TimeoutError',
    'DbError',
  ]);
  const codes = new Set([
    'ENOSPC',
    'EACCES',
    'EPERM',
    'EIO',
    'ENOENT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ERR_SQLITE_ERROR',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ABORT_ERR',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  return {
    failureClass: typeof value.name === 'string' && classes.has(value.name) ? value.name : 'Error',
    failureCode: typeof value.code === 'string' && codes.has(value.code) ? value.code : 'UNKNOWN',
    ...(typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status < 600
      ? { httpStatus: value.status }
      : {}),
    ...(typeof value.errcode === 'number' && Number.isSafeInteger(value.errcode)
      ? { sqliteCode: value.errcode }
      : {}),
  };
}
