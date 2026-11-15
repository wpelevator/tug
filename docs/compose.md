# Compose extensions

Tug deploys a standard Docker Compose file. The `x-tug` extension on services and volumes adds placement, health checks, ingress, rollouts and backups, and plain Docker Compose ignores it.

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
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

`tug deploy` reads the file on your machine with its own reader, so neither your machine nor the nodes need Docker Compose. Each agent turns the services placed on its node into Docker Engine API container definitions, without `x-tug`, `build`, `deploy` and `container_name`, with `extra_hosts` added for services on other nodes and `image` set to the built or declared image. A published port without a host IP is bound to the node's `address` or `127.0.0.1`, not every interface. Write the host IP (`"0.0.0.0:80:80"`) to publish on purpose. See [Published ports](networking.md#published-ports-private-by-default).

To choose a probe see [Health checks](health-checks.md), and to choose where services run see [Service placement](placement.md).

## Checking the file with `tug lint`

`tug lint` checks a Compose file against the `x-tug` schema with no control connection, credential or Docker. It reports what `tug deploy` makes control reject: the whole `x-tug` schema plus the unsupported Compose keys. Checks that depend on your node list still happen at deploy. A typo such as `ingresss:` fails in milliseconds here, with no server needed.

```sh
tug lint
tug lint -f proxy.yml
tug lint --json
```

A clean file prints one line:

```text
compose.yaml: ok
```

A file with problems prints each finding as `$FILE: $RULE` on stderr, so an editor can jump to the line by splitting on the first colon. The command exits 1, so it works as a CI step before `tug deploy`:

```text
bad.yaml: web: networks other than the default network are not supported
bad.yaml: web: x-tug.rollback is not supported (supported: placement, replicas, global, health, ingress, rollout, backup)
```

`--json` prints `{ ok, file, errors }`.

## Editor autocomplete and squiggles

