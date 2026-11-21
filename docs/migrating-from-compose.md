# Migrating from Docker Compose

Move an app that runs with `docker compose up` on one server onto tug, keeping its data and a way back. The commands below set tug up beside the running stack, and the old stack stops only for the final copy.

```sh
tug lint
tug values
tug deploy --dry-run
```

`tug lint` checks the file against what tug accepts and needs no server. `tug values` lists every `${NAME}` and bare `environment` key the file uses and says which ones control does not hold yet. `tug deploy --dry-run` resolves them and checks the file against control. Run all three before you touch the old stack.

## What changes in the file

tug reads the Compose file itself and rejects what it cannot honor, naming the key. These are the ones a Compose app usually has.

| In your file | What tug does | Change |
| --- | --- | --- |
| `env_file` | Rejected. Values come only from control | `tug secret import .env` or `tug var import .env`, then list each name under `environment` |
| Top-level `secrets`, `configs` | Rejected | Store the value with `tug secret set NAME` and write `NAME: ${NAME}` under `environment` (a certificate for ingress is a secret named by `x-tug.ingress.cert`) |
| `deploy:` | Rejected, because it has Swarm meaning | Use `x-tug.replicas`, `x-tug.placement` and `x-tug.health` |
| `container_name`, `network_mode`, custom networks | Rejected | Remove them. Service names resolve inside the project network |
| `build:` and `image:` on one service | The image is deployed, nothing is built | Keep both when CI pushes the image. Use `tug deploy --build` or `x-tug.build: true` to build on control, see [Build or pull](compose.md#build-or-pull) |
| `environment: [KEY]` | Read from control like `${KEY}` | Set `KEY`, or write `KEY: ""` |
| Named volumes | Created empty under tug's own names. The volumes your Compose project made are not reused | Copy the data in, below. To attach an existing Docker volume instead, declare it with `external: true` and its `name:` |
| Ports | Bound to the node address or loopback, not every interface | Write `"0.0.0.0:80:80"` to publish on purpose, or use [ingress](ingress.md) |

The full list is in [Compose extensions](compose.md#supported-keys). An existing Docker volume attached with `external` stays outside tug's backups and volume records, so it suits a stopgap, not the end state.

## Cut over

Do these in order. Nothing before the stop changes the running site.

1. **Pin the project.** Put `project: <name>` in `tug.yml` (`tug init` writes it), so the project stays fixed when the directory is renamed. Without it, tug takes the Compose file's `name:`, then the directory name, see [Which project](configuration.md#which-project).
2. **Install control and a node** on the new server or the old one: `tug setup`, `tug node add`. See [Deploy your first service](getting-started.md).
3. **Move the values.** `tug secret import .env` makes every entry a secret, and `--vars NAME,...` makes the ones you name variables. `tug values` should end with nothing `missing`.
4. **Add the registry login** when an image is private: `printf %s "$TOKEN" | tug registry login ghcr.io --username <name>`. GHCR needs a classic personal access token with `read:packages`.
5. **Set the backup destination** with `tug backup destination set`, see [Backups](backups.md). The first backup is your way back.
6. **Give CI a credential** with `tug credential create ci --role deploy --project <name> --raw | gh secret set TUG_CREDENTIAL`, see [Deploying from GitHub Actions](access-control.md#deploying-from-github-actions).
7. **Dry run.** `tug deploy --dry-run` lists every value with its source and fails naming whatever is missing.
8. **Stop the old stack, without removing it.** `docker compose stop` keeps its containers and volumes, so starting it again is the way back. Take a last dump or copy of the data first.
9. **Set up ingress** for the hostname, see [Ingress and HTTPS](ingress.md), and lower its DNS TTL a day ahead if you can.
10. **Deploy.** `tug deploy`. Stateful services start with empty volumes.
11. **Import the data** (next section), then check the app.
12. **Back up.** `tug backup run`, then `tug backup list --check`. A first backup that passes is the point at which the old volumes can be retired.
13. **Keep the old volumes** for at least one backup cycle. Remove them with `docker volume rm` once a restore has been rehearsed.

## Import the data

Pipe the data through `tug exec -i`. Input is flow-controlled, so size is not a limit, and the commands run inside the new containers where the credentials already are. These use the service names from `examples/wordpress`:

```sh
docker compose exec -T db sh -c 'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" wordpress' > dump.sql
tug exec -i db -- sh -c 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" wordpress' < dump.sql
docker compose exec -T wordpress tar -C /var/www/html/wp-content -cf - uploads > uploads.tar
tug exec -i wordpress -- tar -C /var/www/html/wp-content -xf - < uploads.tar
```

The first command dumps the database from the old stack, the second loads it into tug, and the last two do the same for a directory. Run the dump after the old stack has stopped writing, or the copy can miss recent rows. Start the old database container alone (`docker compose start db`) when `stop` has already stopped it.

## Roll back

If the new site fails before you retire the old volumes, point DNS back and run `docker compose start` in the old directory. The old containers and volumes are untouched, so they hold the data as of the final copy. Anything written to tug after the cutover is not in them, so dump it back the same way when it matters.

## Next steps

Rehearse a restore with [Backups](backups.md), and read the [Production checklist](production-checklist.md) before the cutover. To move between tug servers later, see [Migrating to new servers](migration.md). A fresh tug backup repository sits beside any restic repository you used before. tug does not read the old one.
