---
'@wpelevator/tug': minor
---

An agent that is busy applying a deployment (a long image pull) now sends a heartbeat every 15 seconds, so its node stays online instead of turning stale, and `tug node list` shows it as `busy`. `GET /api/v1/nodes` gains an additive `applying` field; an older agent never sets it.
