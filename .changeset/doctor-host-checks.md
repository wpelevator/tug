---
'@wpelevator/tug': minor
---

`tug doctor` now checks that ingress nodes answer on ports 80 and 443 (control opens a TCP connection to each node's address) and fails with the closed port, the likely firewall cause and the fix; tug still never changes a firewall. It prints the local Docker daemon as `skip` with `needed only for --build-local` instead of `FAIL` when none is reachable, and no longer counts it as a problem. Node and control diagnostics report load average, available memory, free disk under Docker's data root and the CPU and memory of the agent, Caddy and control containers. `tug node ingress` reminds the operator to open the ports. Additive: the new checks and fields appear in `doctor --json`, and an agent that predates the resources check simply omits it.
