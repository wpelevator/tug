---
'@wpelevator/tug': minor
---

Run scheduled backups. `x-tug.backup` on a service names a command run in the service's container whose output is stored (so any database or tool works, with recipes in the docs), and on a volume archives its files. Control schedules them, agents run restic in a helper container, and runs are recorded in a catalog with `backup.completed`, `backup.failed`, `backup.missed`, `backup.stale` and `backup.no_destination` events. Add `backup-run`, `backup-list` and restores (`restore`, `restore-list`, `restore-resume`, `restore-release`): an in-place restore locks the project, stops the services that write to the target, takes a safety backup, restores through the service's own `restore` command or the volume's files, and starts them again; a scratch restore of a volume touches nothing live.
