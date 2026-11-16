#!/usr/bin/env node

function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid URL>';
  }
}

export async function checkReachability(urls, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const maxRedirects = 5;
  return Promise.all(
    urls.map(async (rawUrl) => {
      let url;
      try {
        url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
        if (url.username || url.password) throw new Error('credentials are not allowed');
      } catch {
        return { url: displayUrl(rawUrl), ok: false, detail: 'invalid HTTP URL' };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let redirects = 0;
        for (;;) {
          const response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          });
          const location = response.headers.get('location');
          const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
          if (!isRedirect || !location) {
            await response.body?.cancel();
            return {
              url: displayUrl(rawUrl),
              ok: response.status >= 200 && response.status < 300,
              detail: `HTTP ${response.status}`,
            };
          }

          await response.body?.cancel();
          if (redirects >= maxRedirects)
            return { url: displayUrl(rawUrl), ok: false, detail: 'too many redirects' };
          let next;
          try {
            next = new URL(location, url);
            if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password)
              throw new Error('invalid redirect');
          } catch {
            return { url: displayUrl(rawUrl), ok: false, detail: 'invalid redirect' };
          }
          if (url.protocol === 'https:' && next.protocol === 'http:')
            return { url: displayUrl(rawUrl), ok: false, detail: 'HTTPS downgrade redirect' };
          const sameDefaultHttpHost =
            !next.port &&
            !url.port &&
            ['http:', 'https:'].includes(next.protocol) &&
            ['http:', 'https:'].includes(url.protocol);
          const sameExplicitPort = next.port === url.port;
          if (next.hostname !== url.hostname || (!sameDefaultHttpHost && !sameExplicitPort))
            return { url: displayUrl(rawUrl), ok: false, detail: 'redirect to another host' };
          url = next;
          redirects++;
        }
      } catch (error) {
        return {
          url: displayUrl(rawUrl),
          ok: false,
          detail: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : 'request failed',
        };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
}

function configuredUrls(env) {
  const positional = process.argv.slice(2);
  const urls = positional.length ? positional : (env.TUG_PROBE_URLS ?? '').split(/[\n,]/);
  return urls.map((value) => value.trim()).filter(Boolean);
}

async function main() {
  const urls = configuredUrls(process.env);
  if (!urls.length) {
    console.error('Usage: node tools/scripts/check-reachability.mjs <url> [url ...]');
    console.error('Or set TUG_PROBE_URLS to comma or newline separated URLs.');
    process.exitCode = 2;
    return;
  }
  const parsedTimeout = Number(process.env.TUG_PROBE_TIMEOUT_MS ?? 5_000);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 5_000;
  const results = await checkReachability(urls, { timeoutMs });
  for (const result of results)
    console.log(`${result.ok ? 'OK' : 'FAIL'} ${result.url} ${result.detail}`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname
) {
  await main();
}
