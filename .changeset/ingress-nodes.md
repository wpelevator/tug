---
"@wpelevator/tug": minor
---

Add `x-tug.ingress.nodes`, the ingress nodes that serve a route. Without it every ingress node serves every route and requests a certificate for every host, so a host that resolves to one node showed as failed on the others. Named routes render only on those nodes, and a deployment waits only for them.
