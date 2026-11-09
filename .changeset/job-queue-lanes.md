---
'@wpelevator/tug': minor
---

Backup and restore jobs no longer let one stuck job block a node. Every restic command (backup, forget, restore, the streamed dump) now fails when it makes no progress for ten minutes, and restic's own retry notices do not count as progress; a prune that stalls after the snapshot was taken is a warning, not a failed backup. A node runs a restore and its safety backup before a manual backup, and a manual backup before a scheduled one, never two jobs of one project at once, and two at a time on a host with 3 GiB or more of memory (one otherwise; `TUG_BACKUP_CONCURRENCY` overrides). `tug backup cancel <run>` and `tug restore cancel <id>` stop a queued or running job through a new `backup.cancel` command; a cancelled backup is reported as `backup.cancelled` and not retried. A job the node has queued behind another is now shown as queued (`queued behind bkr_…`) instead of running, and `tug backup list` ends each run with its id.
