---
"@wpelevator/tug": patch
---

Fix the MariaDB restore example in the Compose reference, which failed `tug deploy` because of an unescaped `$`, and add a test that checks every Compose snippet in the README and docs against the deploy value rules. Add scripts under `tools/scripts` to measure ingress overhead, container CPU and memory, and downtime during a redeploy.
