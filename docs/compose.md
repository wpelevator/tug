# Compose extensions

Tug deploys standard Docker Compose files with an `x-tug` extension on services and volumes for placement and health checks. Control generates a per-node Compose file containing only the services and volumes placed on that node, with `x-tug`, `build`, `deploy` and `container_name` removed (and `extra_hosts` added for services on other nodes) and `image` set to the built or declared image.

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
- `placement.labels`: node labels (tags) that select the nodes running the service. Nodes must carry all listed labels. Combined with `replicas: N`, the control plane spreads the service across N matching nodes; `global: true` runs one replica on every matching node. Explicit `placement.nodes` still pins a service to named nodes.
- `global`: run one replica on every node matching `placement.labels` (or every node when no labels are given).
- `replicas`: optional; in this version it must equal the number of placement nodes (one container per node).
- `ingress`: publishes the service on a hostname through the managed Caddy edge (see [Networking](networking.md#layer-c-ingress-and-tls)). `host` is a fully qualified hostname, unique across the file; `port` is the service's container port or published host port and must appear in `ports`; `tls` is `auto` (default, ACME), `custom` or `off`. `tls: custom` also needs `cert` and `key`, the names of project secrets holding the PEM certificate chain and private key, which must exist before you deploy.
- `rollout`: `strategy: recreate` (default) or `rolling`, plus `drain`; see [Rolling rollouts](#rolling-rollouts). The top-level `x-tug: { rollback: auto }` is described under [Automatic rollback](#automatic-rollback).
- `health`: checked by the agent after `docker compose up -d`; the service is `serving` only once it passes.
  - `type: docker` waits for the container to be running and, if it defines a Docker `HEALTHCHECK`, healthy.
  - `type: tcp` connects to `port` on the container IP.
  - `type: http` requests `http://<container-ip>:<port><path>` (defaults `80` and `/`) and expects a 2xx response after following redirects.
  - `interval` (default `2s`), `timeout` (default `2s`) and `retries` (default `10`) accept numbers in milliseconds or `ms`/`s`/`m` suffixes.

`depends_on` is copied into the generated Compose file. `condition: service_healthy` waits on Docker's `HEALTHCHECK`, not on `x-tug.health`. Tug removes `x-tug` before `docker compose up`, so that condition fails the deploy when the image has no `HEALTHCHECK` and the service has no `healthcheck:` block. MariaDB 11.4 is one such image. Use `depends_on: [db]` and `x-tug.health` on each service. A failed apply is included in the deployment error `tug deploy` prints, and recorded once as `service.failed`.

```yaml
    x-tug:
      placement:
        nodes: [app1]
      ingress:
        host: app.example.com
        port: 80
        tls: auto            # auto | custom | off
```

Services that run on a different node than a given service are reachable from it by name (`db` or `db.<project>.tug`) when the mesh and service DNS are on, as long as the target publishes its port. Control injects these names into the per-node Compose file as `extra_hosts`; see [Networking](networking.md#layer-b-service-dns).

Services with `build:` are built by control from the uploaded source tarball, or on the operator machine with `deploy --build-local`. Each build receives an immutable tag distinct from the display version, so reusing a version label does not replace rollback images. Without `TUG_REGISTRY`, agents download saved images from control and generated Compose forces `pull_policy: never` for those services, overriding a source pull policy. With a registry configured, agents pull the pushed images. Published `image:` services retain their normal registry source. `--no-build-upload` with `build:` requires an explicitly configured registry and an existing image at `<registry>/<project>/<service>:<version>`; without a registry, send a source context or use local builds. Uploaded source contexts must contain regular files/directories within the build root; symlinks and escaping build paths are rejected.

### Rolling rollouts

By default a changed service is recreated in place (`docker compose up -d`), which drops its traffic for a moment. A service behind the managed ingress can instead opt in to a rolling rollout:

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
Volumes with `x-tug.type: nfs` (or `driver: nfs`) are exported by their placement node and generated as NFS-driver volumes on consuming nodes, so a shared document root can be mounted by several app nodes over the mesh. The exporter is a single point of failure.

## Secrets in services

Reference secrets through `environment`, either as keys (`DB_PASSWORD:` or `- DB_PASSWORD=...`) or as `${NAME}` / `${NAME:-default}` substitutions. Only referenced secrets are released to a node. Set them with `tug secret-set NAME`. A value that is not exactly a `${NAME}` substitution is a literal, and that key is also treated as a secret name, so a project secret with the same name is released too. The generated `.env` does not quote values; keep `#`, `$`, spaces and newlines out of secret values.

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
