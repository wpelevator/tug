---
'@wpelevator/tug': patch
---

Fixes found by the QEMU restore drill of the 4.0 backup changes (see docs/real-host-evaluation.md).

- `tug backup unlock` and `tug backup unlock --control` now remove an exclusive stale lock, such as the one a killed `forget --prune` leaves. The repository probe that opens every backup job reads the config without a lock, so it is no longer refused by the lock the unlock is about to remove.
- A backup, restore or forget that meets a short-lived lock now waits for it (`--retry-lock 10m`, as `restic backup` already did) instead of failing at the repository probe within seconds. The probe, `snapshots`, `dump` and `restore` are the commands that changed.
- A control backup refused by a lock is classified as `locked` like a project backup, so `backup list` shows `REPOSITORY LOCKED`, `--check` names `tug backup unlock --control`, and `backup.failed` carries `cause: "locked"`.
- A retention failure keeps restic's own message (for an append-only destination, the `403 Forbidden` line) instead of the tail of a Go stack trace, and says to run `tug backup destination set --retention external` when the destination refuses deletes.
- `tug backup destination set --retention external` ends a recorded retention failure at once, for projects and for control: `backup list --check` returns to 0 and one `backup.retention_recovered` event is recorded per target that was failing.
- A retention failure on restic's lock exit code (11) now needs two failures in a row to fail `backup list --check`, like any other overlap, instead of failing at once.
