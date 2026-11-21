import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createWebhookNotifier,
  sanitizeNotificationEvent,
  validateWebhookUrl,
  webhookOptionsFromEnv,
} from './notifications.ts';

const baseEvent = {
  id: 'ev-1',
  type: 'node.stale',
  level: 'warning',
  message: 'node n1 has stopped reporting',
  metadata_json: JSON.stringify({ project: 'alpha', access_token: 'secret-token' }),
  project_id: 'alpha',
  created_at: '2026-11-15T00:00:00.000Z',
};

test('webhook sends a signed minimal payload and omits arbitrary metadata', async () => {
  let request: RequestInit | undefined;
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test/ingest',
    secret: 'unit-test-secret',
    now: () => 1_800_000_123_000,
    fetch: async (_url, init) => {
      request = init;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(notifier.enqueue(baseEvent), true, 'new state transition enters the queue');
  await notifier.close();
  const body = String(request?.body);
  const timestamp = '1800000123';
  const expectedSignature = createHmac('sha256', 'unit-test-secret')
    .update(`${timestamp}.${body}`)
    .digest('hex');
  assert.equal(
    (request?.headers as Record<string, string>)['x-tug-webhook-signature'],
    `sha256=${expectedSignature}`,
    'signature authenticates the exact timestamp and body',
  );
  const wire = JSON.parse(body) as { event: Record<string, unknown> };
  assert.equal(wire.event.id, 'ev-1', 'delivery identifies the transition');
  assert.match(
    String(wire.event.message),
    /Check node connectivity/,
    'actionable guidance is included',
  );
  assert.equal('metadata_json' in wire.event, false, 'arbitrary metadata is never sent');
  assert.equal(
    'created_at' in wire.event,
    false,
    'only resource identifiers and guidance are sent',
  );
  assert.doesNotMatch(
    body,
    /secret-token|node n1 has stopped reporting/,
    'stored metadata and raw messages cannot leak',
  );
  assert.equal(request?.redirect, 'manual', 'destination redirects are not followed');
});

test('only whitelisted transitions send generic guidance and raw event messages are ignored', async () => {
  const sent: Record<string, unknown>[] = [];
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test',
    secret: 'secret',
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).event);
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(
    notifier.enqueue({
      ...baseEvent,
      id: 'job-1',
      type: 'job.run',
      message: 'ci ran a one-off web container on n1: tool --password=hunter2',
      metadata_json: JSON.stringify({
        node: 'n1',
        service: 'web',
        command: ['--password=hunter2'],
      }),
    }),
    false,
    'unapproved event types are rejected',
  );
  assert.equal(
    notifier.stats.dropped,
    0,
    'unsupported informational events are filtered without counting delivery loss',
  );
  notifier.enqueue({
    ...baseEvent,
    id: 'other-1',
    type: 'node.stale',
    message: 'ci: password=hunter2',
  });
  await notifier.close();
  assert.equal(sent.length, 1, 'one approved transition is sent');
  assert.match(String(sent[0].message), /Check node connectivity/, 'fixed guidance is sent');
  assert.doesNotMatch(
    JSON.stringify(sent),
    /hunter2|ci:/,
    'raw event messages and command secrets are absent',
  );
});

test('backup, restore, and ingress alerts are whitelisted with generic safe guidance', async () => {
  const sent: Record<string, unknown>[] = [];
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test',
    secret: 'secret',
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).event);
      return new Response(null, { status: 204 });
    },
  });
  for (const [index, type] of [
    'backup.failed',
    'restore.failed',
    'restore.completed',
    'ingress.failed',
  ].entries()) {
    notifier.enqueue({
      ...baseEvent,
      id: `safe-${index}`,
      type,
      message: 'database password=hunter2',
      metadata_json: '{"error":"token=private"}',
    });
  }
  await notifier.close();
  assert.equal(sent.length, 4, 'supported operational outcomes are delivered');
  assert.doesNotMatch(
    JSON.stringify(sent),
    /hunter2|private/,
    'error messages and metadata are never sent',
  );
  assert.ok(
    sent.every((event) => typeof event.message === 'string' && event.message.length > 0),
    'each alert has generic guidance',
  );
});

