---
'@wpelevator/tug': patch
---

Deployment, command, backup run, restore and build lifecycles are now declared as transition tables and every state change goes through one guarded writer, so an undeclared transition is refused instead of silently applied, and the database rejects any state a lifecycle does not declare. Builds left in `building` by a failed or interrupted deploy are now marked `failed`. A node's `stale` status is derived from its last heartbeat on every read instead of being written by `GET /api/v1/status`, so `tug node list` no longer shows a stale node as `online` until someone runs `tug status`. The deployment states `uploading` and `pending_dependencies`, which nothing ever set, are gone from the docs and the metric label list.
