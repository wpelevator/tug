---
'@wpelevator/tug': minor
---

The managed ingress keeps requests and WebSockets alive across upstream churn and tells clients what is happening. A request retries for up to five seconds when no upstream is available instead of returning a 502 at once, a failed upstream is skipped for ten seconds on routes with several upstreams, and open WebSockets keep running for up to five minutes after a config reload instead of being cut on every site whenever any site deploys. A host with no serving upstream now answers `503` with `Retry-After` instead of failing the TLS handshake, and the new `x-tug.ingress.maintenance: true` does the same on purpose. Each site writes a JSON access log to the `tug-caddy` container (switch off with `TUG_INGRESS_ACCESS_LOG=false`), and Caddy's per-host Prometheus metrics are available on the ingress node's loopback admin endpoint. The ingress docs also list the proxy's remaining limits and compare it with kamal-proxy, Uncloud, Traefik and Dokku.
