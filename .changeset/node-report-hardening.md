---
'@wpelevator/tug': patch
---

Harden node reports and source uploads. Control validates every node status report against the protocol schema (rejecting non-numeric or out-of-range ports) and stores only services placed on the reporting node, so a node can no longer inject ingress configuration. Backup results and heartbeats apply only to a running command owned by the calling node. `node-disable` now removes the node from peers, endpoints, ingress and label scheduling immediately. Source uploads follow `.dockerignore` glob, recursive and negation rules and never include `*.credential.json` files.
