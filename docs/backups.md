# Backups and recovery

Mark a service or a volume with `x-tug.backup`, give control one S3-compatible destination, and agents run [restic](https://restic.net) on the node that holds the data on a schedule. There is no backup container to build or keep alive.

## Set up your first backup

You need S3-compatible storage reachable from the workload node, and credentials allowed to use the bucket. Create the bucket first. Mark each target in your Compose file as shown in [Compose extensions](compose.md#backups), and see the [WordPress example](https://github.com/wpelevator/tug/blob/main/examples/wordpress/README.md) for a database and files together. A top-level schedule only supplies defaults and enables nothing.

```sh
# Supply the values through your shell or secret manager. Do not commit them.
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
tug backup destination set s3:https://s3.example.com/bucket/tug-backups --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY
tug deploy
tug backup run
tug backup list --check
tug backup password
```

| Command | What it tells you |
| --- | --- |
| `backup run` | Waits for the configured targets and reports failure |
| `backup list --check` | Whether each target succeeded, and exits nonzero if not |
| `backup password` | The repository and its password. Store it, with the storage credentials, off the server |
| `backup destination show` | The destination, without credential values |

The password is derived from control's master key, so losing both the password and the master key makes the repository unreadable. Credentials are encrypted on control and released only to a node running a backup. Each project has its own repository under `<destination>/<project>`, and commands use the [resolved project](cli.md#arguments-options-and-configuration).

Control also backs itself up to the same destination every night, see [Control plane backup](#control-plane-backup). No backup notification is pushed, so monitor `tug backup list --check`.

## Plan for recovery

Workload snapshots hold application data. Control archives hold tug state and keys. Store both away from the VPS, and keep their credentials and passwords somewhere you can reach if the server is lost.

| What | How to protect it | What to keep for recovery |
| --- | --- | --- |
| Database | Back up a logical dump from the running service with `x-tug.backup.command`. Copying a live database volume is generally not consistent | Repository password, storage credentials, a restore command and application configuration |
| Files in a named volume | Mark the volume with `x-tug.backup`. Live files are crash-consistent, not necessarily application-consistent | Repository password and storage credentials. Test a scratch restore |
| External object storage | Configure separate protection with the storage provider | Provider credentials and a way to restore objects to a point in time compatible with the database |
| Control state, secrets, private CA, master key | Automatic once a destination is set. `tug control backup` stores one on demand, and `tug control backup -o <file>` saves an archive on your machine. None includes workload data | The control password (`tug backup password --control`) and the destination credentials, see [control recovery](control-plane.md#recover-control-on-another-host) |
| Compose file and source | Keep them in version control | Access to the repository and any external dependencies |

tug backs up each target separately. If your app needs a consistent point-in-time copy, plan how to stop writes and coordinate external storage.

## How scheduled backups run

Control's scheduler ticks every 30 seconds (`TUG_BACKUP_TICK_MS`). At each slot it queues a `backup.run` command with a deadline. The agent runs it as a background job, so reconciliation and health checks are never held up, and one node runs one backup at a time unless `TUG_BACKUP_CONCURRENCY` says otherwise.

| Target | What happens |
| --- | --- |
| Service | Runs your `command` through an exec in the running container and streams its output into `restic backup --stdin`, so no staging disk is needed. The command sees the container's environment, including its secrets, so read passwords from the environment (`$MARIADB_ROOT_PASSWORD`) and they never appear in tug's configuration, payloads or events. A command that fails, writes nothing or lacks the `verify` text is never kept: the partial snapshot is forgotten and the run fails. The service must be running on the node |
| Volume | Mounted read-only into the restic container and archived, with your `exclude` patterns. A volume that does not exist on the node fails the run instead of backing up an empty one |
| Retention | Runs after each successful backup (`restic forget --prune` per node and target). Snapshots tagged `trigger:pre-restore` are kept regardless |

Restic runs in a helper container with a memory limit, labelled `tug.job` and removed when it finishes. An agent that restarts mid-job removes leftovers and reports the job failed. The image comes from `TUG_RESTIC_IMAGE` on control (default `restic/restic:0.19.1`, and a digest reference is recommended), which nodes pull outbound like any published image. Before mounting a managed volume, backup and restore check its project and volume ownership labels, and a scratch restore checks its scratch volume's project and restore labels. A conflicting or unlabelled volume is refused.

## Recipes

tug has no database support of its own. Each recipe is a command for the service container. In a Compose file, use `$$` for variables the container shell must expand, because a single `$` is read by `tug deploy` as a value to take from control. A single `$` in a `command` or `restore` fails the deploy with `compose.yaml needs values that are not set on control: MARIADB_ROOT_PASSWORD`. When the unset name is used in an `x-tug.backup` field, the error adds a second line that says it may be a container variable and shows the field with `$$`:

```text
MARIADB_ROOT_PASSWORD is used in an x-tug.backup field. If it is a variable of the container and not a value from control, write $$MARIADB_ROOT_PASSWORD so the container expands it: mariadb-dump -uroot -p"$$MARIADB_ROOT_PASSWORD" --all-databases
```

Names outside `x-tug.backup` get only the first line. Read credentials from the container environment, write the data to standard output, and give `verify` the line the tool prints on success.

```yaml
# MariaDB (use mysqldump and MYSQL_ROOT_PASSWORD for MySQL)
backup:
  command: mariadb-dump -u root -p"$$MARIADB_ROOT_PASSWORD" --single-transaction --quick --routines --events --triggers --add-drop-database --databases wordpress
  filename: wordpress.sql
  verify: "-- Dump completed"
  restore: mariadb -uroot -p"$$MARIADB_ROOT_PASSWORD"

# PostgreSQL
backup:
  command: pg_dump -U "$$POSTGRES_USER" --clean --if-exists "$$POSTGRES_DB"
  filename: app.sql
  verify: "PostgreSQL database dump complete"
  restore: psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -v ON_ERROR_STOP=1

# SQLite file in a volume mounted into the service
backup:
  command: sqlite3 /data/app.db .dump
  filename: app.sql
  verify: COMMIT
  restore: sqlite3 /data/app.db

# A directory as a tar stream
backup:
  command: tar -C /var/www/html -cf - wp-content/themes
  filename: themes.tar
  restore: tar -C /var/www/html -xf -
```

`mariadb-dump` and `mysqldump` do not dump users and grants, which come from the image's init environment. A service has one backup command, so to include PostgreSQL roles, chain them: `sh -c 'pg_dumpall --globals-only; pg_dump ...'`. Each recipe has a `restore:` command that reads the stored file on standard input, so `tug restore run <service> --confirm` can load it back. Without `restore:`, tug refuses to restore the service. To check a snapshot by hand, run `restic dump <snapshot> wordpress.sql | mariadb ...`.

## Watch your backups

`tug events` shows these backup events:

| Event | Meaning |
| --- | --- |
| `backup.completed` | A run succeeded |
| `backup.failed` | A run failed. A failed scheduled run is retried once after ten minutes |
| `backup.missed` | The node did not pick it up before its deadline (`node_offline`), or control was not running at the slot. A week of downtime gives one missed event and one catch-up run per target, not a burst |
| `backup.stale` | A target has no success for two periods. Raised once a day, which catches a destination key that quietly stopped working |
| `backup.no_destination` | No destination is configured |
| `backup.cancelled` | Someone ran `tug backup cancel <run>`. A cancelled backup is a warning and is not retried |

While control is down no backup starts, which is the price of one scheduler. Running jobs finish and report when control returns. `tug backup run` takes a backup now, and `tug backup list` shows the catalog, see [CLI](cli.md#backups).

## Restore

```sh
tug restore run db
tug restore run db --confirm
tug restore run uploads --scratch --confirm
```

The first command prints the plan and changes nothing. The second restores the latest backup of the `db` service. The third restores files into a new volume and touches nothing live. In a terminal, `tug restore run` offers a target when omitted, `--select-snapshot` chooses a successful catalog backup, and `--select-writers` overrides writer discovery, see [interactive selection](cli.md#interactive-selection).

A restore plan and its queued restore refresh backup placement from the latest successful deployment before choosing a node. Check the printed target before confirming.

Restores are as generic as backups:

- **A service** is restored by running its `x-tug.backup.restore` command in the running container with the stored file on standard input. A MariaDB service uses `restore: sh -c 'mariadb -uroot -p"$$MARIADB_ROOT_PASSWORD"'`. A service without a `restore` command is refused.
- **A volume** is emptied and filled from the snapshot, or restored into a new volume with `--scratch`.

`tug restore` returns when the data is back and the services it stopped report serving again, or after five minutes with a warning. An in-place restore goes in order:

| Step | What tug does |
| --- | --- |
| 1. Lock | Locks the project, so a deploy, rollback or secret change gets a clear refusal while it runs |
| 2. Stop writers | Stops the `writers` you named, or the ones discovered from `depends_on`, host names in environment variables such as `WORDPRESS_DB_HOST=db` or `mysql://u@db:3306/app` (for a service), or volume mounts (for a volume), including everything that depends on them. If none are found it refuses unless you pass `--writers` or `--no-writers`, because an app that reaches the database without `depends_on` is the hole in discovery |
| 3. Safety backup | Backs up the current data, tagged `trigger:pre-restore`, exempt from retention and not applying retention itself. Skip it with `--no-safety-backup`. If it fails, nothing has changed: the writers start again and the lock drops |
| 4. Restore | Restores, then starts the writers and unlocks. A volume is first restored into a hidden directory inside itself (`.tug-restore-<id>`) and every file is read and verified. Only then is the live content replaced, so an unreadable repository leaves the volume as it was. This needs free space in the volume for a second copy of the snapshot |

- **Stalls.** A restore whose restic command makes no progress for ten minutes ends as `interrupted` with the reason, and the writers stay stopped.
- **Failures.** If the restore fails, the writers stay stopped and the project stays locked, because a half-restored database serving traffic is worse than an outage. `tug restore resume <id>` tries again, and `tug restore release <id>` starts the services anyway.
- **Same-target snapshots only.** A snapshot can be restored only into the target that produced it (its `project:` and `target:` tags are checked). tug does not restore a snapshot into a different project.
- **Scheduled backups** of a target are skipped while it is being restored.
- **Events:** `restore.started`, `restore.completed`, `restore.failed`, `restore.released`.
- **Health checks through a writer.** While a writer is held, a service that health-checks through it (an nginx check that requests a PHP page) is unhealthy, so its node reports a failed apply and the deployment looks failed until the hold ends. Give such services a check that does not depend on the writer (a static `/healthz`). If a writer never reports held within five minutes, the restore fails and the error names the node, the writer's state and the apply error.

## Restore drill

A backup you have not restored is a hope. Start with an isolated restore that changes no live data, and time it.

1. **Check the catalog.** `tug backup list` shows every target with its last success, and the newest run should be recent and `succeeded`. `tug backup password` prints the repository and password, so you can also run `restic snapshots` from any machine that reaches the bucket.
2. **Restore files into a scratch volume.** `tug restore run wp-content --scratch --confirm` reads the latest snapshot into a new volume and touches nothing live. List it with `docker run --rm -v <volume>:/data alpine ls /data` on the node, then remove it with `docker volume rm <volume>`.
3. **Restore the database into a throwaway container.** Use the project repository and its escrowed password to read the snapshot with `restic dump <snapshot> wordpress.sql` into a separate database container. Verify known data without connecting the test container to production services, mail or scheduled jobs. This manual end-to-end drill has not been validated on a fresh host.
4. **Write down how long it took.** That is your real recovery time.

## Recover a site on a replacement node

This is a manual procedure, not automatic failover. It was exercised with the published 0.9.0 release in the [real-host drill](real-host-evaluation.md#recovery-drill-with-the-published-090-release-2-november-2026) and again with S3-compatible backups and named volumes on the 1.0.0 candidate ([drill](real-host-evaluation.md#recovery-drill)). The original host was simulated as unavailable while control and the backup destination stayed available. Restore control first if it is also lost.

1. **Fence and enroll.** Fence the lost node, or otherwise ensure its old workloads cannot write to shared services. Enroll the replacement node and check that it is online. Keep the recovery site private while its database and volumes are empty, and never expose a fresh WordPress installer.
2. **Move placement and deploy.** Change the project's service and volume placement to the replacement node and deploy the same project with the retained images, configuration and secrets. tug refuses until you acknowledge that stateful services start empty: add `--move <service>` for each one it names (`--move db --move wordpress`). It then holds the services that write to them, including a writer that moved too. The replacement uses fresh local volumes, so deploying alone does not restore their contents.
3. **Preview each restore.** Run `tug backup list`, then `tug restore run db` and `tug restore run wp-content` without `--confirm`. Check that each plan names the replacement node and the snapshot you want. If the latest is not the one, use `--from` with the backup run or snapshot id. Never confirm a plan aimed at the wrong host.
4. **Restore and verify.** Run the printed commands with `--confirm`. tug takes a safety backup and stops the writers, so wait for each restore to finish and investigate any warning. Verify known database content and uploaded files, probe the app, then re-enable traffic and update DNS or routing.

This does not restore data that was never backed up, external services, DNS, or changes after the selected snapshots. A live workload can write new data during recovery unless traffic and other writers are fenced, and control alone cannot fence an unreachable or compromised host.

## Control plane backup

Control has two kinds of backup. The automatic one covers losing the control host when nobody took a manual copy. The manual one gives you a portable archive to keep in your own encrypted storage, take before an upgrade or carry through a migration. Neither includes workload volumes.

### Automatic backup to the destination

As soon as a backup destination exists, control backs itself up with nothing more to configure.

| Property | Behavior |
| --- | --- |
| Cadence | Every night, and again an hour after a failure (`TUG_CONTROL_BACKUP_INTERVAL_MS`, `TUG_CONTROL_BACKUP_RETRY_MS`, see [Configuration](configuration.md)) |
| Contents | A consistent snapshot of the database, the private CA and the master key. Retained build images are left out, since a deploy rebuilds them |
| Where | A restic repository named `_control` next to the project repositories |
| Retention | Last 3 snapshots, plus 7 daily, 4 weekly and 6 monthly |
| Who runs it | Control runs the restic helper on its own Docker socket, so the control host needs no node and no cron job |
| Stalls | restic retries a failing store (a missing bucket, a refused login, an unreachable host) for many minutes. When it prints only retry notices for two minutes (`TUG_CONTROL_BACKUP_STALL_MS`), the backup fails with restic's final message and last cause, which `tug backup list` shows |

Create the bucket first. A repository is initialized only when restic's final answer is that it does not exist, so a bucket created while a backup was retrying is picked up by the next attempt.

`tug backup list` shows a `control` line with the last success in the destination now in use. Switching destination starts a first backup there and reports it as unprotected until that backup completes. A local-path destination (for development) is labelled `local path only: not off-host`. `tug backup list --check` fails when the last control backup failed, when none succeeded for twice the interval (two days by default), or when a destination has had no completed backup an hour after it was set. `tug events --project _control` shows `backup.completed` and `backup.failed`.

**The control password.** The control repository has its own password, derived from the master key like each project's. Nodes receive only the passwords of the projects they run, so a node that holds the destination credentials can delete or overwrite control snapshots but cannot read or forge one. The master key is inside the archive, so keep the derived password off the server. `tug backup password --control` prints it with the repository. It is the one value to escrow, with the destination credentials you already keep: it opens `_control`, and the restored archive brings back the master key from which every project password derives again. It never changes while the installation keeps its master key. Enable bucket versioning if you want snapshots to survive a compromised node, and test object lock with restic before relying on it, because control prunes old snapshots.

**Test your setup** before you need it:

1. Run `tug control backup`. It stores a backup in the destination now and prints the repository and snapshot id.
2. Run `tug control backup list`. It reads the destination itself, so it shows what is stored (snapshot ids, times, sizes and contents), next to the archives on the control host.
3. Save the output of `tug backup password --control` somewhere that does not depend on the server.
4. Run `tug control restore --from-destination <url> --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY` with that password (`TUG_CONTROL_BACKUP_PASSWORD`, or `--password-stdin`). Without `--confirm` it is a preview: it fetches the newest snapshot, checks the archive, database integrity, CA and that every secret decrypts, prints what the backup holds, and changes nothing. Add `--snapshot <id>` to check a specific one.

To recover on a fresh host, see [Recover control on another host](control-plane.md#recover-control-on-another-host). Restoring an older snapshot forgets what happened after it, see [Backups and authorization history](control-plane.md#backups-and-authorization-history).

### Manual archives

`tug control backup --local` needs an `admin` credential and writes an archive on the control host, in `TUG_CONTROL_BACKUP_DIR`, with the retained build images unless you pass `--no-images`. Keep images when some deployments exist only in tug's build store. To get the archive onto your machine:

```sh
tug control backup -o recovery.tar.gz
```

`-o <file>` implies `--local` and `--download` (`--download` alone picks a generated name), refuses to overwrite an existing file, and creates the copy `0600`. It prints the path, whether build images are included, and where the copy on control remains, because the download does not remove it. The archive holds the master key, every secret and the private CA key, which can issue credentials for the whole installation, so store it encrypted. Archives accumulate in `TUG_CONTROL_BACKUP_DIR`, and you delete old ones.

To restore the exact file you kept, run `tug control restore --from-file recovery.tar.gz --confirm`. It uploads the file to the control being restored, so you do not copy it into that host's volume first. Without `--confirm` it only checks the file. A path on the control host works as a positional argument: `tug control restore <path> --confirm`. After a restore, restart control with `tug control restart` ([Control plane](control-plane.md#backup-and-restore)). Commands queued or in flight when the backup was taken are retired rather than delivered again, the workload backup runs they carried are closed (missed or failed, never left queued), and unfinished workload restores are marked failed or interrupted so you can resume or release them.

## Jobs on a node

A node runs backup and restore jobs in lanes: a restore and its safety backup first, then a backup someone asked for, then scheduled ones.

- **One job per project.** A node never runs two jobs of one project at once, because they contend for the project's repository lock.
- **Concurrency.** It runs two at a time only on a host with 3 GiB or more of memory, since each restic helper reserves 512 MB by default. Set `TUG_BACKUP_CONCURRENCY` on the agent to change that.
- **Queue.** `tug backup list` shows a job waiting for a slot as `queued behind <run>`, with the run id in its last column.
- **Stall limit.** Every restic command fails when it makes no progress for ten minutes, so a damaged repository or an unreachable store cannot hold a slot for the whole job limit. A prune that stalls after the snapshot was taken is a warning on the run, not a failed backup.
- **Cancel.** `tug backup cancel <run>` stops a queued or running backup. `tug restore cancel <id>` stops a restore that is waiting on its safety backup (nothing has changed) or restoring (it is interrupted and its services stay stopped until `resume` or `release`). An agent older than control ignores a cancel.

## Known limits

| Limit | Detail |
| --- | --- |
| No push notifications | A failed night is a `backup.failed` or `backup.stale` event, until [webhooks](roadmap.md#m8--central-api-advantages-partly-done) exist. Run `tug backup list --check` from cron or a monitor. It exits nonzero when a target is stale, failed or missed, and when nothing is protected (pass `--allow-empty` for a project without data) |
| Control down | No backup starts. Running jobs finish and report when control returns, and a long gap yields one missed event and one catch-up run per target |
| Consistency | Live volumes are crash-consistent, not application-consistent. Use a command backup for anything with its own consistency |
| One node per volume | A volume is backed up from the node that holds it. A volume mounted from a file server with `driver_opts` is read through that node's mount, so back up the file server's own disk where you can |
| Not built | Repository maintenance (`restic check`, a read-verify of the data) and SFTP destinations |
| Leftovers | A scratch restore leaves its volume (`tug_r<project-length>_<project>_<id>`) behind, and the safety snapshot of every in-place restore is kept for ever. No command lists or removes either. Remove scratch volumes with `docker volume rm` on the node, and safety snapshots with `restic forget` using the repository from `tug backup password` |
| Helper memory | The restic helper defaults to 512 MB, half of a 1 GB host. Lower it with `memory` under `x-tug.backup`. Larger repositories need more, so test the limit against your data |
| `tug exec` | Cancelling it does not stop the remote process |

### DigitalOcean Spaces needs path-style addressing

A destination URL in the bucket-subdomain form makes restic use virtual-host-style addressing (`<bucket>.<region>.digitaloceanspaces.com`), and the Spaces gateway closes the TLS connection mid-call on those requests. Every backup then dies in `restic init` with `client.BucketExists: EOF`, a raw connection error rather than an S3 error, while read-only calls (`restic snapshots`, `restic cat config`) against the same URL succeed. The private-VPC endpoint hides the failure as a network fault, and tcpdump on the node shows the gateway completing the handshake, sending some response data, then FIN and RST. Credentials, container context, network mode, the helper container and the restic image (0.17.3 and 0.19.1 behave identically) all check out, so the cause is upstream restic or MinIO behavior. Use the path-style form, the only one restic supports for S3-compatible endpoints ([Preparing a new repository](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)):

```text
s3:https://<region>.digitaloceanspaces.com/<bucket>/<prefix>
```

## Reference

Backup destination settings: the control plane uses one destination, and `tug backup destination set` replaces it. Setting or removing a destination updates its configuration and stored credentials atomically, and a database failure leaves the previous ones intact. Command options are in the [CLI reference](cli.md#backups).

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `TUG_BACKUP_TICK_MS` | Control | `30000` | Scheduler tick |
| `TUG_RESTIC_IMAGE` | Control | `restic/restic:0.19.1` | restic helper image |
| `TUG_BACKUP_CONCURRENCY` | Agent | `2` on 3 GiB or more, else `1` | Concurrent backup jobs per node |
| `TUG_CONTROL_BACKUP_INTERVAL_MS`, `TUG_CONTROL_BACKUP_RETRY_MS`, `TUG_CONTROL_BACKUP_STALL_MS`, `TUG_CONTROL_BACKUP_LIMIT_MS`, `TUG_CONTROL_BACKUP_DIR` | Control | See [Configuration](configuration.md#control-plane) | Control backup timing and location |
