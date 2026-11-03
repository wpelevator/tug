# Backups and recovery

Tug schedules, verifies and restores backups itself. You mark a service or a volume with `x-tug.backup`, give control one S3-compatible destination, and agents run [restic](https://restic.net) on the node that holds the data. There is no backup container to build or keep alive.

## Plan for recovery

Workload snapshots contain application data; control-plane archives contain Tug state and keys. Store both away from the VPS, and keep their credentials and passwords somewhere you can reach if the server is lost.

| What | How to protect it | What to keep for recovery |
| --- | --- | --- |
| Database | Back up a logical dump from the running service with `x-tug.backup.command`; copying a live database volume is generally not consistent. | Repository password, storage credentials, a suitable restore command and application configuration. |
| Files in a named volume | Mark the volume with `x-tug.backup`; live files are crash-consistent, not necessarily application-consistent. | Repository password and storage credentials; test a scratch restore. |
| External object storage | Configure separate protection with the storage provider. | Provider credentials and a way to restore objects to a compatible point in time with the database. |
| Control state, secrets, private CA and master key | Run `tug control backup` and copy the archive off-host encrypted; it does not include workload data. | The archive and an original operator credential; see [control recovery](control-plane.md#recover-control-on-another-host). |
| Compose file and source | Keep them in version control. | Access to the repository and any external dependencies. |

Tug backs up each target separately. If your application needs a consistent point-in-time copy, plan how to stop writes and coordinate external storage. [The WordPress example](../examples/wordpress/README.md) illustrates a database and files on one node.

## Set up your first backup

Choose S3-compatible storage reachable from the workload node and credentials allowed to use the bucket. Configure one destination for control, then mark each target in your Compose file as shown in the [backup reference](compose.md#backups). A top-level schedule only supplies defaults; it does not enable any targets. For a complete database and volume configuration, use the [WordPress example](../examples/wordpress/README.md).

```sh
# Supply the values through your shell or secret manager; do not commit them.
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
tug backup destination set s3:https://s3.example.com/bucket/tug-backups --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY
tug deploy
tug backup run
tug backup list --check
tug backup password
```

Replace the endpoint and bucket with your own. `backup run` waits for the configured targets and reports failure; inspect `backup list --check` to confirm each target succeeded. Store the printed repository password and storage credentials securely off-host. The password is derived from control's master key; losing both the password and master key makes the repository unreadable. `tug backup destination show` shows the destination without credential values. Credentials are encrypted on control and released to a node running a backup. Each project has its own restic repository under `<destination>/<project>`; commands use the [resolved project](cli.md#arguments-options-and-configuration).

Also [back up control](#control-plane-backup), copy the archive off-host, and practice a [restore drill](#restore-drill). No backup notification is pushed automatically; monitor `tug backup list --check`.

## Backup destination

The control plane uses one destination. Running `tug backup destination set` replaces it. Setting or removing a destination updates its configuration and stored credentials atomically; a database failure leaves the previous configuration and credentials intact. Each project uses its own repository. The complete command and credential options are in the [CLI reference](cli.md#backups).

## Scheduled backups

Mark a service or a volume with `x-tug.backup` ([Compose extensions](compose.md#backups)) and Tug backs it up on its node, on the schedule you give, to the project's repository. Control runs a scheduler that ticks every 30 seconds (`TUG_BACKUP_TICK_MS`); at each slot it queues a `backup.run` command with a deadline. The agent runs it as a background job, so reconciliation and health checks are never held up by a long backup, and one node runs one backup at a time unless `TUG_BACKUP_CONCURRENCY` says otherwise.

- **Services** run your `command` through an exec in the running container and stream its output into `restic backup --stdin`, so no staging disk is needed. The command sees the container's own environment, including its secrets, so passwords are read from the environment (`$MARIADB_ROOT_PASSWORD`) and never appear in Tug's configuration, payloads or events. A command that fails, writes nothing or lacks the `verify` text is never kept: the partial snapshot is forgotten and the run fails. The service must be running on the node.
- **Volumes** are mounted read-only into the restic container and archived, with your `exclude` patterns. A volume that does not exist on the node fails the run instead of backing up an empty one. Live volumes are crash-consistent, which suits uploads and static files.
- **Retention** runs after each successful backup (`restic forget --prune` per node and target). Snapshots tagged `trigger:pre-restore` are kept regardless.

- **Images** for restic come from `TUG_RESTIC_IMAGE` on control (default `restic/restic:0.17.3`); a digest reference is recommended. Nodes pull it outbound like any published image.
- **Restic runs in a helper container** with a memory limit, labelled `tug.job`, removed when it finishes. An agent that restarts mid-job removes leftovers and reports the job failed.

Before mounting a managed volume, backup and restore check its project and volume ownership labels; a scratch restore checks its scratch volume's project and restore labels. A conflicting or unlabelled volume is refused instead of being read or overwritten.

## Recipes

Tug has no database support of its own; each recipe is a command for the service container. In a Compose file use `$$` for variables that the container shell must expand: a single `$` is interpolated on the operator machine before deployment. Read credentials from the container environment, write the data to standard output, and give `verify` the line the tool prints on success.

```yaml
# MariaDB (use mysqldump and MYSQL_ROOT_PASSWORD for MySQL)
backup:
  command: mariadb-dump -u root -p"$$MARIADB_ROOT_PASSWORD" --single-transaction --quick --routines --events --triggers --add-drop-database --databases wordpress
  filename: wordpress.sql
  verify: "-- Dump completed"

# PostgreSQL
backup:
  command: pg_dump -U "$$POSTGRES_USER" --clean --if-exists "$$POSTGRES_DB"
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

`tug backup run` takes a backup now and `tug backup list` shows the catalog ([CLI](cli.md#backups)).

### Restore

In a terminal, `tug backup run --select` chooses a subset of enabled targets. `tug restore run` offers a target when omitted; add `--select-snapshot` to choose a successful catalog backup or `--select-writers` to override writer discovery. `tug restore resume` and `tug restore release` offer interrupted restores when their ID is omitted. Existing preview and confirmation requirements still apply. See [interactive selection](cli.md#interactive-selection).

```bash
tug restore run db                       # prints the plan, changes nothing
tug restore run db --confirm             # latest backup of the db service
tug restore run uploads --scratch --confirm   # files into a new volume, touching nothing live
```

A restore plan and its queued restore refresh backup placement from the latest successful deployment before choosing a node, so moving a project does not leave a restore aimed at the previous node until the next scheduler tick. Check the printed target before confirming.

Restores are as generic as backups. A service is restored by running its `x-tug.backup.restore` command in the running container with the stored file on standard input (`restic dump` piped in), so a MariaDB service uses `restore: sh -c 'mariadb -uroot -p"$$MARIADB_ROOT_PASSWORD"'`. A volume is emptied and filled from the snapshot, or restored into a new volume with `--scratch`. A service without a `restore` command is refused rather than guessed at.

`tug restore` returns when the data is back and the services it stopped report serving again, or after five minutes with a warning if they do not, so a script can probe the site as soon as it returns. An in-place restore is deliberately careful:

1. It **locks the project**, so a deploy, rollback or secret change gets a clear refusal while it runs.
2. It **stops the writers**: the `writers` you named, or discovered from `depends_on`, or host names in environment variables such as `WORDPRESS_DB_HOST=db` or `mysql://u@db:3306/app` (for a service), or volume mounts (for a volume), including everything that depends on them. If none are found it refuses unless you pass `--writers` or `--no-writers`, because an app that reaches the database without `depends_on` is the hole in discovery and the plan makes you look.
3. It takes a **safety backup** of the current data, tagged `trigger:pre-restore` and exempt from retention (skip with `--no-safety-backup`). If that fails, nothing has changed: the writers start again and the lock is dropped.
4. It restores, then starts the writers and unlocks.

While a writer is held, a service that health-checks through it (an nginx check that requests a PHP page, for example) is unhealthy, so its node reports a failed apply for the duration. Tug still sees the writer as held and continues, but the deployment looks failed until the hold ends. Give such services a health check that does not depend on the writer (a static `/healthz`) to keep them serving through a restore. If a writer never reports held within five minutes, the restore fails and the error names the node, the writer's state and the apply error that node reported.

Only a snapshot this target produced can be restored into it (its `project:` and `target:` tags are checked). If the restore itself fails, the writers stay stopped and the project locked, because a half-restored database serving traffic is worse than an outage. The restore is `interrupted`; `tug restore resume <id>` tries again and `tug restore release <id>` starts the services anyway. Scheduled backups of a target are skipped while it is being restored. A restore is recorded with `restore.started`, `restore.completed`, `restore.failed` and `restore.released` events.

A scratch restore of a volume is also the restore drill: it proves a backup can be read without touching anything live. Databases are the same drill by hand: `restic dump <snapshot> wordpress.sql` into a throwaway container.

## Recover a site on a replacement node

This is a manual procedure, not automatic failover. A WordPress and MariaDB project was recovered this way with the published 0.9.0 release in the [real-host drill](real-host-evaluation.md#recovery-drill-with-the-published-090-release-2-november-2026). The original host was simulated as unavailable while control and the backup destination stayed available. Restore control first if it is also lost.

1. Fence the lost node or otherwise ensure its old workloads cannot write to shared services. Enroll the replacement node and verify it is online. Keep the recovery site private or otherwise block public traffic while its new database and volumes are empty; do not expose a fresh WordPress installer.
2. Change the project’s service and volume placement to the replacement node and deploy the same project using the retained images, configuration and secrets. The replacement uses fresh local volumes; deploying alone does not restore their contents. Keep the old backup repository and its password available.
3. Check `tug backup list` and run `tug restore run db` and `tug restore run wp-content` without `--confirm`. Verify each plan names the replacement node and the intended pre-loss snapshot. If the latest snapshot is not the desired one, use `--from` with the intended backup run or snapshot ID. Older releases may briefly show the former node until the backup scheduler catches up; never confirm a plan aimed at the wrong host.
4. Restore the database and uploads with the printed commands and `--confirm`. Tug normally takes a safety backup before each in-place restore and stops the writers; wait for each restore to finish and investigate any warning before continuing. Verify known database content and uploaded files, probe the application, then re-enable traffic and update DNS or routing as needed.

This does not restore data that was never backed up, external services, DNS, or changes after the selected snapshots. A live workload can write new data during recovery unless traffic and other writers are fenced; control alone cannot fence an unreachable or compromised host.

## Control plane backup

`tug control backup` covers the control plane only, not workload data. Take it with an `admin` operator credential and copy the archive off the control-plane host. The archive holds the master key, every secret and the private CA key (which can issue credentials for the whole installation), so treat it like a password vault and store it encrypted. Create a dedicated credential for the job: `tug credential create backup --role admin` and store it at `/etc/tug/backup.credential.json` (mode `0600`). Example `/etc/cron.d/tug-control-backup` on the control-plane host (the runtime image runs the CLI; adjust to how you invoke `tug` there):

```cron
15 2 * * * root TUG_CONTROL_URL=https://127.0.0.1:8443 TUG_CREDENTIAL_FILE=/etc/tug/backup.credential.json tug control backup > /var/log/tug-control-backup.json 2>&1 && restic -r s3:https://s3.eu-central-1.amazonaws.com/acme-backups/control backup /var/lib/tug/control-backups --password-file /etc/tug/restic.pass
```

Put the S3 credentials in the crontab environment or a `restic.env` file with mode `0600`. Archives accumulate in `TUG_CONTROL_BACKUP_DIR`; prune old files with `find ... -mtime +14 -delete`. The cron line has not been run on a real control-plane host; verify that `tug` is on the cron `PATH` and that the data directory matches your install (`TUG_CONTROL_BACKUP_DIR`, see [Configuration](configuration.md)). `TUG_CONTROL_URL` is a connect target only; the certificate is still verified against the public URL in the credential. Restore with `tug control restore <path> --confirm` and restart control ([Control plane](control-plane.md#backup-and-restore)).

## Restore drill

A backup you have not restored is a hope. Start with an isolated restore to verify the backup without changing live data. Time the exercise and record what you needed.

1. **Check the repository and the catalog.** `tug backup list` shows every target with its last success; the newest run should be recent and `succeeded`. `tug backup password` prints the repository and its password, so you can also inspect it directly with `restic snapshots` from any machine that can reach the bucket.
2. **Restore files into a scratch volume.** `tug restore run wp-content --scratch --confirm` reads the latest snapshot into a new volume next to the live one and touches nothing live. List it with `docker run --rm -v <volume>:/data alpine ls /data` on the node, then remove the volume with `docker volume rm <volume>`.
3. **Restore the database into an isolated throwaway database.** Use the original project repository and its escrowed password to read the snapshot with restic into a separate database container. Verify known data without connecting the test container to production services, mail or scheduled jobs. This manual end-to-end drill has not yet been validated on a fresh host.
4. **Write down how long it took.** That is your real recovery time.

Tug does not restore a snapshot into a different project: repositories and snapshot tags are project-specific. For an in-place restore, inspect `tug restore run db` first; confirmation stops writers, takes a safety backup and changes the live database. See [Restore](#restore).

## Known limits

- One failed night is visible as a `backup.failed` or `backup.stale` event, not a push notification, until [webhooks](roadmap.md#m8--central-api-advantages-partly-done) exist. Watch `tug events`, or point a monitor at `tug backup list`.
- While control is down no backup starts. Running jobs finish and report when control returns, and a long gap yields one missed event and one catch-up run per target.
- Live volumes are crash-consistent, not application-consistent. Use a command backup for anything with its own consistency (databases).
- A volume is backed up from the one node that holds it. A volume you mount from a file server with `driver_opts` is read through that node's mount; back up the file server's own disk where you can.
- Repository maintenance (`restic check`, a read-verify of the data) and SFTP destinations are not built yet.
- A scratch restore leaves its volume (`tug_r<project-length>_<project>_<id>`) behind, and the safety snapshot of every in-place restore is kept for ever. There is no command to list or remove either yet: remove scratch volumes with `docker volume rm` on the node, and safety snapshots with `restic forget` using the repository from `tug backup password`.
- The restic helper container defaults to a 512 MB memory limit, which is half of a 1 GB host; lower it with `memory` under `x-tug.backup`. Restic needs more memory for larger repositories, so test the limit against your data.
- Failures are not pushed anywhere until webhooks exist. Run `tug backup list --check` from cron or a monitor: it exits nonzero when a target is stale, failed or missed.
- Cancelling `tug exec` does not stop the remote process.
