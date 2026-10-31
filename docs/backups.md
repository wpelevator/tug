# Backing up WordPress sites

This page is the interim backup recipe for production sites. Roadmap milestone M11 (`x-tug.backup`) will make Tug schedule, verify and restore backups itself; until it ships, a backup sidecar service in the project's Compose file does the job with tools Tug already deploys. When `x-tug.backup` exists this page will be replaced by the native workflow, and the sidecar can be deleted from your Compose file without touching your data.

The working example is [`examples/wordpress-backup`](../examples/wordpress-backup/docker-compose.yml). It is checked by the test suite for validity, `${VAR}`-only credentials and placement, and its image and script were run against a real MariaDB 11.4 and a local restic repository. It has not been run through a full `tug deploy` on a real host, against a real S3 bucket, or through the restore drill below on a real node. Do the drill once before you rely on it.

## What to back up

| Data | Where it lives | How it is covered |
| --- | --- | --- |
| Database | `db-data` volume, MariaDB | Logical dump (`mariadb-dump --single-transaction`) streamed into restic. Never copy `/var/lib/mysql` of a running server. |
| Uploads, plugins, themes | `wp-content` volume | Read-only mount into the backup container, archived by restic. |
| Secrets | Tug control database | `tug control-backup` (below). The restic password is in this set: if you lose both it and the secret store, the repository cannot be decrypted. Keep a copy in your password manager too. |
| Control plane | Control host | `tug control-backup`: database, API tokens, master key, built images. It does not contain project data. |
| Compose file and `Dockerfile` | Your Git repository | Already versioned. |

`wp-config.php` is rebuilt from environment variables on every start, so it is not backed up. If you set fixed `WORDPRESS_AUTH_KEY` and the other salts as secrets they survive a rebuild; otherwise users are logged out after a restore.

## The sidecar recipe

The `backup` service in the example is built by control from `examples/wordpress-backup/backup/` (an Alpine image with `restic` and `mariadb-client`, plus `backup.sh`). Deploy from the example directory so the build context is uploaded. Once a day (`BACKUP_AT_UTC`, default 03:30 UTC) it:

