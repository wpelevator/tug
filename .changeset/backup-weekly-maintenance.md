---
'@wpelevator/tug': minor
---

Repositories are now pruned and checked once a week instead of pruning after every backup. Control queues a new `backup.maintain` job per project (and checks its own repository), which runs `restic prune` and `restic check`, never prunes an append-only destination, and spreads first runs over a week. A failed check turns `tug backup list --check` red and raises `backup.verify_failed`. New `tug backup verify [--read-data-subset <subset>] [--control]` checks a repository now, and `tug backup list` shows a protection level per target: `off-host`, `verified` (a check passed after the latest backup) or `restore-tested` (a scratch restore succeeded). Upgrade nodes before control relies on it: an older agent does not know `backup.maintain`.
