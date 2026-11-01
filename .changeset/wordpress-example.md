---
'@wpelevator/tug': minor
---

Add an `examples/wordpress` project (WordPress and MariaDB with scheduled backups, restore and one-off commands) and replace the sidecar backup recipe with it. Fix Compose escaping: literal dollars written `$$` in a Compose file now reach the container as `$`, as they do with `docker compose up`, which also lets backup and restore commands read passwords from the container's environment. Make `restore --from latest` skip the safety snapshot taken before a previous restore.
