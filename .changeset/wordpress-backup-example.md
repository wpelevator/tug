---
"@wpelevator/tug": patch
---

Add an interim WordPress backup recipe: an `examples/wordpress-backup` Compose project with a restic backup sidecar (database dump, uploads, retention, health), and `docs/backups.md` with multi-node and NFS variants, a control-plane backup cron and a restore drill, until `x-tug.backup` (M11) exists.
