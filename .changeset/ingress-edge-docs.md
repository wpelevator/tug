---
'@wpelevator/tug': patch
---

The managed ingress now retries requests for up to five seconds when no upstream is available instead of returning a 502 at once, skips a failed upstream for ten seconds on routes with several upstreams, and keeps open WebSockets running for up to five minutes after a config reload instead of cutting them on every site whenever any site deploys. The ingress docs also list the proxy's remaining limits, compare it with kamal-proxy, Uncloud, Traefik and Dokku, and add the remaining edge features to the roadmap.
