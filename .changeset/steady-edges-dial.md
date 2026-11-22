---
'@wpelevator/tug': minor
---

A rolling revision now takes traffic only after the ingress nodes that route to it can open a connection to its published port, so a firewall between edge and app node rejects the candidate while the old revision keeps serving instead of leaving ingress with an unreachable upstream. A live revision that fails its health check later stays routed as `degraded` when it is the service's last endpoint, instead of being withdrawn into a certain 503. `tug status` and `tug tui` show `degraded`. Control and agents of different versions keep working: an older agent or control skips the check.
