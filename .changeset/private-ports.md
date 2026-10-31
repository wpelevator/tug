---
"@wpelevator/tug": minor
---

Published ports are private by default (M10). Generated Compose binds `ports` entries that name no host IP to the node's overlay IP when the mesh is on, to `127.0.0.1` when only the managed Caddy on the same node dials the service, and otherwise to the node's `address`, with a `ports.public` warning event when that address is public. Entries with an explicit host IP, including `0.0.0.0`, are unchanged, so write `"0.0.0.0:80:80"` to publish something on purpose. `tug doctor --nodes` adds a `ports.public` check listing containers of Tug projects that listen on a public address. A node's `--address` must be an IP on one of its interfaces (or a hostname that resolves to one), because ports bind to it.
