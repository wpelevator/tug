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
