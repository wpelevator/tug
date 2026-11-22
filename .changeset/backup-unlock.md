---
'@wpelevator/tug': minor
---

New `tug backup unlock [--control]` removes stale restic locks from the project's repository, or from control's own, which is the fix for a backup that failed with `the repository is locked`. It is admin only, runs on the node that runs the project's backups without taking the project lock, is audited as `backup.unlock` and answers with how many locks were removed and how many remain. Only locks that have gone stale are removed, never a live restic's. The failed run and `backup list --check` now name the command. Agents get a new `backup.unlock` command type, so upgrade nodes before using it on a project.
