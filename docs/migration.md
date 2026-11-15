# Migrating to new servers

Move a Tug installation, or one tier of it, to new servers and retire the old ones. Tug has no single migrate command. A move is a short sequence of ordinary commands, and the order keeps your data safe.

```sh
tug backup run
tug backup list --check
tug node add root@NEW --name web-2 --address 10.0.0.9 --label web --install-docker -y
tug deploy
tug node remove web-1 --teardown
```

That sequence moves a stateless web tier. The database and object store need more steps, below. Rehearse each move on disposable servers with a copy of your data first.

| Tier | Section | Tested |
| --- | --- | --- |
| Web | [Move the web tier](#move-the-web-tier) | Placement behavior is documented. A full move was not run live |
| Database | [Move the database](#move-the-database) | Restore across nodes was run. The full move was not |
| Object store | [Move the object store](#move-the-object-store) | No. Tug has no data move for it |
| Control | [Move the control plane](#move-the-control-plane) | Recovery on another host was run, see [Control plane](control-plane.md#recover-control-on-another-host) |
| Old hosts | [Retire a host](#retire-a-host) | Manual. `node remove` alone removes only the control-plane record |

## Before you start

- **What lives where.** A host holds nothing a rebuild cannot recreate, except named volumes, data you keep outside Docker (an object store on an attached disk) and, on the control host, the control state. Your Compose file, `tug.yml` and the images you build are the source of truth for everything else.
- **Escrow what cannot be regenerated.** Keep the root credential, the control backup's master key and the backup repository password (`tug backup password`) off the servers. Without them a lost control host cannot be recovered. See [Backups](backups.md).
- **Take fresh backups.** Run `tug backup run`, then `tug backup list --check` to confirm every target succeeded. For control, `tug control backup -o control.tar.gz --no-images` is enough, because deploying again rebuilds build archives.
- **Trim build archives** with `tug image prune --keep 3` (add `--dry-run` to preview) so the control backup and any transfer stay small. Control already prunes to the newest 5 distinct builds after each deploy (`TUG_IMAGE_KEEP`). Never delete files under `images/` in control's data volume by hand.
- **Bind mounts do not move.** An absolute bind mount is a path on one host, so the service stays tied to it, and `tug deploy` warns about each one. Prefer named volumes, which move with a backup and restore, and recreate bind-mounted paths by hand on the new node.
- **Old hosts.** A host installed by an earlier release keeps agent state in `/var/lib/tug` and control data in `/var/lib/tug-control` until `tug node migrate` and `tug control migrate` move them into Docker volumes. `node add`, `node replace`, `node repair` and `control setup` refuse such a host until then, so migrate first.
- **Private network.** New nodes need a private address on the same network as the old ones, because cross-node names and published ports use it. See [Networking](networking.md).

## Use labels so a move is only `node add`

A service that pins explicit nodes (`x-tug.placement.nodes: [web-1]`) needs a Compose edit to move. A service that selects nodes by label moves by adding a node that carries the label and removing the old one:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  php-fpm:
    x-tug:
      placement:
        labels: [web]
```

```sh
tug node add root@NEW --name web-2 --address 10.0.0.9 --label web --install-docker -y
```

Nodes must carry all of a service's labels, and nodes whose agent has not been seen recently are skipped when labels are resolved. Keep explicit `nodes:` only where a service must stay on one named host, such as a database that owns a local volume. See [Compose extensions](compose.md#service-x-tug-keys) and [Nodes](nodes.md#node-labels). `tug scale` stays within a service's explicit `placement.nodes`, so change the placement and deploy to move a pinned service.

## Move the web tier

A web tier whose database and uploads live elsewhere is stateless, so it is the cheapest move.

1. Add the new node with the labels the web services select, and `--ingress` if it should handle ingress.
2. Run `tug deploy`. Services placed by label go to the new node when placement is re-resolved at deploy. If you pin explicit nodes, change them in the Compose file first.
3. Check that `tug status` shows the services serving on the new node.
4. Remove the old node once nothing is placed on it: `tug node remove web-1`. It refuses while a current deployment places services there or while its agent still reports, and `--force` overrides both.
5. [Retire the host](#retire-a-host).

Certificates are issued per ingress node and live in that node's Caddy volumes, so a new ingress node requests new ones. If the public IP changes, point DNS at it first, and keep Let's Encrypt rate limits in mind if you use a shared wildcard service such as `sslip.io`.

## Move the database

This is the move that can lose data. Deploying a database to a new node creates its volume there empty, and if the app can still reach that empty database it will write to it or fail in confusing ways.

| Step | Command and what it does |
| --- | --- |
| 1. Add the node | On the same private network, with the label the database selects (or pin it by name) |
| 2. Back up | `tug backup run db`, then `tug backup list --check` |
| 3. Deploy with `--move` | `tug deploy --move db`. Without the flag Tug refuses, because the database would start empty. With it, services that write to the database are held (stopped), including a writer that moves too, such as WordPress with its own volume. Writers are found from `depends_on` and from host names in environment variables (`WORDPRESS_DB_HOST=db`). Check them with `tug restore run db` without `--confirm`, which prints the plan |
| 4. Restore | `tug restore run db --confirm`, adding `--writers php-fpm` if the plan missed a writer. The restore takes over the holds, takes a safety snapshot of the current data and starts the writers when it finishes |
| 5. Verify | Check the application and `tug backup list --check` |
| 6. Clean up | `tug volume remove db-data --delete-data` removes the record and the Docker volume on its node, but refuses while a service in the current deployment references the volume. Check `tug volume list`, and remove a leftover Docker volume on the old host by hand |

- **Changed your mind?** `tug hold release` starts the held services without restoring. Do it only if the empty database is acceptable.
- **Restore failed before changing data?** The writers stay held, so nothing connects to the empty database. Fix the cause and run the restore again.
- **Sibling health checks.** While a writer is held, a service whose health check depends on it (an nginx check that requests a PHP page) reports a failed apply. Give such services a check that does not depend on the writer, such as a static `/healthz`. If the writers never report held, the restore fails after five minutes and the error names the node, the writer and the apply error. See [Restore](backups.md#restore).

### Copy data through exec

To load a dump or directory from your machine, or take a copy out, pipe it through `tug exec`. Input and output are flow-controlled end to end, so size is not a limit. These use the service names from `examples/wordpress`:

```sh
tug exec -i db -- sh -c 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" wordpress' < dump.sql
tug exec wordpress -- tar -C /var/www/html/wp-content -cf - uploads > uploads.tar
tug exec -i wordpress -- tar -C /var/www/html/wp-content -xf - < uploads.tar
```

The first command loads a SQL dump, the second takes the uploads directory out, and the third puts it back. Agents older than 2.0 keep a bounded buffer and fail large inputs with `agent buffer limit exceeded`, so upgrade them first.

## Move the object store

An object store such as SeaweedFS or MinIO is a plain Docker volume to Tug, and Tug does not copy volumes between nodes. Choose how the data travels:

| Store | Approach |
| --- | --- |
| Small | Give the volume an `x-tug.backup` entry so Tug archives its files with restic, move the service, and restore with `tug restore run <volume> --confirm`. See [Backups](backups.md) |
| Large | Use the store's own replication, or a one-off copy (`rsync` of the data directory with the store stopped), then point the service at the new location |
| Disposable | Deploy a fresh one and re-upload, after `tug volume remove <volume> --delete-data` on the old node |

Whatever you choose, the buckets your applications and backups use must exist before they are used, and Tug does not create them. Create them with the store's own tooling, for example `aws s3api create-bucket` through an SSH tunnel to the private port. The access keys that the application and `tug backup destination set` use must match what the new store was started with.

## Move the control plane

To recover a lost control server, see [Recover control on another host](control-plane.md#recover-control-on-another-host). To change only its address, see [Moving the control plane](control-plane.md#moving-the-control-plane). For a planned move:

1. Take `tug control backup -o control.tar.gz --no-images` on the old control. It saves the archive on your machine, so keep it encrypted.
2. Follow the recovery steps on the new host. Stop or isolate the old control before the new one serves, because two active control planes with divergent state are not supported.
3. After the restore, repoint every node with `tug node replace <node> <ssh-target> --control-url ... --agent-control-url ...`.
4. Deploy your projects again so control rebuilds the build archives it no longer has. Rolling back to a deployment whose archive was not restored is refused until you do.

Workload data is not part of the control backup. Back it up and restore it separately.

## Retire a host

```sh
tug node remove web-1 --teardown
```

`--teardown` removes the node's record from control, then cleans the host over SSH. The target defaults to `nodes.<name>.ssh` in `tug.yml`.

| Topic | Behavior |
| --- | --- |
| Refused when | A current deployment still places services on the node, or the host runs the control plane |
| Removed | The agent and ingress, the Tug containers and networks, and the agent's identity (the `tug-agent` volume, plus `/etc/tug` and `/var/lib/tug` on a host not yet migrated) |
| Kept | Project volumes and ingress certificates. Add `--delete-data` to delete them too, only once the data has been moved or backed up |
| Confirmation | `-y` skips it and is required without a terminal |
| Failure | If the cleanup fails after the record was removed, run the same command again |
| Without `--teardown` | `tug node remove <name>` deletes only the record and leaves the host running |

On a former control host, take a backup first, then remove the control stack and its data, which includes the master key and the private CA:

```sh
docker rm -f tug-control-control-1
docker volume rm tug-control
rm -rf /opt/tug-control
```

Also remove `/var/lib/tug-control` if the host was never migrated, and remove Docker itself only if nothing else uses it. Locally, delete the host from `tug.yml`, and remove stale credentials under `~/.config/tug/credentials/` and any exported `TUG_CONTROL_URL`.

Names to look for when cleaning up by hand: containers are `tug-<project>-<service>-<hash8>`, networks `tug_<project>`, volumes `tug_v<length>_<project>_<volume>`, and Tug resources carry `tug.project` labels. Review what a command will match before you run it, because the volume and container commands delete data.

## Known limits

- A move does not copy the data. You restore it from a backup, and the old volume is not removed for you.
- A control host is retired by hand.
- Scratch restore volumes and the safety snapshot of every in-place restore are kept. See the limits in [Backups](backups.md#known-limits).
- The control archive does not contain workload data.
