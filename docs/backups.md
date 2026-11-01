# Backing up WordPress sites

Tug schedules, verifies and restores backups itself. You mark a service or a volume with `x-tug.backup`, give control one S3-compatible destination, and agents run [restic](https://restic.net) on the node that holds the data. There is no backup container to build or keep alive.

The working example is [`examples/wordpress`](../examples/wordpress/README.md): WordPress and MariaDB on one node with a nightly database dump, the uploads archived as files, and a restore command for each. The test suite checks that it validates; the same project was deployed, backed up and restored on a real node (see the example's README).

## What to back up

| Data | Where it lives | How it is covered |
| --- | --- | --- |
| Database | `db-data` volume, MariaDB | `x-tug.backup.command` on the `db` service: a logical dump (`mariadb-dump --single-transaction`) streamed into restic. Never copy `/var/lib/mysql` of a running server. |
| Uploads, plugins, themes | `wp-content` volume | `x-tug.backup` on the volume: mounted read-only and archived by restic. |
| Secrets | Tug control database | `tug control-backup` (below). Print each project's repository password with `tug backup-key` and keep it in your password manager too: without it, and without control's master key, a repository cannot be decrypted. |
| Control plane | Control host | `tug control-backup`: database, API tokens, master key, built images. It does not contain project data. |
| Compose file | Your Git repository | Already versioned. |

`wp-config.php` is rebuilt from environment variables on every start, so it is not backed up. If you set fixed `WORDPRESS_AUTH_KEY` and the other salts as secrets they survive a rebuild; otherwise users are logged out after a restore.

The WordPress HTTP health check calls `/wp-includes/version.php`, which executes PHP and returns directly without canonical-host redirects. Avoid `/wp-login.php` for this check: after installation it can redirect to the public site URL, making ingress availability depend on the site URL.

Database and files are separate snapshots taken minutes apart. For a WordPress site that is normally consistent enough; if a post was published between them its media may be missing from one side.

## Backup destination

Tug can already hold the destination that scheduled backups will use. Set it once on control with `tug backup-destination-set` and read it with `backup-destination-show` ([CLI](cli.md#backups)). Credentials are encrypted with the master key, are never returned by the API, and are released only to a node that is running a backup command for it. Every project gets its own restic repository at `<destination>/<project>`, so a leaked password exposes one site, and one project's prune never blocks another's backups. The password is derived from the master key; print it with `tug backup-key` and escrow it.

## Scheduled backups

Mark a service or a volume with `x-tug.backup` ([Compose extensions](compose.md#backups)) and Tug backs it up on its node, on the schedule you give, to the project's repository. Control runs a scheduler that ticks every 30 seconds (`TUG_BACKUP_TICK_MS`); at each slot it queues a `backup.run` command with a deadline. The agent runs it as a background job, so reconciliation and health checks are never held up by a long backup, and one node runs one backup at a time unless `TUG_BACKUP_CONCURRENCY` says otherwise.

- **Services** run your `command` through an exec in the running container and stream its output into `restic backup --stdin`, so no staging disk is needed. The command sees the container's own environment, including its secrets, so passwords are read from the environment (`$MARIADB_ROOT_PASSWORD`) and never appear in Tug's configuration, payloads or events. A command that fails, writes nothing or lacks the `verify` text is never kept: the partial snapshot is forgotten and the run fails. The service must be running on the node.
- **Volumes** are mounted read-only into the restic container and archived, with your `exclude` patterns. A volume that does not exist on the node fails the run instead of backing up an empty one. Live volumes are crash-consistent, which suits uploads and static files.
- **Retention** runs after each successful backup (`restic forget --prune` per node and target). Snapshots tagged `trigger:pre-restore` are kept regardless.
- **Images** for restic come from `TUG_RESTIC_IMAGE` on control (default `restic/restic:0.17.3`); a digest reference is recommended. Nodes pull it outbound like any published image.
- **Restic runs in a helper container** with a memory limit, labelled `tug.job`, removed when it finishes. An agent that restarts mid-job removes leftovers and reports the job failed.

## Recipes

Tug has no database support of its own; each recipe is just a `command` for the service container. Read the password from the container's environment, write the data to standard output, and give `verify` the line the tool prints on success.

```yaml
# MariaDB (use mysqldump and MYSQL_ROOT_PASSWORD for MySQL)
backup:
  command: mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --single-transaction --quick --routines --events --triggers --add-drop-database --databases wordpress
  filename: wordpress.sql
  verify: "-- Dump completed"

# PostgreSQL
backup:
  command: pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB"
  filename: app.sql
  verify: "PostgreSQL database dump complete"

# SQLite file in a volume mounted into the service
backup:
  command: sqlite3 /data/app.db .dump
  filename: app.sql
  verify: COMMIT

# A directory as a tar stream
backup:
  command: tar -C /var/www/html -cf - wp-content/themes
  filename: themes.tar
```

`mariadb-dump` and `mysqldump` do not dump users and grants; they come from the image's init environment. A service has one backup command, so to include PostgreSQL roles chain them: `sh -c 'pg_dumpall --globals-only; pg_dump ...'`. Restore with the same tool: `restic dump <snapshot> wordpress.sql | mariadb ...`.

### Events and what to watch

`tug events` shows `backup.completed`, `backup.failed`, `backup.missed`, `backup.stale` and `backup.no_destination`. A backup is `missed` when its node did not pick it up before its deadline (`node_offline`) or when control was not running at the slot: a week of downtime produces one missed event and one catch-up run per target, not a burst. A failed scheduled run is retried once after ten minutes. A target with no success for two periods raises `backup.stale` once a day, which catches a destination key that has quietly stopped working. While control is down no backup starts, which is the price of one scheduler; running jobs finish and report when control returns.

`tug backup-run` takes a backup now and `tug backup-list` shows the catalog ([CLI](cli.md#backups)). ### Restore

```bash
tug restore db                       # prints the plan, changes nothing
tug restore db --confirm             # latest backup of the db service
tug restore uploads --scratch --confirm   # files into a new volume, touching nothing live
```

Restores are as generic as backups. A service is restored by running its `x-tug.backup.restore` command in the running container with the stored file on standard input (`restic dump` piped in), so a MariaDB service uses `restore: sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"'`. A volume is emptied and filled from the snapshot, or restored into a new volume with `--scratch`. A service without a `restore` command is refused rather than guessed at.

`tug restore` returns when the data is back and the services it stopped report serving again, or after five minutes with a warning if they do not, so a script can probe the site as soon as it returns. An in-place restore is deliberately careful:

1. It **locks the project**, so a deploy, rollback or secret change gets a clear refusal while it runs.
2. It **stops the writers**: the `writers` you named, or discovered from `depends_on` (for a service) or volume mounts (for a volume), including everything that depends on them. If none are found it refuses unless you pass `--writers` or `--no-writers`, because an app that reaches the database without `depends_on` is the hole in discovery and the plan makes you look.
3. It takes a **safety backup** of the current data, tagged `trigger:pre-restore` and exempt from retention (skip with `--no-safety-backup`). If that fails, nothing has changed: the writers start again and the lock is dropped.
4. It restores, then starts the writers and unlocks.

Only a snapshot this target produced can be restored into it (its `project:` and `target:` tags are checked). If the restore itself fails, the writers stay stopped and the project locked, because a half-restored database serving traffic is worse than an outage. The restore is `interrupted`; `tug restore-resume <id>` tries again and `tug restore-release <id>` starts the services anyway. Scheduled backups of a target are skipped while it is being restored. A restore is recorded with `restore.started`, `restore.completed`, `restore.failed` and `restore.released` events.

A scratch restore of a volume is also the restore drill: it proves a backup can be read without touching anything live. Databases are the same drill by hand: `restic dump <snapshot> wordpress.sql` into a throwaway container.

## Control plane backup

`tug control-backup` covers the control host only. Take it from a machine that holds an `admin` token, on the control host, and copy the archive off the host. The archive holds the master key and every secret, so treat it like a password vault and store it encrypted. Example `/etc/cron.d/tug-control-backup` on the control host (the runtime image runs the CLI; adjust to how you invoke `tug` there):

```cron
15 2 * * * root TUG_CONTROL_URL=http://127.0.0.1:8080 TUG_TOKEN=$(cat /etc/tug/admin.token) tug control-backup > /var/log/tug-control-backup.json 2>&1 && restic -r s3:https://s3.eu-central-1.amazonaws.com/acme-backups/control backup /var/lib/tug/control-backups --password-file /etc/tug/restic.pass
```

Put the S3 credentials in the crontab environment or a `restic.env` file with mode `0600`. Archives accumulate in `TUG_CONTROL_BACKUP_DIR`; prune old files with `find ... -mtime +14 -delete`. The cron line has not been run on a real control host; verify that `tug` is on the cron `PATH` and that the data directory matches your install (`TUG_CONTROL_BACKUP_DIR`, see [Configuration](configuration.md)). Restore with `tug control-restore <path> --confirm` and restart control ([Control plane](control-plane.md#backup-and-restore)).

## Restore drill

A backup you have not restored is a hope. Rehearse the restore on the live project so you know it works and how long it takes.

1. **Check the repository and the catalog.** `tug backup-list` shows every target with its last success; the newest run should be recent and `succeeded`. `tug backup-key` prints the repository and its password, so you can also inspect it directly with `restic snapshots` from any machine that can reach the bucket.
2. **Restore files into a scratch volume.** `tug restore wp-content --scratch --confirm` reads the latest snapshot into a new volume next to the live one and touches nothing live. List it with `docker run --rm -v <volume>:/data alpine ls /data` on the node, then remove the volume with `docker volume rm <volume>`.
3. **Restore the database for real, in a quiet moment.** `tug restore db` prints the plan; `tug restore db --confirm` stops WordPress, takes a safety backup of the current data, loads the dump and starts WordPress again. Compare a number you know (the post count, the newest upload) with production.
4. **Write down how long it took.** That is your real recovery time.

To rehearse a database restore without touching the live one, copy the project into a scratch project name (`TUG_PROJECT`), restore into it with `--from <snapshot id>` naming a snapshot of the original, and remove the scratch project when done. Remember to stop the scratch site from sending mail or running cron against production services.

## Known limits

- One failed night is visible as a `backup.failed` or `backup.stale` event, not a push notification, until [webhooks](roadmap.md#m8--central-api-advantages-partly-done) exist. Watch `tug events`, or point a monitor at `tug backup-list`.
- While control is down no backup starts. Running jobs finish and report when control returns, and a long gap yields one missed event and one catch-up run per target.
- Live volumes are crash-consistent, not application-consistent. Use a command backup for anything with its own consistency (databases).
- A volume is backed up from the one node that holds it. A volume you mount from a file server with `driver_opts` is read through that node's mount; back up the file server's own disk where you can.
- Repository maintenance (`restic check`, a read-verify of the data) and SFTP destinations are not built yet.
- A scratch restore leaves its volume (`<project>_restore-<id>`) behind, and the safety snapshot of every in-place restore is kept for ever. There is no command to list or remove either yet: remove scratch volumes with `docker volume rm` on the node, and safety snapshots with `restic forget` using the repository from `tug backup-key`.
- The restic helper container defaults to a 512 MB memory limit, which is half of a 1 GB host; lower it with `memory` under `x-tug.backup`. Restic needs more memory for larger repositories, so test the limit against your data.
- Failures are not pushed anywhere until webhooks exist. Run `tug backup-list --check` from cron or a monitor: it exits nonzero when a target is stale, failed or missed.
- Cancelling `tug exec` does not stop the remote process.