test('retries are bounded with capped exponential delays and duplicate transition IDs are ignored', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test',
    secret: 'secret',
    maxAttempts: 4,
    retryBaseMs: 10,
    retryMaxMs: 15,
    sleep: async (ms) => void delays.push(ms),
    fetch: async () => {
      attempts++;
      return new Response(null, { status: attempts < 4 ? 503 : 204 });
    },
  });
  assert.equal(notifier.enqueue(baseEvent), true, 'first transition is accepted');
  assert.equal(notifier.enqueue(baseEvent), false, 'same transition is deduplicated');
  await notifier.close();
  assert.equal(attempts, 4, 'delivery stops after eventual success');
  assert.deepEqual(delays, [10, 15, 15], 'backoff grows and stays within configured cap');
  assert.deepEqual(
    notifier.stats,
    { delivered: 1, failed: 0, dropped: 0, pending: 0 },
    'delivery counters reflect completion',
  );
});

test('request timeout aborts delivery, retries to the configured limit, and counts exhausted failures', async () => {
  let attempts = 0;
  const errors: string[] = [];
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test',
    secret: 'secret',
    timeoutMs: 2,
    maxAttempts: 2,
    retryBaseMs: 1,
    sleep: async () => {},
    onError: (eventId) => errors.push(eventId),
    fetch: async (_url, init) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    },
  });
  notifier.enqueue(baseEvent);
  await notifier.close();
  assert.equal(attempts, 2, 'timeout retries stop at the configured attempt limit');
  assert.deepEqual(errors, ['ev-1'], 'failure hook receives only the event ID');
  assert.deepEqual(
    notifier.stats,
    { delivered: 0, failed: 1, dropped: 0, pending: 0 },
    'exhaustion is counted',
  );
});

test('queue overflow rejects immediately without waiting for an in-flight request', async () => {
  let releaseFetch!: () => void;
  const blockedFetch = new Promise<Response>((resolve) => {
    releaseFetch = () => resolve(new Response(null, { status: 204 }));
  });
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test',
    secret: 'secret',
    maxQueue: 1,
    fetch: async () => blockedFetch,
  });
  assert.equal(notifier.enqueue(baseEvent), true, 'first transition is accepted synchronously');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const startedAt = Date.now();
  assert.equal(
    notifier.enqueue({ ...baseEvent, id: 'ev-2' }),
    false,
    'full queue rejects new work',
  );
  assert.equal(notifier.stats.dropped, 1, 'queue overflow increments dropped count');
  assert.ok(Date.now() - startedAt < 100, 'enqueue does not wait for the network');
  releaseFetch();
  await notifier.close();
});

test('destination validation requires HTTPS except explicitly allowed loopback test URLs', () => {
  assert.throws(
    () => validateWebhookUrl('http://hooks.example.test'),
    /HTTPS/,
    'remote HTTP is rejected',
  );
  assert.throws(
    () => validateWebhookUrl('https://user:pass@example.test'),
    /credentials/,
    'URL credentials are rejected',
  );
  assert.equal(
    validateWebhookUrl('http://127.0.0.1:8080/hook', true).hostname,
    '127.0.0.1',
    'test loopback HTTP is injectable',
  );
  assert.throws(
    () => webhookOptionsFromEnv({ TUG_WEBHOOK_URL: 'https://hooks.test' }),
    /both/,
    'partial environment config fails clearly',
  );
});

test('shutdown aborts active delivery and discards queued work', async () => {
  let requests = 0;
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test',
    secret: 'secret',
    fetch: async (_url, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    },
  });
  notifier.enqueue({ ...baseEvent, id: 'shutdown-one' });
  notifier.enqueue({ ...baseEvent, id: 'shutdown-two' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  notifier.stop();
  notifier.stop(); // Server and process shutdown paths may both call it.
  await notifier.close();
  assert.equal(requests, 1, 'shutdown does not attempt waiting notifications');
  assert.equal(notifier.pending, 0, 'shutdown clears active and waiting work');
  assert.equal(notifier.stats.dropped, 2, 'shutdown reports discarded delivery work');
});

test('retention failure and recovery events are delivered as whitelisted transitions without their metadata', () => {
  for (const type of ['backup.retention_failed', 'backup.retention_recovered']) {
    const wire = sanitizeNotificationEvent({
      id: 'evt_1',
      type,
      project_id: 'site',
      metadata_json: JSON.stringify({ message: 'token=private' }),
    } as never);
    assert.ok(wire, `${type} should be delivered to webhooks`);
    assert.ok(wire.message.length > 0, `${type} should carry a generic message`);
    assert.ok(!('metadata_json' in wire), 'arbitrary metadata is never sent');
  }
});
