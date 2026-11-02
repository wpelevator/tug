---
'@wpelevator/tug': minor
---

Remove the Tug-managed WireGuard mesh and its CLI, API, configuration and runtime surfaces. Cross-node service names, ingress upstreams and private published ports now always use the node's operator-provided `address`; set it to an address on your existing private network. Service names are enabled by default and can be disabled with `TUG_SERVICE_NAMES=false`. Agents no longer need `NET_ADMIN` or WireGuard tools, but retain host networking for container health checks.
