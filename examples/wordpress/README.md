# WordPress with scheduled backups

One WordPress site and its MariaDB on a single node, with encrypted daily backups to an S3-compatible bucket, a one-command restore, and a one-off command runner for `wp-cli`. There is no backup container and no backup script: Tug runs [restic](https://restic.net) itself.

```bash
# 1. Secrets for the site
tug secret-set DB_PASSWORD
tug secret-set DB_ROOT_PASSWORD

# 2. Where backups go (once per control plane). Values come from your environment or stdin.
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  tug backup-destination-set s3:https://s3.example.com/my-bucket/tug-backups \
  --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY

# 3. Deploy (edit the node name "app" and the host "blog.example.com" first)
tug deploy -f docker-compose.yml

# 4. Check the first backup now instead of waiting for 03:00 UTC
tug backup-run
tug backup-list
```

Print the project's repository password and keep it somewhere safe, apart from the server: `tug backup-key`. Losing control's master key without it loses every backup.

## What gets backed up

| Target | How | Declared as |
| --- | --- | --- |
| `service:db` | `mariadb-dump` runs inside the database container and is streamed into restic. The dump must end with `-- Dump completed`, otherwise the run fails and nothing is kept. | `x-tug.backup.command` on `db` |
| `volume:wp-content` | The volume is mounted read-only and archived, without `cache/`. | `x-tug.backup` on the volume |

Both use the project defaults at the top of the file: 03:00 UTC daily, keeping 7 daily, 4 weekly and 6 monthly snapshots. To back up something else, add `x-tug.backup` to it; the [recipes](../../docs/backups.md#recipes) show PostgreSQL, SQLite and a directory as a tar stream.

## Restore

```bash
tug restore db                  # prints the plan and changes nothing
tug restore db --confirm        # latest backup of the database
tug restore wp-content --scratch --confirm   # files into a new volume, nothing live touched
```

An in-place restore locks the project, stops WordPress (it depends on `db`), takes a safety backup of the current data, restores, then starts WordPress again. See [Restore](../../docs/backups.md#restore).

## One-off commands

```bash
tug run wordpress -- php -v
tug run wordpress -- sh -c 'ls -la wp-content/themes'
```

`tug run` starts a one-off container with the service's image, environment, network and mounts, returns the command's exit code, and removes the container when the command ends. The stock `wordpress` image has no WP-CLI; if you add it to your image, `tug run wordpress -- wp core update-db --allow-root` is the same idea for upgrades.
