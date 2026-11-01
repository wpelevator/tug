# Compose extensions

Tug deploys standard Docker Compose files with an `x-tug` extension on services and volumes for placement and health checks. Control generates a per-node Compose file containing only the services and volumes placed on that node, with `x-tug`, `build`, `deploy` and `container_name` removed (and `extra_hosts` added for services on other nodes) and `image` set to the built or declared image. Published `ports` without a host IP are bound to the node's overlay IP, `127.0.0.1` or the node's `address` instead of every interface; write the host IP (for example `"0.0.0.0:80:80"`) to publish on purpose. See [Published ports](networking.md#published-ports-private-by-default).

## Services

```yaml
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8088:80"
    environment:
      SAMPLE_SECRET: ${SAMPLE_SECRET:-not-set}
    x-tug:
      placement:
        nodes: [vps-a]
      health:
        type: http
        port: 80
        path: /
```

- `placement.nodes`: node names that run the service. Required on every service when more than one node is registered. With a single node, services without placement go to that node.
- `placement.labels`: node labels (tags) that select the nodes running the service. Nodes must carry all listed labels. Combined with `replicas: N`, the control plane spreads the service across N matching nodes; `global: true` runs one replica on every matching node. Nodes whose agent has not been seen within `TUG_STALE_SECONDS` are skipped when labels or `global` are resolved (at deploy and on `tug scale`), so a dead host cannot hold a rollout open. Explicit `placement.nodes` still pins a service to named nodes.
- `global`: run one replica on every node matching `placement.labels` (or every node when no labels are given).
- `replicas`: optional; in this version it must equal the number of placement nodes (one container per node).
- `ingress`: publishes the service on a hostname through the managed Caddy edge (see [Networking](networking.md#layer-c-ingress-and-tls)). `host` is a fully qualified hostname, unique across the file; `port` is the service's container port or published host port and must appear in `ports`; `tls` is `auto` (default, ACME), `custom` or `off`. `tls: custom` also needs `cert` and `key`, the names of project secrets holding the PEM certificate chain and private key, which must exist before you deploy.
- `rollout`: `strategy: recreate` (default) or `rolling`, plus `drain`; see [Rolling rollouts](#rolling-rollouts). The top-level `x-tug: { rollback: auto }` is described under [Automatic rollback](#automatic-rollback).
- `health`: checked by the agent after the container starts; the service is `serving` only once it passes.
  - `type: docker` waits for the container to be running and, if it defines a Docker `HEALTHCHECK`, healthy.
  - `type: tcp` connects to `port` on the container IP.
  - `type: http` requests `http://<container-ip>:<port><path>` (defaults `80` and `/`) and expects a 2xx response after following redirects.
  - `interval` (default `2s`), `timeout` (default `2s`) and `retries` (default `10`) accept numbers in milliseconds or `ms`/`s`/`m` suffixes.

`depends_on` sets start order on a node. `condition: service_healthy` waits on the dependency's `x-tug.health` when it has one, otherwise on Docker's `HEALTHCHECK`, so it fails the deploy when the image has no `HEALTHCHECK` and the service has no `healthcheck:` block. MariaDB 11.4 is one such image. Use `depends_on: [db]` and `x-tug.health` on each service. A failed apply is included in the deployment error `tug deploy` prints, and recorded once as `service.failed`.

```yaml
    x-tug:
      placement:
        nodes: [app1]
      ingress:
        host: app.example.com
        port: 80
        tls: auto            # auto | custom | off
```

Services that run on a different node than a given service are reachable from it by name (`db` or `db.<project>.tug`) when the mesh and service DNS are on, as long as the target publishes its port (Tug binds it to the overlay address, not the internet). Control injects these names into the per-node Compose file as `extra_hosts`; see [Networking](networking.md#layer-b-service-dns).

Services with `build:` are built by control from uploaded source, or on the operator machine with `deploy --build-local`. Each build receives an immutable tag distinct from the display version and is delivered as a saved image archive from control. Build services require a source context or local image upload. Published `image:` tags are resolved once on control to `image@sha256:…` before deployment publication; explicit SHA-256 references remain pinned. Multi-platform indexes remain intact. Agents pull the stored digest from the upstream registry, so rollback and nodes added later use that same manifest. Private registry credentials use the encrypted project secret described in [Control plane](control-plane.md#published-images-and-private-registries). Uploaded source contexts must contain regular files/directories within the build root; symlinks and escaping build paths are rejected.

### Rolling rollouts

By default a changed service is recreated in place, which drops its traffic for a moment. A service behind the managed ingress can instead opt in to a rolling rollout:

```yaml
services:
  web:
    image: ghcr.io/acme/web:2
    ports:
      - "8080:80"
    x-tug:
      placement:
        nodes: [app1]
      health:
        type: http
        port: 80
      ingress:
        host: app.example.com
        port: 80
      rollout:
        strategy: rolling      # recreate (default) | rolling
        drain: 30s             # how long the previous revision keeps running after takeover (default 30s)
```

With `strategy: rolling` the agent starts the new revision next to the old one, health-checks it, and only then lets the ingress switch to it. The old revision is removed once `drain` has passed. If the new revision never becomes healthy it is removed, the old one keeps serving and the node reports `failed` for that deployment (see [automatic rollback](#automatic-rollback)). Nothing else on the node restarts: a rolling service whose rendered definition and secrets did not change is left alone, and so are recreated services.

`validateCompose` requires a rolling service to have `x-tug.ingress` (the edge is what switches traffic), `x-tug.health` (a revision only takes over once healthy) and exactly one entry in `ports` (the ingress port). `drain` takes the same durations as health checks (`500ms`, `30s`, `1m`, or a number of milliseconds) and should be longer than the poll intervals of the app node and the ingress node together (5s each by default), because the ingress only learns about the new revision through the app node's next status report and the edge node's next poll. `maxSurge` and per-service batch sizes are not supported: one new revision is started per changed service.

How it works, and its limits:

- Rolling services are meant to be stateless. Each revision is its own Compose project (`<project>-<service>-<hash>`), and old and new revisions run side by side, so named volumes are shared between them (mounted from the main project's `<project>_<volume>`) and concurrent access is the operator's responsibility. Use `recreate` for databases and anything that cannot have two writers.
- Each revision publishes the ingress port on its own host port from a free range (`TUG_ROLLOUT_PORTS` on the agent, default `20000-20999`), not on the declared host port. The declared port, for example `8080` above, is only the contract for the ingress validation. Reach a rolling service through its ingress hostname; see [Networking](networking.md#rolling-services-and-service-names) for what that means for service names.
- `depends_on` is dropped for rolling services and from recreated services that point at them (the services live in different Compose projects). The services share the main project network, so names such as `db` still resolve; use health checks and client retries rather than start order.
- Switching a service from `recreate` to `rolling` keeps the old container in the main project serving until its replacement takes over and then removes it after the drain; switching back keeps the rolling revision for one drain after the recreated container is up. A service that had no container yet starts on a range port straight away.
- A rejected revision is not retried on every poll; deploy again (or roll back) to try again.

### Automatic rollback

Add a top-level `x-tug` block to roll back failed deployments on its own:

```yaml
x-tug:
  rollback: auto      # manual (default) | auto

services:
  # ...
```

When a deployment turns `failed` because an assigned node reported failed health for it, and the project has an earlier `succeeded` deployment, control creates a rollback deployment through the same path as `tug rollback` and records a `deployment.auto_rollback` event (`tug events` shows it). Both the rollback deployment and the event carry the actor `system:auto-rollback` (see [Access control](access-control.md#audit-trail)). If it cannot, it records `deployment.auto_rollback_skipped` with the reason (no earlier succeeded deployment, the project is locked, another deployment replaced the failed one). A failing rollback deployment is never rolled back again, so a bad rollback target cannot loop; for the same reason `rollback-` is reserved at the start of deployment versions and `deploy` rejects it. With rolling services the previous revision is still serving when the new one fails, so the rollback is only a state change and users see no downtime.

## Volumes

```yaml
volumes:
  cache-data:
    x-tug:
      type: local
      persistent: true
      placement:
        nodes: [vps-c]
```

Control records volumes per project. A volume is included in a node's Compose file only when a service on that node uses it and, if the volume has `placement.nodes`, the node is listed. `tug volume-remove` refuses to remove a persistent volume without `--delete-data`, and refuses any volume still referenced by a service in the current deployment. `--delete-data` queues a `docker volume rm` on the volume's placement node.
Volumes with `x-tug.type: nfs` share a directory exported by their placement node. Tug does not install or start an NFS server, and consuming nodes need the NFS client (`nfs-common` on Debian and Ubuntu): the exporter node must already export `x-tug.export` (default `/srv/tug/<volume>`) to the other nodes, ideally restricted to the mesh. On the exporter, services bind-mount that directory; on every other node using the volume, Tug generates a Compose volume that mounts `<exporter>:<export>` over NFS. Control stamps the exporter's overlay IP (with the mesh) or node address into `x-tug.address` at deploy time unless you set it. The exporter is a single point of failure.

## Backups

```yaml
x-tug:
  backup:
    schedule: "0 3 * * *"
    retention: { daily: 7, weekly: 4, monthly: 6 }

services:
  db:
    image: mariadb:11.4
    x-tug:
      placement: { nodes: [app1] }
      backup: true

volumes:
  uploads:
    x-tug:
      placement: { nodes: [store1] }
      backup: "30 3 * * *"
```

`x-tug.backup` marks a database service or a top-level volume as a backup target. The value is `true` (take everything from the project defaults), a cron string, `false`, or an object. The top-level `x-tug.backup` only holds defaults and enables nothing by itself.

| Key | Applies to | Meaning | Default |
| --- | --- | --- | --- |
| `type` | service | `mariadb` or `mysql`, inferred from an image named `mariadb`, `mysql` or `percona` | required when it cannot be inferred |
| `schedule` | both | Five-field cron in UTC, or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` | the project default; an error if neither is set |
| `retention` | both | restic keep policy with `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly` | the project default, else `daily: 7, weekly: 4, monthly: 6` |
| `jitter` | both | Seconds of delay after the scheduled minute, 0 to 3600 | a stable per-target value under 15 minutes |
| `timeout` | both | Hard limit for a run, `1m` to `24h` | `2h` |
| `databases` | service | Databases to dump | `MARIADB_DATABASE` or `MYSQL_DATABASE` of the service |
| `user`, `password` | service | Database user and the name of the project secret holding its password | `root` and `MARIADB_ROOT_PASSWORD` or `MYSQL_ROOT_PASSWORD` |
| `exclude` | volume | restic exclude patterns | none |
| `writers` | both | Services to hold during a restore | discovered from `depends_on` and volume mounts |

Deploy rejects a target that cannot be backed up from one place: a service that is global, replicated or placed on several nodes; a volume used on several nodes without `x-tug.placement.nodes`; an NFS volume without its exporter as placement (the backup always runs on the exporter); and a volume holding the data of a database that has its own backup, since copying a running database's files is not a backup.

This is the configuration surface for [M11](roadmap.md#m11--backups-restores-and-run-once-jobs). Today Tug validates and records these keys; scheduled execution, the destination and the catalog are not implemented yet, so use the sidecar recipe in [Backups](backups.md) until they land.

## Secrets in services

Secrets are referenced by variable name and resolved by control at deploy time; the `@@tug:secret:NAME@@` placeholder you may see in a normalized file is internal and never written by hand. Reference secrets with `${NAME}` anywhere Compose interpolates, usually `environment`. `tug deploy` sets every project secret as a variable during `docker compose config`, so a secret wins over a local variable of the same name and `environment: [DB_PASSWORD]` passes it through. Only secrets a service references are released to its node, and a changed secret recreates exactly the services that use it. Secrets are substituted into the container environment; keep them out of `command` unless you accept them showing in `docker inspect`. Deploying a Compose file that references a secret the project does not have is rejected.

## A database on the same node

An app reaches a database by Compose's own DNS only when they are on the same node. A name injected for a service on another node points at that node's address, and the client has to use the published host port, so an unpublished database is not reachable across nodes. Shared volumes and replica spread are not implemented.

```yaml
services:
  db:
    image: mariadb:11.4
    command: ["--innodb-buffer-pool-size=48M"]
    environment:
      MARIADB_DATABASE: app
      MARIADB_USER: app
      MARIADB_PASSWORD: ${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
    x-tug:
      placement:
        nodes: [app]
      health:
        type: tcp
        port: 3306

  web:
    image: nginx:1.27-alpine
    depends_on: [db]
    ports:
      - "8080:80"
    x-tug:
      placement:
        nodes: [app]
      health:
        type: http
        port: 80
      ingress:
        host: app.example.com
        port: 80
        tls: auto

volumes:
  db-data:
    x-tug:
      type: local
      persistent: true
      placement:
        nodes: [app]
```

Set `DB_PASSWORD` and `DB_ROOT_PASSWORD` with `tug secret-set` before deploying. The MariaDB flag keeps the buffer pool small enough for a 1 GB host that is also running the agent. Do not add `condition: service_healthy` unless the database image defines a Docker `HEALTHCHECK`.

## Not supported

- `container_name` (Compose project names isolate containers per project).
- `deploy` (Swarm semantics).

## Supported keys

`tug deploy` normalizes the file with `docker compose config` (Docker Compose v2 must be installed on the operator machine), and control accepts only these service keys: `image`, `build`, `command`, `entrypoint`, `environment`, `ports`, `expose`, `volumes` (named volumes and absolute bind mounts), `tmpfs`, `healthcheck`, `restart`, `labels`, `depends_on` (`service_started`, `service_healthy`), `extra_hosts`, `user`, `working_dir`, `hostname`, `init`, `read_only`, `shm_size`, `mem_limit`, `mem_reservation`, `cpus`, `pids_limit`, `cap_add`, `cap_drop`, `ulimits`, `logging`, `stop_grace_period`, `stop_signal` and `x-tug`. `pull_policy` is ignored because Tug decides when images change. Anything else is rejected with its key named, including `network_mode`, `privileged`, `devices`, `pid`, `ipc`, `container_name`, `env_file` (already merged by Compose), custom networks, and top-level `configs` and `secrets`. Top-level volumes accept `driver`, `driver_opts`, `labels`, `external`, `name` and `x-tug`. Containers use Tug's own network, volume and container names (`tug_<project>`, `tug_<project>_<volume>`), so existing Compose-created volumes are not reused.