1. Streams `mariadb-dump --single-transaction --routines --triggers --events` from the `db` service into a restic snapshot tagged `db`.
2. Archives every directory in `BACKUP_PATHS` into a snapshot tagged `files`. Volumes are mounted `:ro`, so a bug in the script cannot modify site data.
3. Runs `restic forget --group-by host,tags --prune` with the retention below.
4. On Sundays runs `restic check --read-data-subset=5%`.
5. On any failure logs `ERROR: ...` and stays alive to try again at the next window. Failure is visible in three places: `tug logs backup`, the Docker `HEALTHCHECK` (the container turns unhealthy when the last success is older than `BACKUP_MAX_AGE_HOURS`, default 30, and `x-tug.health: docker` reports it in `tug status`), and the optional `BACKUP_PING_URL` (a dead-man's-switch URL such as healthchecks.io; `/fail` is appended on failure).

`backup.sh once` runs one backup in the foreground and exits non-zero on failure, which is what the drill below and your first-run test use.

The image's tools come from Alpine 3.21 packages at build time (restic 0.17 and a MariaDB 11.4 client when this was written). The dump uses `--skip-ssl` because it crosses only the project's private Compose network on one node.

### Required secrets

Set these once, before the first deploy. Values must not contain `#`, `$`, spaces or newlines (see [Compose extensions](compose.md#secrets-in-services)); generate passwords with `openssl rand -hex 24`. Use a bucket and an access key that exist only for backups, with no permission to change bucket policy or lifecycle rules, so a compromised web server cannot rewrite history.

```bash
tug secret-set DB_PASSWORD
tug secret-set DB_ROOT_PASSWORD
tug secret-set RESTIC_REPOSITORY --value 's3:https://s3.eu-central-1.amazonaws.com/acme-backups/blog'
tug secret-set RESTIC_PASSWORD
tug secret-set AWS_ACCESS_KEY_ID
tug secret-set AWS_SECRET_ACCESS_KEY
tug secret-set BACKUP_PING_URL   # optional
```

Omit `--value` to read a secret from stdin, which keeps it out of shell history. Any S3-compatible store works: change `RESTIC_REPOSITORY` to `s3:https://<endpoint>/<bucket>/<path>` (Backblaze B2, Hetzner Object Storage, MinIO and so on) and put that service's keys in the two `AWS_` secrets. The first run creates the repository with `restic init`.

### First run

```bash
tug deploy -f examples/wordpress-backup/docker-compose.yml
tug exec backup -- backup.sh once        # exit code is the backup's exit code
tug exec backup -- restic snapshots
```

You should see one `db` and one `files` snapshot. Run the restore drill before calling it done.

### Retention

`KEEP_DAILY=7`, `KEEP_WEEKLY=4` and `KEEP_MONTHLY=6` are environment variables on the service; change them in the Compose file. Grouping by host and tags keeps `db` and `files` snapshots in independent histories, so a quiet uploads volume cannot crowd out database dumps. Pick the numbers from your recovery point and legal requirements, not from disk size: restic deduplicates, so 6 months of mostly unchanged uploads costs little. Add a bucket lifecycle rule only for incomplete multipart uploads; never expire restic's own objects, because `forget --prune` owns them.

## Several nodes and volumes

All variants use the same repository and the same image. `BACKUP_HOST` is stored as the snapshot host, so `restic snapshots` and restores can tell nodes apart (`--host app2`). A volume must be backed up from the node where its data physically lives.

### Volumes on a different node than the database

Run one backup service per node. The database node keeps the example service. Every other node gets a service with `DB_HOST: ""` (no dump) and its own volume and host name. Stagger `BACKUP_AT_UTC`: `forget --prune` takes an exclusive repository lock, and a backup that finds the lock held fails and retries the next day.

```yaml
  backup-app2:
    build: ./backup
    mem_limit: 256m
    restart: unless-stopped
    environment:
      RESTIC_REPOSITORY: ${RESTIC_REPOSITORY}
      RESTIC_PASSWORD: ${RESTIC_PASSWORD}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      BACKUP_HOST: app2
      BACKUP_AT_UTC: "04:30"
      DB_HOST: ""
      BACKUP_PATHS: /data/uploads
    volumes:
      - uploads:/data/uploads:ro
    x-tug:
      placement:
        nodes: [app2]
      health:
        type: docker
```

A database that is not on the node of the backup service is reachable only through a published port (see [A database on the same node](compose.md#a-database-on-the-same-node)). Prefer a backup service on the database's own node.

`placement.labels` with `global: true` runs one backup container on every node carrying a label, which saves repeating the block when all nodes have identically named volumes. It cannot give each node its own `BACKUP_HOST` (Compose cannot interpolate the node name), so the snapshots are told apart only by their paths and container host name. Prefer explicit per-node services when you restore by node.

### NFS volumes

A volume with `x-tug.type: nfs` is exported by one node and mounted over NFS by the others (see [Volumes](compose.md#volumes) and [Networking](networking.md)). Back it up from the exporter node, not from a client:

```yaml
  backup-shared:
    build: ./backup
    mem_limit: 256m
    restart: unless-stopped
    environment:
      RESTIC_REPOSITORY: ${RESTIC_REPOSITORY}
      RESTIC_PASSWORD: ${RESTIC_PASSWORD}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      BACKUP_HOST: nfs-exporter
      BACKUP_AT_UTC: "05:00"
      DB_HOST: ""
      BACKUP_PATHS: /data/shared
    volumes:
      - /srv/tug/shared:/data/shared:ro    # the volume's x-tug.export directory on the exporter
    x-tug:
      placement:
        nodes: [nfs-exporter]
      health:
        type: docker
```

Why the exporter: it reads the directory from local disk, so nothing crosses the network or depends on the mesh and the NFS server being up; there is no client-side caching or stale file handle to fight; export options such as `root_squash` do not hide files from the backup; and you store one copy, not one per client. The bind-mount path is the volume's `x-tug.export` (default `/srv/tug/<volume>`).

### Any other volume

Mount the volume read-only into the backup container and add its path to `BACKUP_PATHS`, a space-separated list. To add a `cache-data` volume to the example, add one line under `volumes:` and extend one variable:

```yaml
      BACKUP_PATHS: /data/wp-content /data/cache
    volumes:
      - wp-content:/data/wp-content:ro
      - cache-data:/data/cache:ro
```

The backup service must run on a node where that volume exists, and `backup.sh` fails the run if a listed path is not mounted.

### What M11 will automate

Scheduling and retention declared per service or volume instead of a sidecar image; running the job on the node that holds each volume without a service per node; database dumps for known engines; a recorded last-success per backup in `tug status`; and restore as a command. Until then the sidecar, the per-node services and the drill below are manual.

## Control plane backup

`tug control-backup` covers the control host only. Take it from a machine that holds an `admin` token, on the control host, and copy the archive off the host. The archive holds the master key and every secret, so treat it like a password vault and store it encrypted. Example `/etc/cron.d/tug-control-backup` on the control host (the runtime image runs the CLI; adjust to how you invoke `tug` there):

```cron
15 2 * * * root TUG_CONTROL_URL=http://127.0.0.1:8080 TUG_TOKEN=$(cat /etc/tug/admin.token) tug control-backup > /var/log/tug-control-backup.json 2>&1 && restic -r s3:https://s3.eu-central-1.amazonaws.com/acme-backups/control backup /var/lib/tug/control-backups --password-file /etc/tug/restic.pass
```

Put the S3 credentials in the crontab environment or a `restic.env` file with mode `0600`. Archives accumulate in `TUG_CONTROL_BACKUP_DIR`; prune old files with `find ... -mtime +14 -delete`. The cron line has not been run on a real control host; verify that `tug` is on the cron `PATH` and that the data directory matches your install (`TUG_CONTROL_BACKUP_DIR`, see [Configuration](configuration.md)). Restore with `tug control-restore <path> --confirm` and restart control ([Control plane](control-plane.md#backup-and-restore)).

## Restore drill

Rehearse into a scratch project so production is never touched. The scratch project has its own volumes (`<project>_<volume>`), so nothing is shared with the live site. Use a scratch node if you have one; on the production node pick another published port and hostname.

1. Copy the example to a scratch directory and edit three things: remove the `ingress` block or change `host`, change the published port if the node is shared, and turn the backup service into a restore shell by replacing its mount with a writable one and giving it an idle entrypoint:

   ```yaml
     backup:
       entrypoint: ["sleep", "infinity"]
       volumes:
         - wp-content:/data/wp-content   # no :ro, restic writes here
   ```

   To avoid redirects to the production URL, add `WORDPRESS_CONFIG_EXTRA: "define('WP_HOME','https://restore.example.com'); define('WP_SITEURL','https://restore.example.com');"` to `wordpress`. Also stop the scratch site from sending mail or running cron against production services.

2. Set the secrets for the scratch project. Reuse the restic ones (a read-only key is better if your store supports it) and generate new database passwords:

   ```bash
   export TUG_PROJECT=blog-restore
   for s in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do tug secret-set $s; done
   openssl rand -hex 24 | tug secret-set DB_PASSWORD
   openssl rand -hex 24 | tug secret-set DB_ROOT_PASSWORD
   tug deploy -f ./docker-compose.yml
   ```

3. Check the repository and list what you can restore:

   ```bash
   tug exec backup -- restic snapshots
   tug exec backup -- restic check
   ```

4. Restore the database, which streams from the repository straight into MariaDB. The `sh -c` runs inside the container, so `$DB_PASSWORD` is the container's value:

   ```bash
   tug exec backup -- sh -c 'restic dump --host app --tag db latest /wordpress.sql | MYSQL_PWD="$DB_PASSWORD" mariadb --host=db --user=wordpress --skip-ssl wordpress'
   ```

   `--host app` is the `BACKUP_HOST` of the service you are restoring. To restore an older state, replace `latest` with a snapshot ID from `restic snapshots`.

5. Restore the files. Restic stores absolute paths, so restoring to `/` puts them back under `/data/wp-content`:

   ```bash
   tug exec backup -- restic restore latest --host app --tag files --target / --include /data/wp-content
   ```

6. Verify:

   ```bash
   tug exec db -- sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -u wordpress wordpress -e "SELECT COUNT(*) AS posts FROM wp_posts WHERE post_status = \"publish\""'
   tug exec wordpress -- ls /var/www/html/wp-content/uploads
   tug restart wordpress
   ```

   Then open the scratch URL: the homepage renders, the newest post and its images are there, and you can log in to `/wp-admin/`. Compare the post count and the latest upload with production. Table prefix is `wp_` unless you changed it.

7. Remove the scratch project and its data when done: `tug volume-remove db-data --delete-data` and `tug volume-remove wp-content --delete-data` under `TUG_PROJECT=blog-restore`, then remove its services from the Compose file and deploy (or `unset TUG_PROJECT` and move on).

To restore production itself, run steps 4 and 5 in the live project with the same commands after making the backup container writable the same way, and take a fresh `backup.sh once` first. Write down how long the drill took: it is your real recovery time.

## Known limits

- One failed day is not noticed until you look (`tug status`, the ping URL) because the sidecar keeps running; wire `BACKUP_PING_URL` to something that alerts.
- Recreating the sidecar (for example on a deploy) resets the schedule; it does not run a backup at start unless `BACKUP_ON_START=1`.
- Database and files are separate snapshots taken minutes apart. For a WordPress site that is normally consistent enough; if a post was published between them its media may be missing from one side.
- The exec commands above rely on non-TTY `tug exec`, which is supported today. Cancelling an exec does not stop the remote process.
