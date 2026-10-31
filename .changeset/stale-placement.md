---
"@wpelevator/tug": patch
---

Skip stale nodes when resolving label and `global` placement and in `tug scale`, so a dead host cannot hold a rollout open. Fix NFS volumes so consumers mount the exporter's overlay or node address and the exporter bind-mounts the export path.
