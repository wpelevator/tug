# Backups and recovery

Mark a service or a volume with `x-tug.backup`, give control one restic repository location (S3-compatible storage, a REST server and other [destinations](#destinations)), and agents run [restic](https://restic.net) on the node that holds the data on a schedule. There is no backup container to build or keep alive.

## Set up your first backup

You need storage restic can use, reachable from the control host and from the workload node, and credentials allowed to use it. The example uses S3-compatible storage, see [Destinations](#destinations) for the others. Create the bucket first. Mark each target in your Compose file as shown in [Compose extensions](compose.md#backups), and see the [WordPress example](https://github.com/wpelevator/tug/blob/main/examples/wordpress/README.md) for a database and files together. A top-level schedule only supplies defaults and enables nothing.

```sh
# Supply the values through your shell or secret manager. Do not commit them.
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
tug backup destination set s3:https://s3.example.com/bucket/tug-backups --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY
tug backup destination check
tug deploy
tug backup run
tug backup list --check
tug backup password
```

| Command | What it tells you |
| --- | --- |
| `backup destination set` | Saves the destination, then runs the same check as `destination check`. A failed check is a warning and the exit code stays 0 (`--no-check` skips the check) |
| `backup destination check` | Opens control's repository from the control host and each project's repository from the node that runs its backups, and exits nonzero if any fails |
| `backup run` | Waits for the configured targets and reports failure |
| `backup list --check` | Whether each target succeeded, and exits nonzero if not |
| `backup password` | The repository and its password. Store it, with the storage credentials, off the server |
| `backup destination show` | The destination, without credential values |

The password is derived from control's master key, so losing both the password and the master key makes the repository unreadable. Credentials are encrypted on control and released only to a node running a backup. Each project has its own repository under `<destination>/<project>`, and commands use the [resolved project](cli.md#arguments-options-and-configuration).

Control also backs itself up to the same destination every night, see [Control plane backup](#control-plane-backup). Configure [signed webhooks](observability.md#alerting) for backup failures, missed protection and recovery notifications. Delivery is best effort; keep an independent scheduled `tug backup list --check`.

## Destinations

A destination is a restic repository location. `tug backup destination set <url>` accepts these forms, and each project and control get their own repository below it. Credentials are never part of the URL: pass them as `--env` variables, which control stores encrypted. `RESTIC_PASSWORD`, `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` are managed by tug and refused.

| URL form | Credentials (`--env`) | Status |
| --- | --- | --- |
| `s3:https://host/bucket[/prefix]` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (required) | Exercised on real hosts |
| `rest:http://host:8000/path` | `RESTIC_REST_USERNAME`, `RESTIC_REST_PASSWORD`, or none for a server started with `--no-auth` | Verified against restic's `rest-server` |
| `b2:bucket:path` | `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY` | Accepted, not yet exercised in a real-host run |
| `azure:container:/path` | `AZURE_ACCOUNT_NAME` with `AZURE_ACCOUNT_KEY` or `AZURE_ACCOUNT_SAS` | Accepted, not yet exercised in a real-host run |
| `gs:bucket:/path` | `GOOGLE_PROJECT_ID` with `GOOGLE_ACCESS_TOKEN`, or `GOOGLE_APPLICATION_CREDENTIALS` | Accepted, not yet exercised in a real-host run. A credentials file path must exist inside the helper container, which tug cannot provide, so prefer `GOOGLE_ACCESS_TOKEN` |
| `swift:container:/path` | The `OS_*` variables restic documents for your Keystone setup | Accepted, not yet exercised in a real-host run |
| `/absolute/path` | None | Development only: the path is read on each node and is not shared between nodes |

Each backend's variables are listed in restic's [Preparing a new repository](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).

### REST server

A [rest-server](https://github.com/restic/rest-server) is the simplest destination you host yourself:

```sh
export RESTIC_REST_USERNAME RESTIC_REST_PASSWORD
tug backup destination set rest:http://backup.internal:8000/tug --env RESTIC_REST_USERNAME --env RESTIC_REST_PASSWORD
```

Plain HTTP is acceptable only on a private network or VPN that the control host and every node share. Use `rest:https://` anywhere else. A server started with `--no-auth` needs no `--env`.

### Append-only destinations

A server that refuses deletes, such as `rest-server --append-only`, protects snapshots from a compromised node, and it also refuses the `restic forget` that tug runs after each backup and the weekly `restic prune`. Tell tug that retention is yours:

```sh
tug backup destination set rest:http://backup.internal:8000/tug --retention external
```

With only `--retention` and the URL already in use, the stored credentials are kept. The mode belongs to the destination, so it applies to every project and to control's own backup, and setting the same URL again keeps it. `--retention managed` turns pruning back on, and a different URL starts managed. `tug backup destination show` and `destination check` print the mode. The check does not test whether the credentials can delete.

With `external`, tug never runs `forget` or `prune`, and each run records `retention: external`. The weekly [repository check](#verify-a-repository) still runs, because it only reads. You then own:

- **Pruning from the storage side**, by whatever your server offers, or by `restic forget --prune` with credentials that may delete (the repository and password come from `tug backup password`).
- **Safety snapshots.** The snapshot before each in-place restore is tagged `trigger:pre-restore` and is kept by tug's own retention. Keep that tag when you prune: `--keep-tag trigger:pre-restore`.
- **Partial snapshots.** When a command backup fails after restic stored a partial snapshot, tug forgets it. On an append-only server that cleanup fails, and the failed run's error says so.

Without the setting, an append-only server shows as a retention failure, which is the signal to set it. Two consecutive failed prunes turn `tug backup list --check` red, see [Watch your backups](#watch-your-backups).

### Not supported

`sftp:` is rejected because tug cannot give the restic helper container SSH keys or a `known_hosts` file. Run a rest-server and reach it over a private network or VPN, or use S3. `rclone:` is rejected because the helper image does not configure rclone.

### Check the destination

```sh
tug backup destination check
```

The check has two parts, because a node may reach the destination over a different network than control (a WireGuard address that only the node can route, for example).

1. Control opens `_control` and the repository of every project with an enabled backup target from the control host, in a restic helper container. An existing repository is `ok`. A missing one, which restic reports with exit code 10, is created with `restic init` and reported as `initialized`, which also proves the credentials can write. Anything else is `error` with restic's message: a wrong repository password (exit code 12), a bucket that does not exist, a refused login or an unreachable store. A bucket is never created by a check or a backup, so a typo in the bucket name fails instead. When `_control` fails, the project repositories are `skipped`, because they share the destination and would fail the same way, each after its own timeout. `_control` is only ever checked from control, since only control backs it up.
2. For each project and node that runs an enabled backup target, control queues a read-only `backup.check` job on that node, which opens the project repository with the node's own network path. A node reports `ok`, or `missing` when the repository is not there yet. `missing` is not a failure, because the node's first backup creates the repository. Anything else is `error` with restic's message. A node that is offline when the check starts is reported as `offline` and gets no job. A node that has not answered after three minutes is `timeout` and its job is cancelled; a node first finishes a backup it is running for the same project.

The check runs in the background: `POST /api/v1/backup/destination/check` answers `202` with a `checkId`, and the CLI polls `tug backup destination show` until that check is `done`, for up to ten minutes (`TUG_CHECK_TIMEOUT_MS`). Past that the CLI says the check is still running and exits 1; it keeps running on control. The stored `checkResult` has `state` (`running` or `done`), `repositories` (the control-host part) and `nodes` (`project`, `node`, `state`, `error`); a running result may have `pending` nodes. `ok` is false when a control-host repository is `error`, or a node is `error`, `offline` or `timeout`, and the command exits nonzero. A check that was running when control restarted is marked done with `ok: false` and an `error` saying so. A check refuses to start while control's own backup runs or another check is running, and the control-host part stops after four minutes.

Stderr has one line per repository, labelled `from control's host`, and one line per node naming the node and the project:

| Node state | What it means |
| --- | --- |
| `ok` | The node opened the project repository |
| `missing` | The node reached the destination and the repository does not exist yet; the node's first backup creates it |
| `error` | restic could not open the repository from the node; the line carries restic's message |
| `offline` | The node was not online when the check started, so it was not asked |
| `timeout` | The node did not answer within three minutes (`TUG_DESTINATION_CHECK_NODE_TIMEOUT_MS`) |

Replacing or removing the destination stops a running check and any control backup still writing to the old destination, so the check that `destination set` starts afterwards is never refused. A repository whose store only answers with retries, such as an unreachable host, fails the check after 45 seconds with restic's last error (for example `dial tcp …: i/o timeout`).

`initialized` means the check created a new, empty repository. During a [migration](migration.md#coming-from-an-existing-restic-setup) an unexpected `created a new, empty repository` means the destination path is wrong, because the repository you expected would have been found.

`tug backup destination set` runs the same check right after saving. The destination stays saved and the exit code stays 0 when the check fails: stderr says `saved; the check failed` and names the failing repositories, and you fix the cause and run `tug backup destination check`. A control too old to check destinations prints a warning instead. Pass `--no-check` to skip it.

Repositories are created by the first check or backup only when restic is 0.17 or newer, the first version that reports a missing repository with exit code 10. A failure from an image older than 0.17 says so. The stock image is new enough, so this matters only with a custom `TUG_RESTIC_IMAGE`.

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
| Retention | `restic forget` runs after each successful backup, per node and target, and drops the snapshots the policy no longer keeps. Their data is freed by the weekly prune, see [Verify a repository](#verify-a-repository). Snapshots tagged `trigger:pre-restore` are kept regardless |

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
| `backup.failed` | A run failed. A failed scheduled run is retried once after ten minutes. When restic exited with its lock code (11), the event metadata has `cause: "locked"`: the repository is locked by another restic, or by one that was killed |
| `backup.retention_failed` | The backup succeeded but applying retention (`restic forget`) failed, so old snapshots stay and the repository grows. Raised once, when pruning starts failing (and for control's own backup). The event metadata has `cause: "locked"` for a lock failure |
| `backup.retention_recovered` | Retention worked again after `backup.retention_failed` |
| `backup.verify_failed` | The weekly or manual `restic check` of a repository (or its prune) failed. Raised once, when it starts failing, on the project or on `_control` |
| `backup.verify_recovered` | A later check passed after `backup.verify_failed` |
| `backup.missed` | The node did not pick it up before its deadline (`node_offline`), or control was not running at the slot. A week of downtime gives one missed event and one catch-up run per target, not a burst |
| `backup.stale` | A target has no success for two periods. Raised once a day, which catches a destination key that quietly stopped working |
| `backup.no_destination` | No destination is configured |
| `backup.cancelled` | Someone ran `tug backup cancel <run>`. A cancelled backup is a warning and is not retried |

Exit status is the signal to wire into monitoring: `tug backup list --check` exits nonzero when a target is stale, failed or missed, when its retention failed in two runs in a row (or once with a lock failure), when the last repository check or prune failed, or when nothing is protected. One failed forget is not a problem: on a project with several nodes a prune takes an exclusive lock on the shared repository while another node's backup holds a shared one, so a single overlap is harmless. Pruning is now a weekly job for that reason, not part of every run. A run whose retention works clears the problem. A destination set to `--retention external` never reports one. Run it from cron or a monitor, and keep running it during a [migration](migration.md#coming-from-an-existing-restic-setup), when the old backup system may be failing without anyone noticing.

While control is down no backup starts, which is the price of one scheduler. Running jobs finish and report when control returns. `tug backup run` takes a backup now, and `tug backup list` shows the catalog, see [CLI](cli.md#backups).

## Verify a repository

A backup that completes says only that restic wrote it. Once a week per repository, control checks that the repository is readable, and it frees the space of forgotten snapshots:

1. Control picks one repository at a time, from `backup_schedules` of projects that have a successful backup. The first time a repository is seen it is scheduled at a point inside the next week, chosen from its name, so projects on one destination are not pruned together.
2. It queues `backup.maintain` on the node that runs the project's backups, which runs `restic prune` and then `restic check`. The check runs even when the prune failed. A destination set to `--retention external` is never pruned, only checked.
3. Control's own repository is checked weekly from control (without a prune, because control's nightly backup already prunes it).
4. The outcome is stored per repository: prune and check results, the node, when it ran and restic's message. It is shown by `tug backup list`, raises `backup.verify_failed` once when it starts failing and `backup.verify_recovered` when it passes again, and turns `tug backup list --check` red until a later run passes. A failed run is tried again after six hours, a passing one after a week. Replacing the destination clears the records.

```sh
tug backup verify
tug backup verify --read-data-subset 5%
tug backup verify --control
```

`verify` runs the check now, in the background, and never prunes. `restic check` alone reads the repository's structure. `--read-data-subset` (a fraction such as `1/10`, a percentage or a size) also downloads that part of the stored data and verifies it, which catches bit rot at the price of bandwidth from the destination. It needs the admin role. A repository that has no snapshot yet cannot be checked and is skipped until its first backup succeeds. `TUG_MAINTENANCE_TIMEOUT_MS` (default six hours) bounds one job.

### Protection levels

`tug backup list` shows one level for each target, and never more than what has run:

| Level | Meaning |
| --- | --- |
| (none) | The destination is a local path, or the target has no recent success |
| `off-host` | The destination is not a local path and the target has a recent success |
| `verified` | A repository check finished successfully after the target's latest successful backup. A newer backup drops the target back to `off-host` until the next check |
| `restore-tested` | `verified`, and a scratch restore of the target has succeeded at some time. It is not tied to the newest snapshot: a restore drill proves that restoring works, not that every snapshot restores, see [Restore drill](#restore-drill) |

The levels are in `GET /api/v1/backups` as `protection` on each target, with the repository's last check as `verify` and `maintenanceRunning`.

## Unlock a repository

A backup that fails with `the repository is locked` (restic exit code 11) could not take the repository lock. Most often a restic was killed while it held one and its lock is still there. restic gives up on such a lock only after it has gone 30 minutes without a refresh, so later backups wait for it and fail meanwhile. The failed run, `tug backup list` and `tug backup list --check` name the fix:

```sh
tug backup unlock
tug backup unlock --control
```

The first runs `restic unlock` on the project's repository, from the node that runs its backups. The second does it on control's own repository, from control. Both need the admin role, hold the project lock for the duration (the second takes none) and are audited as `backup.unlock`. The answer is `{removed, remaining}`, the locks before and after.

Only stale locks are removed. tug never passes `--remove-all` and never unlocks by itself, because a lock can belong to a prune running on another host, and removing it would let two writers meet. A `remaining` above zero means a restic is running now or its lock has not gone stale yet, so run the command again after 30 minutes. From 4.0 a stopped helper releases its lock first, see [Jobs on a node](#jobs-on-a-node), so a stale lock should be rare.

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

- **Stalls.** A restore whose restic command makes no progress for fifteen minutes ends as `interrupted` with the reason, and the writers stay stopped.
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

## Clean up after restores

A restore leaves things behind on purpose. A scratch restore keeps its volume so you can look at the files, and every in-place restore keeps the safety snapshot taken first (tagged `trigger:pre-restore`, exempt from retention) so you can undo it. They accumulate until you remove them:

```sh
tug restore list
tug restore remove rst_ab12cd34
tug restore remove --expire-safety 30d
```

`restore list` prints the recent restores, then one line per scratch volume still on its node and per safety snapshot still in the repository. `restore remove <id>` removes what that restore left: the scratch volume (an agent command on the restore's node, which refuses a volume whose labels do not name that project and restore) or the safety snapshot (a `backup.forget` job that forgets exactly that snapshot, never a regular backup or another project's). `--expire-safety <age>` (`90m`, `12h`, `30d`, `2w`) forgets the safety snapshots of every restore that finished longer ago than that, in one job. Both need the admin role, take the project lock, and are audited as `restore.removed` and `restore.safety_expired`.

Rules that keep it safe:

- A safety snapshot is removable only once its restore `succeeded` or was `released`. While a restore failed or is interrupted, the snapshot is the copy of what the data was, so it is not listed.
- A scratch volume is removable once its restore succeeded or failed.
- A forget frees the snapshot, and the space comes back with the next weekly prune, see [Verify a repository](#verify-a-repository).
- On an append-only destination (`--retention external`) deleting a snapshot is refused with the reason before any job is queued, because the server refuses deletes. Forget it from the storage side, with credentials that may delete. A scratch volume is not in the repository and can still be removed.

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

Create the bucket first. A repository is initialized only when restic exits with code 10 (the repository does not exist). A missing bucket makes restic retry and fail, so a bucket created while a backup was retrying is picked up by the next attempt.

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
- **Stall limit.** Every restic command fails when it makes no progress for fifteen minutes, which is longer than the ten minutes it waits for a repository lock (`--retry-lock`), so waiting for a lock is not reported as a stall, while a damaged repository or an unreachable store still cannot hold a slot for the whole job limit. A prune that stalls after the snapshot was taken is a warning on the run, not a failed backup.
- **Cancel.** `tug backup cancel <run>` stops a queued or running backup. `tug restore cancel <id>` stops a restore that is waiting on its safety backup (nothing has changed) or restoring (it is interrupted and its services stay stopped until `resume` or `release`). An agent older than control ignores a cancel.
- **Stopping restic.** When a job is cancelled, times out or stalls, and when an agent or control restarts with a helper left over, tug sends restic SIGINT and gives it 20 seconds to exit before removing the helper container. A restic killed in the middle of a prune would leave its exclusive lock in the repository and block every later backup until the lock went stale.

## Known limits

| Limit | Detail |
| --- | --- |
| Best-effort notification | A failed night produces a `backup.failed` or `backup.stale` event and a [configured webhook](observability.md#alerting). Delivery may be lost across control outages or shutdown. Run `tug backup list --check` from cron or a monitor. It exits nonzero when a target is stale, failed or missed, when its retention keeps failing, and when nothing is protected (pass `--allow-empty` for a project without data) |
| Control down | No backup starts. Running jobs finish and report when control returns, and a long gap yields one missed event and one catch-up run per target |
| Consistency | Live volumes are crash-consistent, not application-consistent. Use a command backup for anything with its own consistency |
| One node per volume | A volume is backed up from the node that holds it. A volume mounted from a file server with `driver_opts` is read through that node's mount, so back up the file server's own disk where you can |
| Rejected destinations | `sftp:` and `rclone:` URLs, see [Not supported](#not-supported) |
| Leftovers | A scratch restore leaves its volume (`tug_r<project-length>_<project>_<id>`) behind, and the safety snapshot of every in-place restore stays in the repository until you remove it. `tug restore list` shows both and `tug restore remove` clears them, see [Clean up after restores](#clean-up-after-restores) |
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
| `TUG_RESTIC_IMAGE` | Control | `restic/restic:0.19.1` | restic helper image. Must be 0.17 or newer, the first release that exits with code 10 for a missing repository; older images cannot create repositories automatically |
| `TUG_BACKUP_CONCURRENCY` | Agent | `2` on 3 GiB or more, else `1` | Concurrent backup jobs per node |
| `TUG_CONTROL_BACKUP_INTERVAL_MS`, `TUG_CONTROL_BACKUP_RETRY_MS`, `TUG_CONTROL_BACKUP_STALL_MS`, `TUG_CONTROL_BACKUP_LIMIT_MS`, `TUG_CONTROL_BACKUP_DIR` | Control | See [Configuration](configuration.md#control-plane) | Control backup timing and location |
