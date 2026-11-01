---
'@wpelevator/tug': minor
---

Run scheduled backups. `x-tug.backup` on a service names a command run in the service's container whose output is stored (so any database or tool works, with recipes in the docs), and on a volume archives its files. Control schedules them, agents run restic in a helper container, and runs are recorded in a catalog with `backup.completed`, `backup.failed`, `backup.missed`, `backup.stale` and `backup.no_destination` events. Add `backup-run` and `backup-list`. Restores are not implemented yet.
