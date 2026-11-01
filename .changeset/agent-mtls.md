---
'@wpelevator/tug': minor
---

Replace HTTP and bearer tokens with one mutual-TLS listener. Control now serves a single TLS 1.3 port (default `8443`) that requires a client certificate from every peer, signed by control's private CA. Nodes, operators and CI authenticate with certificates whose keys are authorized from the database, so revocation, key replacement and `tug node-disable` apply to the next request and close live sessions. `TUG_PUBLIC_URL` is now required; `TUG_OPERATOR_TOKEN`, `TUG_TOKEN`, `TUG_AGENT_TOKEN`, `TUG_TLS_CERT_FILE`, `TUG_TLS_KEY_FILE`, `--token`, `--uses`, `--ca`, `--http-only-dev`, `control-token`, `/healthz` and the plain HTTP listener are removed. New commands: `node-replace-identity`, `node-repair-identity`, `node-disable`, `control-install --recover-root`, `agent identity` and `agent install-cert`; `tug init` imports a credential file. `node-prepare-enrollment` mints single-use, name-bound bootstrap certificates.
