---
'@wpelevator/tug': major
---

`tug backup list --check` now fails when pruning keeps failing, so a repository that quietly grows no longer stays green; see "Upgrading to 4.0" in docs/releases.md.

- Each run records whether retention (`restic forget --prune`) worked, failed or was external. `--check` exits nonzero after two failed prunes in a row on a target (or on control's own backup), or after one that failed on restic's lock exit code (11), and a run whose prune works clears it. A failed run that exited on the lock code is recorded with `cause: "locked"`, and `backup list` prints `REPOSITORY LOCKED`.
- Append-only destinations (`rest-server --append-only`, a bucket that refuses deletes) need `tug backup destination set <url> --retention external`: tug then skips pruning for every project and for control's own backup, and `--check` stays green. With only `--retention` and the URL in use, the stored credentials are kept. Pruning, the `trigger:pre-restore` safety snapshots and partial-snapshot cleanup are then yours, see "Append-only destinations" in docs/backups.md.
- New events `backup.retention_failed` and `backup.retention_recovered` (on transition only, also delivered to webhooks), and `cause: "locked"` on `backup.failed`.
- `GET /api/v1/backups` and `backup list --json` serve parsed `retention`, `lock` and `cause` fields on targets, runs and `control`, and no longer include each run's raw `metadata_json`. `destination show` and `destination check` report the retention mode.