The schema that `tug lint` applies is published as [JSON Schema](https://unpkg.com/@wpelevator/tug/x-tug.schema.json). Add one header line to `compose.yaml`, and the Red Hat YAML extension for VS Code (or any schema-aware YAML language server) completes and flags every `x-tug` field as you type:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
```

- **Pin a version** to keep schema and behavior in step: `https://unpkg.com/@wpelevator/tug@<version>/x-tug.schema.json`.
- **JetBrains:** Settings, Languages & Frameworks, Schemas and DTDs, JSON Schema Mappings. Map the URL to your file name pattern.
- **Offline:** place the schema next to the file and reference it with a `file:` URL.

Unknown `x-tug` keys, an unknown health type and misplaced fields are flagged in the editor. Custom keys that keep Compose's `x-` prefix are accepted.

## Services

### Service `x-tug` keys

| Key | Meaning | Default |
| --- | --- | --- |
| `placement.nodes` | Node names that run the service | With one registered node, that node. With several, you must choose nodes, labels or `global` |
| `placement.labels` | Labels a node must all carry to run the service | none |
| `replicas` | How many matching nodes run the service. With explicit nodes and no labels it must equal the number of named nodes. At most one replica per node | one |
| `global` | One replica on every node matching `placement.labels` (every node when there are none) | `false` |
| `health` | The probe that decides when the service is `serving`, see below | none |
| `ingress` | Publish the service on a hostname through the managed Caddy edge, see below | none |
| `rollout` | `strategy` and `drain`, see [Rolling rollouts](#rolling-rollouts) | `strategy: recreate` |
| `backup` | Mark the service for backup, see [Backups](#backups) | none |

Labels with `replicas: N` spread the service over N matching nodes. Nodes whose agent has not been seen within `TUG_STALE_SECONDS` are skipped when labels or `global` are resolved, at deploy and on `tug scale`, so a dead host cannot hold a rollout open. Explicit `placement.nodes` pins a service to named nodes, and `tug scale` never moves it off them.

### Health

The agent checks the container after it starts, and the service is `serving` only once the check passes.

| Key | Meaning | Default |
| --- | --- | --- |
| `type: docker` | Waits for the container to run and, if it defines a Docker `HEALTHCHECK`, to be healthy | |
| `type: tcp` | Connects to `port` on the container IP | |
| `type: http` | Requests `http://<container-ip>:<port><path>` and expects a 2xx after redirects | `port: 80`, `path: /` |
| `interval` | Time between attempts. Numbers are milliseconds, or use `ms`, `s`, `m` suffixes | `2s` |
| `timeout` | Time allowed per attempt | `2s` |
| `retries` | Attempts before the check fails | `10` |

`depends_on` sets start order on a node. `condition: service_healthy` waits on the dependency's `x-tug.health` when it has one. Otherwise it checks that the container runs and, if it has one, that its Docker `HEALTHCHECK` is healthy. With neither, it only verifies the container runs. A failed apply is included in the error `tug deploy` prints and recorded once as `service.failed`.

### Ingress

```yaml
    x-tug:
      placement:
        nodes: [app1]
      ingress:
        host: app.example.com
        port: 80
        tls: auto
```

| Key | Meaning | Default |
| --- | --- | --- |
| `host` | A fully qualified hostname, or a list (`[app.example.com, example.org, "*.network.example.com"]`), unique across the file. Every name shares the route's upstreams and TLS mode, and the first is the primary | required |
| `port` | The service's container port or published host port. It must appear in `ports` | required |
| `tls` | `auto` (ACME, with a wildcard host issued per name on demand, see [Edge features](ingress.md#edge-features)), `custom` or `off` | `auto` |
| `cert`, `key` | With `tls: custom`: names of project secrets holding the PEM chain and private key. They must exist before you deploy, and the one certificate must cover every host | none |
| `maintenance` | `true` makes the edge answer `503` with a short fixed page and `Retry-After` for this host, for planned work. Remove it and deploy again to resume | `false` |

A host with no serving upstream gets the same `503` automatically. `tug domain add` maps extra hostnames onto a route without a deployment, see [Mapped domains](ingress.md#mapped-domains-and-wildcard-zones). Setup and DNS are in [Networking](ingress.md#set-up-ingress).

### Names across nodes

A service on another node is reachable by name (`db` or `db.<project>.tug`) when the target publishes its port and the client's node can route to the target node's private `address`. Tug binds the port to that address, and your firewall controls access. The agent adds these names as hosts-file (`extra_hosts`) entries, not DNS records. Set `TUG_SERVICE_NAMES=false` on control to turn them off. See [Networking](networking.md#cross-node-service-names).

An app reaches a database through Compose DNS only when both are on the same node. Local volumes are not copied between nodes.

### Images

- **Built services** (`build:`) are built by control from uploaded source, or on your machine with `deploy --build-local`. Each build gets an immutable tag distinct from the display version and is delivered as a saved image archive from control. Uploaded contexts must contain regular files and directories inside the build root, and symlinks and escaping paths are rejected.
- **Published services** (`image:`) are resolved once on control to `image@sha256:...` before the deployment is published. Explicit SHA-256 references stay pinned and multi-platform indexes stay intact. Agents pull the stored digest, so rollback and nodes added later use the same manifest.
- **Private registries** use the encrypted project secret described in [Control plane](control-plane.md#published-images-and-private-registries).

## Rolling rollouts

By default a changed service is recreated in place, which drops its traffic for a moment. A service behind the managed ingress can opt in to a rolling rollout:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
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
        strategy: rolling
        drain: 30s
```

| Key | Meaning | Default |
| --- | --- | --- |
| `strategy` | `recreate` or `rolling` | `recreate` |
| `drain` | How long the previous revision keeps running after takeover. Same durations as health checks (`500ms`, `30s`, `1m`, or milliseconds) | `30s` |

With `rolling`, the agent starts the new revision next to the old one, health-checks it, and only then lets the ingress switch. The old revision is removed once `drain` has passed. If the new revision never becomes healthy it is removed, the old one keeps serving, and the node reports `failed` for that deployment (see [Automatic rollback](#automatic-rollback)). A rolling service whose rendered definition and secrets did not change is left alone, and nothing else on the node restarts.

**Requirements.** Deploy rejects a rolling service without `x-tug.ingress` (the edge switches traffic), without `x-tug.health` (a revision takes over only once healthy), or without exactly one entry in `ports` (the ingress port).

**Limits and behavior.**

- **Stateless only.** Each revision is its own container (`tug-<project>-<service>-<hash8>`), and old and new run side by side. Named volumes are shared between them, and concurrent access is yours to manage. Use `recreate` for databases and anything that cannot have two writers.
- **Host ports.** Each revision publishes the ingress port on its own host port from a free range (`TUG_ROLLOUT_PORTS` on the agent, default `20000-20999`), not the declared host port. The declared port is only the contract for ingress validation. Reach a rolling service through its ingress hostname, see [Rolling services and service names](networking.md#rolling-services-and-service-names).
- **`drain` timing.** Set it longer than the app node's and the ingress node's poll intervals together (5s each by default), because the ingress learns about the new revision through the app node's next status report and the edge node's next poll.
- **`depends_on`** is dropped for rolling services, and from recreated services that point at them, because revisions start and are replaced on their own schedule. All revisions share the project network, so names such as `db` still resolve. Use health checks and client retries instead of start order.
- **Switching strategy.** `recreate` to `rolling` keeps the old container serving until its replacement takes over, then removes it after the drain. Back again, the rolling revision stays for one drain after the recreated container is up. A service with no container yet starts on a range port straight away.
- **No retry loop.** A rejected revision is not retried on every poll. Deploy again, or roll back.
- **No `maxSurge`.** One new revision starts per changed service.

## Automatic rollback

Add a top-level `x-tug` block to roll back failed deployments on its own:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
x-tug:
  rollback: auto      # manual (default) | auto
```

When a deployment fails because an assigned node reported failed health, and the project has an earlier `succeeded` deployment, control creates a rollback deployment through the same path as `tug rollback` and records a `deployment.auto_rollback` event. Both carry the actor `system:auto-rollback` (see [Access control](access-control.md#audit-trail)).

| Event | When |
| --- | --- |
| `deployment.auto_rollback` | The rollback deployment was created |
| `deployment.auto_rollback_skipped` | It could not be, with the reason: no earlier succeeded deployment, the project is locked, or another deployment replaced the failed one |

A failing rollback deployment is never rolled back again, so a bad target cannot loop. For that reason `rollback-` is reserved at the start of deployment versions and `deploy` rejects it. With rolling services the previous revision still serves when the new one fails, so the rollback is only a state change and users see no downtime. Rollback cannot undo database writes or schema changes.

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

| Key | Meaning |
| --- | --- |
| `type` | `local` |
| `persistent` | `true` marks data that `tug volume remove` will not delete without `--delete-data` |
| `placement.nodes` | Nodes that hold the volume. A volume used on several nodes needs it |
| `backup` | Back the volume up, see [Backups](#backups) |

Control records volumes per project. A node's Compose file includes a volume only when a service on that node uses it and, if the volume has `placement.nodes`, the node is listed. `tug volume remove` refuses a persistent volume without `--delete-data`, and refuses any volume still referenced by the current deployment. `--delete-data` queues a `docker volume rm` on the volume's placement node.

Before starting workloads, the agent checks that an existing Tug project network belongs to the project and that each existing non-external volume has the expected project and volume labels, driver and options. A mismatch stops reconciliation with an error instead of reusing the resource. Volume deletion checks the same labels. Tug reserves the `tug.project`, `tug.volume` and `tug.restore` labels on managed volumes. External volumes are selected by name and are not checked.

### Sharing a directory between nodes

Tug does not manage network file systems. Mount one with plain Compose `driver: local` and `driver_opts` against a server you run, and install the NFS client (`nfs-common` on Debian and Ubuntu) on every node that uses it:

```yaml
volumes:
  uploads:
    driver: local
    driver_opts:
      type: nfs
      o: addr=10.0.0.10,rw,hard
      device: ":/srv/uploads"
```

Each node mounts it itself, so the file server is a single point of failure that you operate. Prefer S3-compatible object storage for uploads when the app supports it.

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
      backup:
        command: mariadb-dump -u root -p"$$MARIADB_ROOT_PASSWORD" --single-transaction --databases wordpress
        filename: wordpress.sql
        verify: "-- Dump completed"
        restore: mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"

volumes:
  uploads:
    x-tug:
      placement: { nodes: [app1] }
      backup: "30 3 * * *"
```

`x-tug.backup` marks a target, and there are two kinds:

- **A service.** Tug runs your `command` in the running container and stores its standard output. A database dump, `pg_dump`, `redis-cli --rdb -`, `tar` of a directory or `wp db export -` are all commands. A string runs through `sh -c`, and a list runs as written.
- **A top-level volume.** Tug mounts it read-only and archives its files.

The value is a cron string, `true` (a volume, with everything from the project defaults), `false`, or an object. The top-level `x-tug.backup` holds defaults and enables nothing.

| Key | Applies to | Meaning | Default |
| --- | --- | --- | --- |
| `schedule` | both | Five-field cron in UTC, or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` | The project default. An error if neither is set |
| `retention` | both | restic keep policy: `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly` | The project default, else `daily: 7, weekly: 4, monthly: 6` |
| `jitter` | both | Seconds of delay after the scheduled minute, 0 to 3600 | A stable per-target value under 15 minutes |
| `timeout` | both | Hard limit for a run, `1m` to `24h` | `2h` |
| `memory` | both | Memory limit of the restic helper, `128m` to `16g` | `512m` |
| `writers` | both | Services to hold during a restore | Discovered from `depends_on`, host names in environment variables and volume mounts |
| `command` | service | What to run in the container. Its output is the backup | required |
| `restore` | service | What to run to load a backup back. The stored file arrives on standard input | none, so Tug cannot restore the service |
| `filename` | service | Name of the file in the snapshot | `<service>.out` |
| `verify` | service | Text that must appear in the last 4 KiB of output | none |
| `exclude` | volume | restic exclude patterns | none |

A run fails, and keeps no snapshot, when the command exits non-zero, writes nothing, or lacks the `verify` text. Use the line your tool prints when it finishes, such as `-- Dump completed`, so a cut-short dump is never mistaken for a good one.

Deploy rejects a service target that is global, replicated or placed on several nodes, and a volume used on several nodes without `placement.nodes`. Tug does not check whether a volume backup and a command backup overlap, or whether a volume holds a live database. Copying the files of a running database is rarely consistent, so back databases up with a command. Recipes are in [Backups](backups.md#recipes).

## Where values come from

Every `${NAME}` in a Compose file is filled from **control**, or from the default written in the file. `tug deploy` never reads the shell environment of the machine that runs it, the `.env` next to the file, or an `env_file`, so a laptop and a CI job deploy the same thing from the same commit. `.env` still works for a local `docker compose up`. When one is present, `deploy` says so and lists the names control lacks.

| Source | Set with | Shown | Usable in | Takes effect | On rollback |
| --- | --- | --- | --- | --- | --- |
| Project secret | `tug secret set NAME`, `tug secret import` | Never (`•••`) | `environment`, `command`, `entrypoint`, `healthcheck.test` | The next reconcile, which recreates the services that use it | Uses the current value |
| Project variable | `tug var set NAME`, `tug var import` | `tug var list --values`, `deploy --dry-run` | Anywhere Compose interpolates: `image`, `ports`, `volumes`, `labels`, `x-tug` | The next deploy | Restores the value the earlier deployment used |
| `--var NAME=value` | `tug deploy --var` | Recorded on the deployment, with its value | Anywhere a variable can | That deploy only | Restores the value it had |
| Default in the file | `${NAME:-default}` | In the Compose file | Anywhere | The next deploy | Restores it |

- **Secret or variable.** A name is one or the other in a project. Use a secret for anything private, and a variable for configuration that is fine to read, such as an image tag, host name or port, which control and the agent must see before a container exists. A secret in `image`, `ports`, `volumes`, `labels` or `x-tug` is rejected, naming the field and suggesting `tug var set`. Tug never guesses which names are private, and `tug secret import` makes everything a secret unless you name variables.
- **Roles.** Setting a secret needs `admin`. Variables need `deploy`, so CI can run `tug var set` or pass `--var TAG=$GITHUB_SHA`. A `--var` cannot replace a secret, and its value is recorded in plain text.
- **Checking.** The deploy output reports the sources (`Values: 4 secrets, 2 vars, 1 --var (TAG), 1 default`). `tug deploy --dry-run` prints every referenced name with its source and stops. The deployment records the same list (`values` in `--json` and in `GET /api/v1/deployments/:id`) without secret values.
- **Missing values.** A missing value fails with the names and the commands that set them. In a terminal, `deploy` offers to generate a secret, enter one, or enter a variable.
- **Profiles** come from `tug deploy --profile <name>` or `profile` in `tug.yml`, not `COMPOSE_PROFILES`.
- **Moving a `.env`:** `tug secret import .env`. Every entry becomes a secret, `--vars NAME,...` makes the ones you name variables, and a terminal confirms the list (`--select` chooses per entry).

Only the main Compose file is scanned for the record and the missing-value check. A file pulled in with `extends` is still interpolated from the same control values.

### Secrets in services

Reference a secret with `${NAME}` in a service's `environment`, `command`, `entrypoint` or `healthcheck.test`. `environment: [DB_PASSWORD]` passes it through. Control resolves it at deploy time, and the `@@tug:secret:NAME@@` placeholder you may see in a normalized file is internal. Only secrets a service references go to its node, and a changed secret recreates exactly the services that use it. Deploying a file that references a secret the project lacks is rejected. Secrets reach the container environment, so keep them out of `command` unless you accept them showing in `docker inspect`.

## Example: an app and a database on one node

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
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

Set `DB_PASSWORD` and `DB_ROOT_PASSWORD` with `tug secret set` before deploying. The MariaDB flag keeps the buffer pool small enough for a 1 GB host that also runs the agent.

## Native Compose reader

`tug deploy` reads the Compose file itself (`src/compose/load.ts`). Its output matches `docker compose config`, and a test compares the two on the shipped examples and a fixture corpus when Docker Compose is installed.

| Feature | Behavior |
| --- | --- |
| Interpolation | `$VAR`, `${VAR}`, `:-`, `-`, `:?`, `?`, `:+` and `+`, nested to any depth, `$$` for a literal dollar. Under `tug deploy` the variables are exactly those control holds and `--var` supplies (secrets as sentinels), then the file's defaults. As a library, or in Compose itself, the reader follows Compose: the environment, then the `.env` next to the file |
| `env_file` | A path, a list, or `{ path, required }`, merged under `environment`, with bare `KEY` entries taken from the environment. `tug deploy` rejects it. Store entries with `tug secret import <file>` or `tug var import <file>` and list the ones a service needs under `environment` |
| `extends` | In the same file or another, with Compose's merge rules. Mappings merge. `ports`, `expose`, `tmpfs`, `cap_add` and `cap_drop` append. A volume with the same target replaces the base one. `command`, `entrypoint` and `healthcheck.test` are replaced |
| Profiles | A service in an inactive profile is not deployed. Activate with `tug deploy --profile <name>` or `profile` in `tug.yml`. Top-level volumes that no remaining service mounts are dropped, as Compose does |
| Short syntax | Expanded to long form: `ports` (ranges, IPv6 hosts, protocols), `volumes`, `depends_on`, `environment`, `labels`, `extra_hosts`, `healthcheck.test`, `build`, and `command` or `entrypoint` strings split into words. Sizes become byte counts, and durations use Compose's `1m30s` form |

Two differences from Compose are deliberate. A `command` string with a shell operator (`a && b`) is an error, where Compose silently keeps only `a`, so write a list or `sh -c '...'`. Relative `env_file` paths resolve against the Compose file's directory, where a deploy reads none.

A file that uses `include`, an `!reset` or `!override` tag, or a non-dotenv `env_file` format is rejected with an error that names the construct. Render it instead with `tug deploy --compose-cli` (or `TUG_COMPOSE_CLI=1`), which runs `docker compose config` and needs Docker Compose v2 on your machine. It follows the same rules as the native reader: a scrubbed environment, an empty `--env-file` in place of the implicit `.env`, and only control's values.

## Not supported

- `container_name`. Tug names containers `tug-<project>-<service>-<hash8>` so projects stay isolated.
- `deploy`, which has Swarm semantics.

## Supported keys

| Scope | Accepted keys |
| --- | --- |
| Service | `image`, `build`, `command`, `entrypoint`, `environment`, `ports`, `expose`, `volumes` (named volumes and absolute bind mounts), `tmpfs`, `healthcheck`, `restart`, `labels`, `depends_on` (`service_started`, `service_healthy`), `extra_hosts`, `user`, `working_dir`, `hostname`, `init`, `read_only`, `shm_size`, `mem_limit`, `mem_reservation`, `cpus`, `pids_limit`, `cap_add`, `cap_drop`, `ulimits`, `logging`, `stop_grace_period`, `stop_signal`, `x-tug` |
| Top-level volume | `driver`, `driver_opts`, `labels`, `external`, `name`, `x-tug` |
| Ignored | `pull_policy`, because Tug decides when images change |
| Rejected, with the key named | Everything else, including `network_mode`, `privileged`, `devices`, `pid`, `ipc`, `container_name`, `env_file`, custom networks, and top-level `configs` and `secrets` |

Containers use Tug's own network, volume and container names (`tug_<project>`, `tug_v<project-length>_<project>_<volume>`), so existing Compose-created volumes are not reused. If an owned volume exists under an earlier Tug name and its new-name volume does not, Tug refuses to create an empty replacement or restart the workload. The older volume stays on the node, so recover or copy its data before deploying.
