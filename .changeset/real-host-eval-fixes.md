---
'@wpelevator/tug': patch
---

Fixes from a real-host evaluation: `tug setup` writes the credential's control URL into a new `tug.yml` instead of `https://localhost:8443`; a restore no longer times out with "the writers did not stop in time" when a sibling service's health check fails during the hold; a health check on a crashed container reports its exit code and last log lines instead of a refused connection; `tug scale` stays within a service's explicit `placement.nodes`; `tug run` containers inherit the service's cross-node `extra_hosts`; `tug deploy` finds `compose.yaml`/`compose.yml` by default; and the missing-backup-schedule message is clearer.
