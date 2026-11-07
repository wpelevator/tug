# Migrating to new servers

How to move a Tug installation, or one tier of it, to new servers and retire the old ones. Tug has no single "migrate" command: a move is a short sequence of the ordinary commands (`node add`, `deploy`, `backup`, `restore`, `node remove`), and the order is what keeps your data safe.

Each section says what was exercised on a real host and what comes only from reading the docs. Treat the second kind as a checklist to rehearse on disposable servers first.

| Section | Status |
| --- | --- |
| [Before you start](#before-you-start) | Reference |
| [Use labels so a move is only `node add`](#use-labels-so-a-move-is-only-node-add) | Placement behaviour is documented; the exact edit was not rehearsed |
| [Move the web tier](#move-the-web-tier) | Not exercised in a live run |
| [Move the database](#move-the-database) | Restore across nodes was exercised; the full move was not |
| [Move the object store](#move-the-object-store) | Not exercised; Tug has no data move for it |
| [Move the control plane](#move-the-control-plane) | Recovery on another host was exercised on 0.9.0, see [Control plane](control-plane.md#recover-control-on-another-host) |
| [Retire a host](#retire-a-host) | Manual; `node remove` only removes the control-plane record |

## Before you start

- **What lives where.** A host holds nothing a rebuild cannot recreate, except named volumes, any data you keep outside Docker (an object store on an attached disk) and, on the control host, the control state. Your Compose file, `tug.yml` and the images you build are the source of truth for everything else.
- **Escrow the secrets that cannot be regenerated.** Keep the root credential and the control backup's master key off the servers, and keep the backup repository password (`tug backup password`). Without them a lost control host cannot be recovered. See [Backups](backups.md).
- **Take fresh backups first.** `tug backup run` for every target you are about to move, then `tug backup list --check` to confirm they succeeded. For control, `tug control backup --no-images` is enough for a migration, because build archives are rebuilt by deploying again.
- **Trim old build archives** on control with `tug image prune --keep 3` (add `--dry-run` to preview) so the control backup and any transfer stay small (control already prunes to the newest 5 distinct builds after each deploy; see `TUG_IMAGE_KEEP`). Never delete files under `/var/lib/tug-control/images/` by hand: the database would still list them and nodes would get a 404 when they try to download them.
- **Private network.** New nodes need a private address on the same network as the old ones, because cross-node service names and published ports use it. See [Networking](networking.md).

## Use labels so a move is only `node add`

If a service pins explicit nodes (`x-tug.placement.nodes: [web-1]`), moving it means editing the Compose file. If it selects nodes by label, moving it only means adding a node that carries the label and removing the old one:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  php-fpm:
    x-tug:
      placement:
        labels: [web]
```

```bash
tug node add root@NEW --name web-2 --address 10.0.0.9 --label web --install-docker -y
```

Nodes must carry all of a service's labels, and nodes whose agent has not been seen recently are skipped when labels are resolved. Keep explicit `nodes:` only where a service must stay on one named host, such as a database that owns a local volume. Details are in [Compose extensions](compose.md) and [Nodes](nodes.md#node-labels).

`tug scale` stays within a service's explicit `placement.nodes`, so it is not a way to move a pinned service. Change the placement and deploy instead.

## Move the web tier

A web tier whose database and uploads live elsewhere is stateless, so it is the cheapest move.

1. Add the new node with the labels the web services select, and `--ingress` if it should handle ingress.
2. Run `tug deploy`. Services placed by label are scheduled onto the new node when the placement is re-resolved at deploy. If you pin explicit nodes, change them in the Compose file first.
3. Check `tug status` shows the services serving on the new node.
4. Remove the old node once nothing is placed on it: `tug node remove web-1`. It refuses while a current deployment places services there or while its agent still reports; `--force` overrides both.
5. Then [retire the host](#retire-a-host).

Ingress: certificates are issued per ingress node and live in that node's Caddy volumes, so a new ingress node requests new ones. If the public IP changes, point DNS at it first, and keep Let's Encrypt rate limits in mind if you use a shared wildcard service such as `sslip.io`.

## Move the database

This is the move that can lose data, so the order matters. Deploying a database to a new node creates its volume there **empty**. If the application is still running and can reach that empty database, it will happily write to it or fail in confusing ways.

1. **Add the new node** on the same private network, with the label the database selects (or pin it by name).
2. **Back up now:** `tug backup run db`, then confirm with `tug backup list --check`.
3. **Change the database placement and deploy with `--move`:** `tug deploy --move db`. Without the flag Tug refuses the deploy, because the database would start empty on the new node. With it, the services that write to the database are held (stopped) so nothing connects to the empty one; a writer that moves too, such as WordPress with its own volume, is held as well, even though the refusal asks you to acknowledge it. Writers are found from `depends_on` and from host names in environment variables (`WORDPRESS_DB_HOST=db`); check them with `tug restore run db` without `--confirm`, which prints the plan.
4. **Restore the snapshot into it:** `tug restore run db --confirm`, adding `--writers php-fpm` if the plan missed a writer. The restore takes over the holds, takes a safety snapshot of the current data first and starts the writers when it finishes.
5. **Changed your mind?** `tug hold release` starts the held services without restoring. Only do that if the empty database is acceptable.
6. **Verify** with the application and `tug backup list --check`.
7. **Clean up the old volume.** `tug volume remove db-data --delete-data` removes the record and the Docker volume on its node, but it refuses while a service in the current deployment still references the volume. Check `tug volume list` and, if the old copy is still there, remove the leftover Docker volume on the old host by hand.

If the restore fails before it changes any data, the writers stay held, so nothing connects to the empty database. Fix the cause and run the restore again; `tug hold release` is the way to start them without a restore.

While a writer is held, a sibling service whose health check depends on it (an nginx check that requests a PHP page) reports a failed apply for the duration. Give such services a health check that does not depend on the writer, such as a static `/healthz`. See [Restore](backups.md#restore). If the writers never report held, the restore fails after five minutes and the error names the node, the writer and the apply error the node reported.

Before relying on this procedure, rehearse it on throwaway servers with a copy of your data.

## Move the object store

An object store such as SeaweedFS or MinIO is a plain Docker volume to Tug. Tug does not copy volumes between nodes, so you choose how the data travels:

- **Small stores:** give the volume an `x-tug.backup` entry so Tug archives its files with restic, move the service, and restore the volume with `tug restore run <volume> --confirm`. See [Backups](backups.md).
- **Large stores:** use the store's own replication or a one-off copy (`rsync` of the data directory with the store stopped), then point the service at the new location.
- **Disposable stores:** deploy a fresh one and re-upload, after `tug volume remove <volume> --delete-data` on the old node.

Whatever you choose, the buckets your applications and backups use must exist before they are used, and Tug does not create them. Create them with the store's own tooling (for example `aws s3api create-bucket` through an SSH tunnel to the private port). The access keys that the application, and `tug backup destination set`, use must match what the new store was started with.

## Move the control plane

To recover a lost control server, see [Recover control on another host](control-plane.md#recover-control-on-another-host). To change only its address, see [Moving the control plane](control-plane.md#moving-the-control-plane). For a planned move:

1. Take `tug control backup --no-images` on the old control and copy the archive off the host.
2. Follow the recovery steps on the new host. Stop or isolate the old control before the new one serves, because two active control planes with divergent state are not supported.
3. After the restore, repoint every node with `tug node replace <node> <ssh-target> --control-url … --agent-control-url …`.
4. Deploy your projects again so control rebuilds the build archives it no longer has. Rolling back to a deployment whose archive was not restored is refused until you do.

Workload data is not part of the control backup. Back it up and restore it separately as above.

## Retire a host

`tug node remove <name> --teardown` removes the node's record from control and then cleans the host over SSH (the target defaults to `nodes.<name>.ssh` in `tug.yml`). It refuses a node that a current deployment still places services on, stops the agent and ingress, removes the Tug containers and networks, and deletes `/etc/tug` and `/var/lib/tug`. Project volumes and ingress certificates are kept; add `--delete-data` to delete them too, only once the data has been moved or backed up. It asks for confirmation (`-y` to skip, required without a terminal) and refuses a host that runs the control plane. If the cleanup fails after the record was removed, run the same command again.

Plain `tug node remove <name>` only deletes the record and leaves the host running.

On a former control host remove the control stack and its data, which includes the master key and the private CA: take the backup first, then `docker compose -p tug-control down -v` and `rm -rf /opt/tug-control /var/lib/tug-control`. Remove Docker itself only if nothing else uses it.

Locally, delete the host from `tug.yml`, and remove stale credentials under `~/.config/tug/credentials/` and any `TUG_CONTROL_URL` you exported.

Names to look for when cleaning up by hand: containers are `tug-<project>-<service>-<hash8>`, networks `tug_<project>`, volumes `tug_v<length>_<project>_<volume>`, and Tug resources carry `tug.project` labels. Review what a command will match before running it; the volume and container commands above delete data.

## Known limits

- A move does not copy the data: you restore it from a backup, and the old volume is not removed for you.
- A control host is retired by hand.
- Scratch restore volumes and the safety snapshot of every in-place restore are kept. See the limits in [Backups](backups.md).
- The control archive does not contain workload data.
