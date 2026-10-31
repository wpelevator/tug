---
"@wpelevator/tug": patch
---

The agent now always runs with `--network host` (`node-install`, `node-enroll` and its cloud-init). Its TCP and HTTP health checks dial container IPs, which an agent on the default Docker bridge cannot reach on current Docker (29.x), so every first deploy on a fresh node failed health. `--mesh` still adds `NET_ADMIN` and `TUG_MESH`.
