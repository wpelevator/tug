---
'@wpelevator/tug': minor
---

Add `tug backup destination check`, which opens the control repository and the repository of every project with a backup target from the control host, creates missing ones and exits nonzero when any fails. `tug backup destination set` runs the check after saving (skip it with `--no-check`). Backup destinations may now use any built-in restic backend: `s3:`, `rest:`, `b2:`, `azure:`, `gs:` and `swift:`. `tug backup destination set` keeps exit code 0 when the check fails, since the destination is saved. Adds `POST /api/v1/backup/destination/check` and `deployed` in the repository password response.
