---
'@wpelevator/tug': major
---

`tug backup list --check` now fails when retention keeps failing, so a repository that quietly grows no longer stays green; see "Upgrading to 4.0" in docs/releases.md.

- Each run records whether retention (`restic forget` with the target's policy) worked, failed or was external. `--check` exits nonzero after two failed retention runs in a row on a target (or on control's own backup), whatever the cause (a failure on restic's lock exit code (11) is an overlap and follows the same rule), and a run whose retention works clears it. The prune that frees the data is the weekly maintenance's and is reported separately, as the repository's `verify` result. A failed run that exited on the lock code is recorded with `cause: "locked"`, and `backup list` prints `REPOSITORY LOCKED`.
- Append-only destinations (`rest-server --append-only`, a bucket that refuses deletes) need `tug backup destination set <url> --retention external`: tug then skips `forget` and `prune` for every project and for control's own backup, and `--check` stays green. With only `--retention` (or `--retention` and the URL in use), the stored credentials are kept. Retention, pruning, the `trigger:pre-restore` safety snapshots and partial-snapshot cleanup are then yours, see "Append-only destinations" in docs/backups.md.
- New events `backup.retention_failed` and `backup.retention_recovered` (on transition only, also delivered to webhooks), and `cause: "locked"` on `backup.failed`.
- `GET /api/v1/backups` and `backup list --json` serve parsed `retention` and `cause` fields on targets and `control`, and `retention`, `cause` and `warnings` on runs, beside each run's `metadata_json`. `destination show` and `destination check` report the retention mode.
