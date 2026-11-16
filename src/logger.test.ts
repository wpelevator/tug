import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from './logger.ts';

test('JSON logs include component, level and context while redacting sensitive keys recursively', () => {
  const lines: string[] = [];
  const logger = createLogger({
    component: 'agent',
    format: 'json',
    level: 'debug',
    write: (line) => lines.push(line),
  });
  logger.info('poll completed', {
    node: 'node-a',
    credential: { token: 'secret-token', nested: { password: 'secret-password' } },
    services: [{ name: 'web', authorization: 'Bearer abc' }],
  });

  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(record.component, 'agent', 'JSON logs identify their component');
  assert.equal(record.level, 'info', 'JSON logs include the selected severity');
  assert.equal(record.message, 'poll completed', 'JSON logs retain the fixed event message');
  assert.equal(record.node, 'node-a', 'JSON logs retain safe correlation fields');
  assert.deepEqual(record.credential, '[REDACTED]', 'credential values are redacted at any depth');
  assert.deepEqual(
    record.services,
    [{ name: 'web', authorization: '[REDACTED]' }],
    'sensitive keys inside arrays are redacted recursively',
  );
  assert.ok(typeof record.timestamp === 'string', 'JSON logs include an ISO timestamp');
});

test('logger suppresses messages below the configured level and emits readable text by default', () => {
  const lines: string[] = [];
  const logger = createLogger({
    component: 'control',
    level: 'warn',
    write: (line) => lines.push(line),
  });
  logger.info('startup complete');
  logger.warn('queue is busy', { depth: 3 });

  assert.equal(lines.length, 1, 'messages below the configured threshold are suppressed');
  assert.match(
    lines[0],
    /^WARN control: queue is busy depth=3$/,
    'text logs include level, component, message and context',
  );
});

test('logger redacts error context instead of serializing arbitrary error details', () => {
  const lines: string[] = [];
  const logger = createLogger({
    component: 'agent',
    format: 'json',
    write: (line) => lines.push(line),
  });
  logger.error('poll failed', { error: 'request included a one-time secret value' });

  assert.equal(
    (JSON.parse(lines[0]) as Record<string, unknown>).error,
    '[REDACTED]',
    'error details are redacted because they may contain credentials or request data',
  );
});

test('failure classifications retain safe diagnosis while excluding arbitrary exception details', async () => {
  const { failureContext } = await import('./logger.ts');
  const classified = failureContext(
    Object.assign(new Error('secret destination password'), { code: 'ENOSPC' }),
  );
  assert.deepEqual(
    classified,
    { failureClass: 'Error', failureCode: 'ENOSPC' },
    'disk exhaustion remains actionable without arbitrary text',
  );
  const unknown = failureContext({
    name: 'private-class',
    code: 'private-code',
    message: 'secret',
    status: 503,
  });
  assert.deepEqual(
    unknown,
    { failureClass: 'Error', failureCode: 'UNKNOWN', httpStatus: 503 },
    'unknown categories cannot leak private details',
  );
});

test('failure logs keep exception text hidden unless debug logging is enabled', () => {
  const normalLines: string[] = [];
  createLogger({
    component: 'agent',
    format: 'json',
    level: 'info',
    write: (line) => normalLines.push(line),
  }).failure(
    'poll failed',
    Object.assign(new Error('ECONNREFUSED at https://host/path'), { code: 'ECONNREFUSED' }),
    { node: 'node-a' },
  );

  assert.equal(normalLines.length, 1, 'normal logging emits only the safe failure classification');
  const normal = JSON.parse(normalLines[0]) as Record<string, unknown>;
  assert.equal(normal.failureCode, 'ECONNREFUSED', 'normal logs retain a useful safe error code');
  assert.equal(normal.node, 'node-a', 'normal logs retain supplied safe context');
  assert.equal(normal.cause, undefined, 'normal logs do not include exception text');

  const debugLines: string[] = [];
  const previousLevel = process.env.TUG_LOG_LEVEL;
  process.env.TUG_LOG_LEVEL = 'debug';
  try {
    createLogger({
      component: 'agent',
      format: 'json',
      write: (line) => debugLines.push(line),
    }).failure(
      'poll failed',
      new Error('connect ECONNREFUSED at https://user:pass@example.test/path'),
    );
  } finally {
    if (previousLevel === undefined) delete process.env.TUG_LOG_LEVEL;
    else process.env.TUG_LOG_LEVEL = previousLevel;
  }
  assert.equal(
    debugLines.length,
    2,
    'debug logging adds one cause record after safe classification',
  );
  const debug = JSON.parse(debugLines[1]) as Record<string, unknown>;
  assert.equal(debug.message, 'failure cause', 'debug cause has a fixed event message');
  assert.equal(
    debug.cause,
    'connect ECONNREFUSED at [URL REDACTED]',
    'debug causes remove URL contents',
  );
});

test('debug failure messages redact common credentials, PEM, controls, and excessive text', () => {
  const lines: string[] = [];
  createLogger({
    component: 'agent',
    format: 'json',
    level: 'debug',
    write: (line) => lines.push(line),
  }).failure(
    'operation failed',
    new Error(
      'authorization: Bearer abc cookie=choc-chip password="p a s s" client_secret=hidden\n' +
        '-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----\u0000' +
        'x'.repeat(600),
    ),
    {},
    'warn',
  );

  const detail = JSON.parse(lines[1]) as Record<string, unknown>;
  const cause = String(detail.cause);
  assert.doesNotMatch(
    cause,
    /Bearer abc|choc-chip|p a s s|hidden|private material/,
    'debug cause removes common credentials and PEM contents',
  );
  assert.match(cause, /authorization=\[REDACTED\]/, 'authorization assignments are redacted');
  assert.match(cause, /cookie=\[REDACTED\]/, 'cookie assignments are redacted');
  assert.match(cause, /password=\[REDACTED\]/, 'password assignments are redacted');
  assert.match(cause, /client_secret=\[REDACTED\]/, 'client secret assignments are redacted');
  assert.match(cause, /\[PEM REDACTED\]/, 'PEM blocks are redacted');
  assert.ok(
    [...cause].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    }),
    'debug causes contain no control characters',
  );
  assert.ok(cause.length <= 501, 'debug causes are bounded to 500 characters plus an ellipsis');
});

test('debug causes redact entire bearer credentials and cookie headers', () => {
  const output: string[] = [];
  const log = createLogger({
    component: 'test',
    format: 'json',
    level: 'debug',
    write: (line) => output.push(line),
  });
  log.failure(
    'request failed',
    new Error(
      'Authorization: Bearer very-private-value\nCookie: session=private-session; token=private-cookie',
    ),
  );
  assert.doesNotMatch(
    output.join('\n'),
    /very-private-value|private-session|private-cookie/,
    'known header formats must not expose trailing credential values',
  );
});
