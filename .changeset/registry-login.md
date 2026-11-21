---
'@wpelevator/tug': minor
---

Add `tug registry login <host> --username <name>`: it asks for a registry token without echo in a terminal, or reads it from stdin, and adds the host to the project's `TUG_REGISTRY_AUTH` secret, keeping the other hosts, so private images no longer need hand-written JSON. GHCR needs a classic personal access token with `read:packages`.
