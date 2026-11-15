# Ingress edge features

**Status: partly built.** Items 1 and 2 below shipped. The rest is proposed, and the roadmap lists it under [Later](roadmap.md#later--only-if-needed). Current behavior and limits are in [Networking](../networking.md#edge-features).

## How the managed ingress compares

From each project's documentation. A blank means not confirmed, not no.

| Feature | Tug today | kamal-proxy | Uncloud (Caddy) | Traefik | Dokku (nginx) |
| --- | --- | --- | --- | --- | --- |
| Declared in | Typed `x-tug.ingress` | CLI flags, `proxy:` in `deploy.yml` | `x-ports`, raw `x-caddy` | Labels | Per-app `nginx:set` |
| Health-gated cutover and drain | Yes, for `rolling` services | Yes | Yes | No mechanism of its own | |
| Custom certificate from encrypted secrets | Yes | Yes | Partial | Partial | |
| Response timeout, max request body | No | Yes | No | Via middleware | Yes |
| Access logs, metrics | Yes (opt-in logs, metrics on loopback) | Yes | Logs | Yes | Logs |
| Compression, basic auth, redirects | No | No | Via raw Caddy | Yes | |
| Maintenance or error page | Fixed 503 text, `maintenance: true` | No | Partial | Yes | Yes |
| Rate limit, IP allowlist | No | No | No | Yes | |
| HTTP/3 | Yes (Caddy default, needs UDP 443 open) | | Yes | Yes | |
| On-demand TLS, DNS-01 wildcards | No | On-demand yes | Partial | DNS-01 yes | |

Tug's strengths for an edge are that control renders and validates the whole Caddyfile (hostname and wildcard overlaps across projects are rejected before anything reaches Caddy), the endpoint list is already health-aware before Caddy sees it, secrets reach only the ingress node as files, and a reload is graceful, hash-gated and rolled back when Caddy rejects it. Caddy's retries are a second layer on top of that, not a replacement, and its active health checks would duplicate `x-tug.health`.

## Direction

1. **Done:** resilience defaults with no new key (retries, `stream_close_delay`), exercised against a real Caddy by `tests/integration/ingress-resilience.test.ts`.
2. **Done:** opt-in JSON access logs, per-host Caddy metrics on the admin endpoint, and a 503 (or `maintenance: true`) response for a host with no serving upstream. Still proposed: reading those metrics into the status report and re-exporting them from control ([ingress metrics](observability.md#ingress-metrics)).
3. **Proposed:** optional per-route `x-tug.ingress` keys, each a minor release: response timeout, body limit, compression (stock Caddy `encode` offers gzip and zstd, not brotli), alias redirects, load-balancing policy, basic auth (the hash delivered as a secret file like a custom certificate) and an IP allowlist.
4. **Proposed:** per-node settings under `tug node ingress`: trusted proxies behind a CDN, ACME CA and fallback issuer. Wildcards stay `tls: custom` unless a real need justifies on-demand TLS or a DNS-01 Caddy build.

Out of scope for stock Caddy: rate limiting (needs a plugin) and path routing within one hostname (needs several services per host in the route model).
