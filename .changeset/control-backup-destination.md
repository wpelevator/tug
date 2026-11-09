---
'@wpelevator/tug': minor
---

Control now backs itself up to the shared backup destination. Once `tug backup destination set` has run, control stores a consistent archive of its database, private CA and master key (without build images) in a `_control` restic repository every night, retries a failure after an hour and keeps 3 recent, 7 daily, 4 weekly and 6 monthly snapshots. The repository password is derived from the destination's own secret, so the bucket credentials you already keep are the whole recovery kit; any host holding them can open the archive. `tug backup list` shows a `control` line and `--check` fails when the control backup failed or is stale. `tug control restore --from-destination <url> --env …` rebuilds control on a fresh host from that repository, and `tug control backup --download [-o <file>]` saves a `0600` copy of a backup on your machine through the new `GET /api/v1/control/backups/:id/download`.
