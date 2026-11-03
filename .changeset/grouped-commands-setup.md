---
'@wpelevator/tug': minor
---

Commands are now grouped as `tug <subject> <verb>` (`node add`, `secret set`, `backup run`, `credential create`, and so on); the dash-joined names such as `node-install` are removed, and `deploy-cancel` is `deploy cancel`. `tug setup` (short for `tug control setup`) installs control and imports the root credential in one step, so `tug init` is only needed for credentials from elsewhere. `tug node add` infers the node name from the SSH host and, in a terminal, offers to install Docker, choose the inter-node address and enable ingress (`--ingress`), then confirms a plan (`-y` skips it). `tug node list` is new, and `node replace` and `node repair` take the node name as an argument.
