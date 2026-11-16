import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReachability } from './check-reachability.mjs';

test('probe reports HTTP success and failure when a redirect has no Location header', async () => {
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
    'only successful 2xx responses pass when no redirect target is supplied',
  );
  assert.equal(calls[0].options.redirect, 'manual', 'probe handles redirect policy itself');
  assert.doesNotMatch(results[0].url, /hidden/, 'printed URL omits query strings');
});

test('probe follows bounded same-host redirects, including HTTP to HTTPS', async () => {
  const calls = [];
  const bodiesCancelled = [];
  const results = await checkReachability(['http://service.test/start?secret=hidden'], {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const body =
        calls.length < 3
          ? new ReadableStream({
              cancel() {
                bodiesCancelled.push(calls.length);
              },
            })
          : null;
      return new Response(body, {
        status: calls.length < 3 ? 302 : 204,
        headers:
          calls.length === 1
            ? { location: '/secure?secret=hidden' }
            : calls.length === 2
              ? { location: 'https://service.test/ready' }
              : undefined,
      });
    },
  });
  assert.equal(results[0].ok, true, 'a same-host redirect chain ending in 2xx is reachable');
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      'http://service.test/start?secret=hidden',
      'http://service.test/secure?secret=hidden',
      'https://service.test/ready',
    ],
    'relative and HTTP-to-HTTPS same-host redirects are followed',
  );
  assert.ok(
    calls.every(({ options }) => options.redirect === 'manual'),
    'each redirect response is handled explicitly',
  );
  assert.ok(
    calls.every(({ options }) => options.signal === calls[0].options.signal),
    'the redirect chain shares one timeout signal',
  );
  assert.deepEqual(
    bodiesCancelled,
    [1, 2],
    'each redirect response body is canceled before continuing',
  );
  assert.doesNotMatch(results[0].url, /hidden/, 'reported URL omits query strings');
});

test('probe rejects cross-host redirects without requesting or printing the target', async () => {
  const calls = [];
  const results = await checkReachability(['https://service.test/health?token=hidden'], {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://outside.test/collect?token=hidden' },
      });
    },
  });
  assert.deepEqual(
    calls,
    ['https://service.test/health?token=hidden'],
    'external host is not fetched',
  );
  assert.deepEqual(
    results[0],
    {
      url: 'https://service.test/health',
      ok: false,
      detail: 'redirect to another host',
    },
    'cross-host redirect failure does not expose either query string',
  );
});

test('probe rejects a redirect to a different port on the same hostname', async () => {
  const calls = [];
  const results = await checkReachability(['https://service.test/health'], {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://service.test:8443/health' },
      });
    },
  });
  assert.equal(calls.length, 1, 'probe does not request a different port');
  assert.equal(results[0].detail, 'redirect to another host', 'port change is rejected safely');
});

test('probe stops redirect loops after five hops', async () => {
  let calls = 0;
  const results = await checkReachability(['https://service.test/loop'], {
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: '/loop' },
      });
    },
  });
  assert.equal(calls, 6, 'probe makes the initial request plus at most five redirect hops');
  assert.equal(results[0].ok, false, 'a redirect loop is not considered reachable');
  assert.equal(results[0].detail, 'too many redirects', 'redirect limit has a safe detail');
});

test('probe rejects embedded credentials before making a request', async () => {
  let calls = 0;
  const results = await checkReachability(['https://user:secret@service.test/health'], {
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(calls, 0, 'credentialed URL is not requested');
  assert.deepEqual(
    results[0],
    { url: 'https://service.test/health', ok: false, detail: 'invalid HTTP URL' },
    'credential rejection does not reveal embedded credentials',
  );
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

test('probe rejects HTTPS downgrade redirects', async () => {
  let calls = 0;
  const [result] = await checkReachability(['https://site.test/health'], {
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'http://site.test/health' } });
    },
  });
  assert.equal(
    result.ok,
    false,
    'a successful TLS connection cannot authorize an insecure redirect',
  );
  assert.equal(calls, 1, 'the downgraded URL is never requested');
});
