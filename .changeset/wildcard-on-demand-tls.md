---
'@wpelevator/tug': minor
---

A wildcard `x-tug.ingress.host` with `tls: auto` now works: Caddy issues a certificate for each name under the zone on the first connection (on-demand TLS), approved by a loopback-only endpoint that control renders from the wildcard hosts it routes and that accepts exactly one label under the zone. Before, such a host could never obtain a certificate. Let's Encrypt limits certificates per registered domain, so a network with many subdomains should use `tls: custom` with a wildcard certificate.
