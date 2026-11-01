---
'@wpelevator/tug': minor
---

Run scheduled backups: control schedules `x-tug.backup` targets, agents run restic in a helper container (databases dumped with the service's own client and streamed, volumes mounted read-only), and runs are recorded in a catalog with `backup.completed`, `backup.failed`, `backup.missed`, `backup.stale` and `backup.no_destination` events. Add `backup-run` and `backup-list`. Restores are not implemented yet.
