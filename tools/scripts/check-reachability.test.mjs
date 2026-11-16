import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReachability } from './check-reachability.mjs';

test('probe reports HTTP success and failure without following redirects', async () => {
  const calls = [];
  const results = await checkReachability(
    ['https://service.test/health?token=hidden', 'https://service.test/redirect'],
    {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return new Response(null, { status: url.pathname.endsWith('health') ? 204 : 302 });
      },
    },
  );
  assert.deepEqual(
    results.map(({ ok, detail }) => ({ ok, detail })),
    [
      { ok: true, detail: 'HTTP 204' },
      { ok: false, detail: 'HTTP 302' },
    ],
    'only successful 2xx responses pass',
  );
  assert.equal(calls[0].options.redirect, 'manual', 'probe does not follow redirects');
  assert.doesNotMatch(results[0].url, /hidden/, 'printed URL omits query strings');
});

test('probe bounds time and redacts request failures', async () => {
  const results = await checkReachability(['https://service.test/health'], {
    timeoutMs: 4,
    fetchImpl: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal, 'timeout signal is supplied');
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    },
  });
  assert.deepEqual(
    results[0],
    {
      url: 'https://service.test/health',
      ok: false,
      detail: 'timeout after 4ms',
    },
    'probe returns bounded status without leaking error details',
  );
});
