---
'@wpelevator/tug': minor
---

Add `tug ingress logs [node]` (and the `tug logs --ingress` shorthand) to read an ingress node's Caddy container, and `tug ingress tls [node]` to show per host whether the edge serves a valid certificate and why not. Ingress agents now probe their own Caddy with a TLS handshake per named host and report `issued`, `pending` or `failed` in the ingress status. The state also appears in `tug domain list`, as a count in `tug status`, and in `tug doctor`, which now fails the `ingress` check for a host without a certificate for more than ten minutes. Both commands need an unscoped `admin` credential. The status field is additive, and an agent that predates it reads `unknown`.
