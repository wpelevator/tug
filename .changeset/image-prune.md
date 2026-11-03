---
'@wpelevator/tug': minor
---

Add `tug image prune [--keep N] [--dry-run]` to delete the build archives kept on control for old deployments, and `tug control backup --no-images` to leave the archives out of a control backup. Rolling back to a deployment whose archive was pruned is refused with a clear message.
