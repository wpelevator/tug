---
'@wpelevator/tug': patch
---

A changed `x-tug.health` on a rolling service now starts a candidate revision that must pass the new check while the old one keeps serving. Before, only the live revision was probed with the new check, so a check it failed withdrew the only upstream and ingress answered 503.
