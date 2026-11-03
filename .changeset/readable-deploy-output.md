---
'@wpelevator/tug': minor
---

`tug deploy`, `tug rollback` and `tug scale` print a one-line summary by default; `--json` restores the full result for scripts. `tug deploy` warns when the Compose file's `name:` differs from the Tug project. A restore that times out waiting for the writers to stop now names the node, the writer's state and the apply error the node reported, and the backup docs explain why a sibling health check that depends on a held writer fails during a restore.
