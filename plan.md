# Portable VPS Launch Pad — Spec and Implementation Plan

## 1. Goal

Build a provider-agnostic self-hosted deployment tool for ordinary VPSes.

The tool should let a user deploy a `docker-compose.yml` application to one or more Linux servers without depending on AWS, Kubernetes, or a commercial PaaS. It should provide a small self-hosted control plane, Linux-native remote builds, encrypted secrets, persistent accessories, backups, and lightweight agents that reconcile desired state on each node.

Primary target use case:

- one control VPS,
- one public nginx/front node,
- three PHP-FPM WordPress app nodes,
- one MariaDB container with persistent storage,
- one Memcached container,
- one NFS-backed shared WordPress document root volume pinned to a storage node,
- remote Linux image builds to avoid slow macOS cross-builds.

Non-goals for the first version:

- Kubernetes compatibility,
- cloud-provider provisioning APIs,
- autoscaling,
- distributed block storage,
- database HA/failover,
- multi-tenant public SaaS control plane,
- fully zero-downtime orchestration for every Compose feature.

---

## 2. Product Shape

### CLI

Example commands:

```bash
# one-time bootstrap
launchpad control install root@control.example.com
launchpad node install root@front.example.com --name front --address 10.0.0.10
launchpad node install root@wp1.example.com --name wp1 --address 10.0.0.11
launchpad node install root@wp2.example.com --name wp2 --address 10.0.0.12
launchpad node install root@wp3.example.com --name wp3 --address 10.0.0.13
launchpad node install root@db.example.com --name db --address 10.0.0.20
launchpad node install root@cache.example.com --name cache --address 10.0.0.30
launchpad node install root@storage.example.com --name storage --address 10.0.0.40

# app lifecycle
launchpad init
launchpad secret set DB_PASSWORD
launchpad deploy
launchpad status
launchpad logs wordpress  # proxies docker compose logs; no central log aggregation in early MVP
launchpad backup run mariadb  # later backup milestone
launchpad rollback
```

The first version should use SSH only for installation/bootstrap. Normal deploys should not require SSH; they should go through the control API and node agents.

V1 assumes Docker and Docker Compose are already installed on all hosts, and that SSH keys are already configured so the CLI can reach the control and runtime machines during installation.

### App Definition

The user defines the application with a normal `docker-compose.yml`, plus `x-launchpad` metadata for deployment-specific behavior.

Local development remains:

```bash
docker compose up
```

Production deployment becomes:

```bash
launchpad deploy
```

---

## 3. High-Level Architecture

```text
Developer / CI
  - reads docker-compose.yml
  - uploads source context to control plane
  - watches deployment status

Control VPS
  - launchpad-control API
  - SQLite database
  - public HTTPS Docker registry protected by token auth
  - Linux build worker
  - encrypted secrets store
  - backup metadata/catalog in later milestones

Runtime VPSes
  - launchpad-agent
  - Docker
  - generic registered nodes with names and addresses
  - services are assigned by project/service placement, not by fixed node role

Example service placement for the target WordPress app:

Front node
  - nginx
  - routes public traffic to WordPress app nodes

WordPress app nodes x3
  - php-fpm WordPress container
  - mount shared NFS WordPress document root volume

DB node
  - MariaDB container
  - local persistent data volume

Cache node
  - Memcached container

Storage node
  - NFS server container
  - local persistent shared WordPress document root volume
```

Request path:

```text
Internet -> nginx front node -> one of wp1/wp2/wp3 over PHP-FPM TCP
nginx/front + WordPress app nodes -> shared NFS WordPress volume
WordPress app nodes -> MariaDB / Memcached
```

Deploy/control path:

```text
CLI -> control API -> node agents -> Docker/Compose
```

The control VPS is not in the public application request path.

### 3.1 V1 Networking Model

V1 does not provision a runtime overlay network. Launchpad assumes all nodes can reach required peers using configured IP addresses or hostnames. These may be provider-private addresses, public addresses protected by firewall rules, or manually managed VPN addresses.

Control-plane and registry communication use HTTPS with token authentication:

```text
CLI -> control API: HTTPS + operator token
agent -> control API: HTTPS + per-node agent token
Docker daemon -> public HTTPS registry + per-node registry pull token
```

Runtime service communication is direct between nodes using configured addresses:

```text
front -> app nodes: PHP-FPM TCP
app -> database: MariaDB TCP
app -> cache: Memcached TCP
front/app -> storage: NFS
nodes -> public registry: HTTPS
agents -> control: HTTPS
```

Security boundary for runtime service traffic is operator-managed in v1. The operator is responsible for private networking, provider firewalls, host firewalls, or an external VPN. Launchpad secures control-plane and registry access with HTTPS and tokens, but does not encrypt MariaDB, Memcached, NFS, or PHP-FPM traffic itself in v1.

### 3.2 TLS Model

Caddy manages TLS for the control API and public HTTPS registry.

For application ingress, nginx config remains user/application-owned. If the application needs TLS certificates, early MVP should use Caddy only as a certificate manager/ACME helper where practical, with nginx loading certificates from a documented host path or mounted volume. Launchpad should not generate application nginx server blocks in early MVP.

Operators may also provide their own certificates and mount them into the nginx container.

Each node has at least:

```json
{
  "id": "wp1",
  "name": "wp1",
  "address": "10.0.0.11",
  "publicAddress": "203.0.113.11"
}
```

`address` is used for internal service traffic and generated configs. `publicAddress` is used for SSH/bootstrap or public ingress when needed. Labels are reserved for later versions; MVP placement uses explicit node names only.

---

## 4. Core Components

### 4.1 Control API

Runs on the control VPS.

Responsibilities:

- authenticate CLI and agents using HTTPS bearer tokens,
- issue and revoke per-node agent tokens and per-node registry pull tokens,
- store projects, nodes, desired state, deployment history, status, and secrets,
- accept source uploads or git refs for remote builds,
- run Linux-native builds,
- push immutable images to the public HTTPS registry,
- expose desired state to agents,
- receive agent status,
- coordinate deploy phases such as drain/update/enable in later multi-node milestones,
- store backup metadata in later backup milestones.

Suggested implementation:

- HTTP API,
- SQLite database for metadata,
- local filesystem for build contexts and registry data,
- Caddy in front of the API/registry for TLS management.

### 4.2 Public HTTPS Registry

Runs on the control VPS and is exposed over public HTTPS.

Responsibilities:

- store application images built by the remote builder,
- serve images to runtime nodes over public HTTPS,
- require per-node registry pull tokens for image pulls,
- use immutable tags, never `latest` for production desired state.

V1 does not rely on registry network privacy. Any node with valid HTTPS access and a valid registry pull token can pull assigned images.

Image pruning and registry garbage collection are deferred. Early MVP should retain built images to avoid accidentally breaking rollback or redeploying previous versions.

Example image tags:

```text
registry.control.example.com/site/wordpress:git-abc123
registry.control.example.com/site/nginx:git-abc123
```

### 4.3 Build Worker

Runs on the control VPS.

Responsibilities:

- receive source tarballs from CLI,
- respect `.dockerignore`,
- build images natively on Linux,
- reuse Docker/BuildKit layer cache,
- push built images to the local registry,
- return immutable image references to the control API.

First implementation can use plain Docker:

```bash
docker build -t registry/site/wordpress:git-abc123 .
docker push registry/site/wordpress:git-abc123
```

Later implementation can use BuildKit cache exporters.

### 4.4 Node Agent

Runs on every runtime node.

For the initial MVP, the agent may run as a container with access to the Docker socket and Launchpad state directories. Later stateful/NFS milestones may require a host binary or privileged host helper for mount and systemd management.

Responsibilities:

- poll control API for desired state using a per-node agent token,
- reconcile local Docker/Compose state,
- write generated Compose files and `.env` files,
- fetch scoped secrets and render them as environment variables,
- report health/status/log metadata to the control API.

Log behavior in early MVP:

- no central log aggregation,
- no persistent control-plane log storage,
- `launchpad logs <service>` proxies to the assigned node/agent, which reads local `docker compose logs` output.

Early MVP agent non-goals:

- no host mount management,
- no systemd management,
- no firewall management,
- no application-owned nginx config management,
- no backup/restore execution.

Agents should be idempotent: applying the same desired state twice should be a no-op.

### 4.5 Runtime Orchestrator

For v1, use Docker Compose directly on each node.

The agent writes generated files under:

```text
/var/lib/launchpad/projects/<project>/docker-compose.yml
/var/lib/launchpad/projects/<project>/.env
```

Then applies:

```bash
docker compose -p <project> pull
docker compose -p <project> up -d --remove-orphans
```

The agent preserves service names from the source Compose file. It may rewrite build/image fields and env-file references, but should avoid inventing new runtime service names in generated Compose files.

The agent does not render application nginx config in early MVP. nginx configuration is owned by the user/application and delivered through the user's Compose project, image, bind mount, or volume.

### 4.6 Bootstrap Assumptions and Install Flow

V1 assumes:

- Docker and Docker Compose are already installed on every host.
- SSH access from the CLI machine to each host is already configured.
- Runtime node-to-node networking is already available through configured addresses.

`launchpad control install` should install and configure:

- launchpad-control API service,
- SQLite database,
- public HTTPS registry protected by token auth,
- build worker,
- Caddy-managed TLS configuration for the control API and registry,
- initial operator token,
- server-side token storage for agents and registry pulls.

`launchpad node install` should, over SSH:

- register the node with the control plane,
- assign/store node name and addresses,
- create a per-node agent token,
- create a per-node registry pull token,
- install the agent container,
- write `/etc/launchpad/agent.env` or equivalent config,
- configure Docker registry credentials for the public HTTPS registry,
- start the agent.

Normal deploys should not use SSH.

### 4.7 Agent Work and Reconciliation Model

Agents are pull-based reconcilers in v1. The control plane does not need inbound network access to runtime nodes.

V1 should not use an external queue, broker, or pub/sub system. SQLite is the source of truth for desired state, commands, deployments, and observed status. Agents long-poll the control API for node-specific work, reconcile idempotently, and report results.

Primary agent endpoints:

```text
GET  /agent/v1/work               long-poll for desired state and commands
POST /agent/v1/status             report observed state, health, and command results
POST /agent/v1/events             report deploy/log lifecycle events
GET  /agent/v1/secrets            fetch scoped secrets for assigned services
POST /agent/v1/backups            report backup metadata/results (later backup milestone)
```

`GET /agent/v1/work` returns both the current desired state and one-shot command work items:

```json
{
  "serverTime": "2026-06-26T00:00:00Z",
  "nodeId": "wp1",
  "desiredState": {
    "version": "dep_123",
    "project": "site",
    "services": []
  },
  "commands": [
    {
      "id": "cmd_123",
      "type": "diagnostics.run",
      "target": "docker",
      "payload": {},
      "deadline": "2026-06-26T00:10:00Z"
    }
  ]
}
```

Rules:

- Every request uses HTTPS and the per-node agent token.
- Agents poll or long-poll `/agent/v1/work`; a typical long-poll timeout is 30 seconds.
- Desired state is versioned and idempotent.
- Agents should reconcile desired state rather than blindly execute deploy jobs.
- One-shot operations such as restart, log fetch, or diagnostics may be represented as per-node commands returned by `/work`. Backup/restore commands are deferred beyond early MVP.
- Commands must have IDs and explicit result reporting so retries are safe.
- Agents store the last successfully applied desired state locally.
- If the control plane is unavailable, existing containers keep running and agents do not apply new changes.
- Agents periodically retry control-plane polling and status upload.
- The control plane marks agents stale if no status is received within a configured timeout.
- Queue/pubsub may be added later only as a notification optimization; it should not become the source of truth.

### 4.8 Deployment State Machine

Deployment states should be explicit so deploy, rollback, retry, and status behavior are predictable.

Project deployment states:

```text
created -> uploading -> building -> pending_dependencies -> rolling_out -> succeeded
                                      \-> build_failed
                                      \-> failed
                                      \-> cancelled
```

Per-node rollout states:

```text
pending
pulling
starting
health_checking
serving
draining
degraded
failed
```

Only one deployment per project may be active at a time. Secret changes and deploys should take project/node locks where needed to avoid conflicting operations. Backup/restore locks are deferred until those features are implemented.

---

## 5. Compose Contract

Use standard Compose where possible. Use `x-launchpad` for deployment metadata.

Example WordPress stack:

```yaml
services:
  wordpress:
    build: ./wordpress
    image: wordpress-app
    environment:
      DB_HOST: ${DB_HOST}
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      MEMCACHED_HOST: ${MEMCACHED_HOST}
    volumes:
      - wp-shared:/var/www/html
    x-launchpad:
      placement:
        nodes: [wp1, wp2, wp3]
      replicas: 3
      health:
        type: tcp
        port: 9000

  nginx:
    build: ./nginx
    image: wordpress-nginx
    volumes:
      - wp-shared:/var/www/html:ro
    x-launchpad:
      placement:
        nodes: [front]
      domains:
        - example.com
        - www.example.com
      upstream: wordpress
      upstreamProtocol: fastcgi

  mariadb:
    image: mariadb:11
    environment:
      MARIADB_DATABASE: ${DB_NAME}
      MARIADB_USER: ${DB_USER}
      MARIADB_PASSWORD: ${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    volumes:
      - mariadb-data:/var/lib/mysql
    x-launchpad:
      placement:
        nodes: [db]
        sticky: true
      # backup metadata is planned for a later milestone
      # backup:
      #   type: mariadb
      #   schedule: "0 3 * * *"
      #   retentionDays: 14

  memcached:
    image: memcached:1.6
    x-launchpad:
      placement:
        nodes: [cache]

volumes:
  mariadb-data:
    x-launchpad:
      type: local
      persistent: true

  wp-shared:
    x-launchpad:
      type: shared
      driver: nfs
      placement:
        nodes: [storage]
      sticky: true
      size: 100GiB
      # backup metadata is planned for a later milestone
      # backup:
      #   type: filesystem
      #   schedule: "0 2 * * *"
      #   retentionDays: 14
```

### 5.1 V1 Compose Compatibility

Launchpad uses `docker-compose.yml` as source intent, but agents write generated per-node Compose files. Distributed deployment is not a full multi-host implementation of every Compose feature.

V1 supported:

- `services.*.image`
- `services.*.build` for remote builds
- `services.*.environment`
- named volumes with `x-launchpad`
- basic health metadata under `x-launchpad.health`
- `x-launchpad.placement`, `replicas`, and domain metadata

V1 supported with limitations:

- `ports`: production bindings may be generated or restricted to configured node addresses
- `volumes`: named persistent/shared volumes are supported; early MVP does not manage host mounts
- `depends_on`: used as a hint only; real readiness comes from health checks
- `env_file`: may be folded into generated env files

V1 rejected or deferred:

- arbitrary custom Compose networks across nodes
- `container_name`
- Swarm-only `deploy` semantics
- Compose `secrets`/`configs` as runtime primitives
- unsupported relative bind mounts
- label selectors and autoscheduling
- release hooks
- backup/restore metadata execution
- ambiguous services without `x-launchpad.placement` in multi-node projects

Notes:

- `build:` is allowed in source Compose.
- Production desired state replaces `build:` with immutable `image:` tags.
- Named persistent volumes are never deleted on normal deploy.
- Early MVP supports generated Compose files while preserving source service names.
- Shared NFS volumes are implemented in a later milestone as a managed storage accessory pinned to one node.
- For the WordPress target use case, nginx and PHP-FPM both mount the same shared WordPress document root so nginx can serve static files directly and proxy PHP requests to app nodes over FastCGI/PHP-FPM TCP.
- nginx config is user/application-owned. Launchpad does not generate nginx application config in early MVP.

### 5.2 Health Check Contract

Services should declare health checks in `x-launchpad.health` when possible.

Example:

```yaml
x-launchpad:
  health:
    type: tcp # tcp | http | command | docker
    port: 9000
    interval: 10s
    timeout: 2s
    retries: 3
```

V1 rules:

- PHP-FPM services can use TCP health checks on port 9000.
- HTTP services can use path/port checks.
- Docker health status may be used when the image defines `HEALTHCHECK`.
- A service is considered healthy only after the configured retry threshold passes.
- Failed health checks during rollout stop the rollout and leave the failed node out of rotation when possible.

---

## 6. State Model

Control DB tables, conceptually:

```text
users / tokens
projects
nodes
deployments
desired_states
node_statuses
secrets
volumes
backups
builds
commands
events
locks
```

Initial SQLite schema can start with these tables:

```text
projects(id, name, current_deployment_id, created_at, updated_at)
nodes(id, name, address, public_address, status, agent_token_hash, registry_token_hash, last_seen_at, created_at, updated_at)
deployments(id, project_id, version, state, created_at, updated_at, error_message)
desired_states(id, project_id, deployment_id, version, state_json, created_at)
node_statuses(id, node_id, project_id, observed_version, status_json, health, updated_at)
builds(id, project_id, deployment_id, service, source_hash, image_ref, state, logs_path, created_at, updated_at)
secrets(id, project_id, name, encrypted_value, version, created_at, updated_at)
volumes(id, project_id, name, type, driver, node_id, config_json, created_at, updated_at)
backups(id, project_id, target, node_id, state, artifact_ref, metadata_json, created_at, completed_at) -- later backup milestone
commands(id, node_id, project_id, type, state, payload_json, result_json, attempts, run_after, deadline, created_at, updated_at)
events(id, project_id, deployment_id, node_id, level, type, message, metadata_json, created_at)
locks(name, owner, expires_at, created_at)
```

MVP may use a smaller subset, but the schema should preserve these concepts.

Important entities:

### API Contract, Conceptually

CLI/operator endpoints:

```text
POST /api/v1/projects
GET  /api/v1/projects/:project
POST /api/v1/nodes/register
GET  /api/v1/nodes
POST /api/v1/deployments
GET  /api/v1/deployments/:id
POST /api/v1/deployments/:id/cancel
POST /api/v1/rollback
POST /api/v1/secrets
GET  /api/v1/secrets
DELETE /api/v1/secrets/:name
# Later backup milestone:
# POST /api/v1/backups/run
# GET  /api/v1/backups
GET  /api/v1/status
```

Agent endpoints:

```text
GET  /agent/v1/work
POST /agent/v1/status
POST /agent/v1/events
GET  /agent/v1/secrets
# Later backup milestone:
# POST /agent/v1/backups
```

Build/registry flow:

```text
CLI uploads source context or git ref to control API.
Control build worker builds images locally.
Control pushes immutable tags to the public HTTPS registry.
Runtime Docker daemons pull over HTTPS using per-node registry pull tokens.
```

### Project

```json
{
  "id": "site",
  "name": "site",
  "currentDeploymentId": "dep_123"
}
```

### Node

```json
{
  "id": "wp1",
  "name": "wp1",
  "address": "10.0.0.11",
  "publicAddress": null,
  "status": "online"
}
```

### Deployment

```json
{
  "id": "dep_123",
  "projectId": "site",
  "version": "git-abc123",
  "state": "rolling_out",
  "createdAt": "2026-06-26T00:00:00Z"
}
```

### Desired State

```json
{
  "project": "site",
  "version": "git-abc123",
  "services": {
    "wordpress": {
      "image": "registry.control.example.com/site/wordpress:git-abc123",
      "replicas": 3,
      "placement": {
        "nodes": ["wp1", "wp2", "wp3"]
      }
    },
    "mariadb": {
      "image": "mariadb:11",
      "placement": {
        "nodes": ["db"],
        "sticky": true
      }
    }
  }
}
```

---

## 7. Placement Model

Keep placement simple in v1.

Nodes are generic capacity. Node installation does not assign a fixed role. Services and volumes declare placement explicitly in project configuration.

Rules:

- In single-node projects, services may default to the only registered node.
- In multi-node projects, each service should declare `x-launchpad.placement`.
- `placement.nodes` pins a service or volume to specific node names/IDs.
- Label selectors are deferred beyond MVP.
- Autoscheduling is deferred beyond MVP.
- `replicas` must match the number of explicitly selected nodes, or default to `len(placement.nodes)`.
- For v1, use one replica per selected node.
- Stateful services and volumes should use `sticky: true` and never move automatically.
- Deleting stateful data requires `--delete-data`.

Example:

```yaml
services:
  wordpress:
    x-launchpad:
      placement:
        nodes: [wp1, wp2, wp3]
      replicas: 3

  nginx:
    x-launchpad:
      placement:
        nodes: [front]

  mariadb:
    x-launchpad:
      placement:
        nodes: [db]
        sticky: true

volumes:
  wp-shared:
    x-launchpad:
      type: shared
      driver: nfs
      placement:
        nodes: [storage]
      sticky: true
```

For WordPress:

```text
nginx      -> front node
wordpress  -> wp1, wp2, wp3
mariadb    -> db node
memcached  -> cache node
wp-shared  -> storage node via NFS
```

Later versions can add labels and automatic scheduling, but v1 should use explicit placement only.

---

## 8. Persistent Storage

### 8.1 Local Persistent Volumes

Used for MariaDB.

Implementation:

- host path or Docker named volume on the DB node,
- mounted into the DB container,
- never deleted during deploy,
- backed up by service-specific backup jobs in later backup milestones.

### 8.2 Shared NFS Volumes

Used for the shared WordPress document root in the target WordPress deployment. nginx and PHP-FPM app containers both need direct filesystem access: nginx serves static files and proxies PHP requests to PHP-FPM app nodes.

For this WordPress mode, deployable WordPress files are treated as a shared filesystem artifact. Images provide runtime environment and packaged defaults, while the deployment process syncs the selected WordPress document root contents to the shared NFS volume before or during rollout. This must be versioned in deployment history so rollback can restore the previous image references and, where supported, the previous shared-file artifact.

Implementation:

- the node selected by volume placement runs the NFS server container,
- NFS server exports a host directory backed by local disk,
- front and app nodes mount the export,
- nginx container mounts the shared volume read-only,
- WordPress/PHP-FPM containers mount the shared volume read-write or as configured.

Important rules:

- NFS service is a sticky stateful accessory.
- App services depending on NFS should not start until the mount is healthy.
- NFS outages mark dependent services degraded.
- Backups run from the storage node.

Example runtime layout:

```text
storage node:
  /srv/launchpad/volumes/wp-shared -> exported by NFS

front node:
  /mnt/launchpad/site/wp-shared -> mounted from storage node

wp node:
  /mnt/launchpad/site/wp-shared -> mounted from storage node

nginx container:
  /var/www/html -> read-only bind mount from front node

wordpress/php-fpm container:
  /var/www/html -> bind mount from wp node
```

In v1, Launchpad may initially require the operator to provide working node-to-node connectivity and firewall rules for NFS. Managed NFS mount lifecycle can be implemented in the stateful/NFS milestone.

---

## 9. Secrets

Secrets live in the control plane, encrypted at rest.

Implementation:

- generate a master key during `control install`,
- store it on the control VPS, e.g. `/etc/launchpad/master.key`,
- encrypt secret values before writing to SQLite,
- issue scoped node tokens,
- agents fetch only secrets required by services assigned to their node.

Agent API tokens and registry pull tokens are separate credentials. Removing or disabling a node should revoke both.

CLI UX:

```bash
launchpad secret set DB_PASSWORD
launchpad secret list
launchpad secret rm DB_PASSWORD
```

Runtime:

- agent fetches plaintext secrets over TLS,
- writes `.env` with `0600` permissions,
- exposes secrets to containers as environment variables through generated Compose/env files,
- restarts affected services when secret versions change.

MVP supports secrets as environment variables only. Docker secrets, Compose secrets/configs, file-mounted secrets, and binary secret payloads are deferred.

---

## 10. Backups

Backups are first-class for stateful accessories, but backup and restore implementation is deferred beyond early MVP. Early MVP may preserve backup metadata in specs but does not execute backup/restore commands.

Later backup support:

### MariaDB Backup

Run on DB node:

```bash
mariadb-dump | gzip > backup.sql.gz
```

Store in backup destination:

```text
backups/site/mariadb/2026-06-26T03-00-00Z.sql.gz
```

### Shared WordPress Volume Backup

Run on storage node:

```bash
restic backup /srv/launchpad/volumes/wp-shared
```

or simple v1:

```bash
tar -czf wp-shared.tar.gz /srv/launchpad/volumes/wp-shared
```

Store in backup destination:

```text
backups/site/wp-shared/2026-06-26T02-00-00Z.tar.gz
```

Backup destinations, in order of preference:

1. S3-compatible object storage supplied by user,
2. separate backup VPS/disk,
3. control VPS disk for development only.

Required CLI:

```bash
# later backup milestone
launchpad backup run mariadb
launchpad backup run wp-shared
launchpad backup list
launchpad restore mariadb --from latest
launchpad restore wp-shared --from latest
```

---

## 11. Deploy Process for a Version Update

Example: user changes WordPress theme/plugin code and runs:

```bash
launchpad deploy
```

### Step 1: Parse Compose

CLI reads `docker-compose.yml`, resolves `x-launchpad`, identifies buildable services.

For this stack, likely buildable services:

```text
wordpress
nginx
```

External images remain unchanged:

```text
mariadb:11
memcached:1.6
```

### Step 2: Upload Source Context

CLI creates a tarball respecting `.dockerignore` and uploads it to the control API.

### Step 3: Linux Remote Build

Control build worker builds changed images natively on Linux:

```bash
docker build -t registry.control.example.com/site/wordpress:git-abc123 ./wordpress
docker push registry.control.example.com/site/wordpress:git-abc123
```

If nginx config/image changed:

```bash
docker build -t registry.control.example.com/site/nginx:git-abc123 ./nginx
docker push registry.control.example.com/site/nginx:git-abc123
```

Layer cache remains on the control VPS.

### Step 4: Create Desired State

Control API records a new deployment with immutable image tags and any file artifacts needed for shared volumes such as the WordPress document root.

Only changed services get new images. For shared WordPress deployments, changed application files are staged as a versioned shared-volume artifact.

### Step 5: Ensure Stateful Dependencies

Before touching app nodes, agents confirm:

- MariaDB is healthy,
- Memcached is reachable,
- NFS export is healthy,
- front and app nodes have the shared WordPress NFS volume mounted,
- the target shared WordPress file artifact is present or can be synced safely.

### Step 6: Rolling Update WordPress Nodes

For each WordPress app node, one at a time:

```text
1. control API marks wp1 as draining
2. front/nginx agent removes wp1 from FastCGI upstreams and reloads nginx
3. wp1 agent pulls new wordpress image
4. wp1 agent recreates php-fpm container with the shared WordPress NFS mount
5. wp1 agent runs TCP or configured health check for PHP-FPM
6. front/nginx agent re-adds wp1 to upstreams
7. repeat for wp2 and wp3
```

This keeps at least two WordPress nodes serving traffic during normal rollout.

### Step 7: Release Hooks Deferred

Release hooks such as database migrations or cache flushes are deferred beyond early MVP.

Examples of deferred hooks:

```bash
wp core update-db
wp cache flush
```

Early MVP should require the operator to run these manually or include them in application-owned operational procedures. Later versions can add explicit run-once hook metadata with clear ordering, retry, exactly-once, logging, and rollback semantics.

### Step 8: Update Front Node if Needed

nginx config is user/application-owned. Launchpad does not generate application nginx config in early MVP.

If the nginx image or user-provided config artifact changed:

```text
1. pull the new nginx image or config artifact
2. recreate or reload nginx container through generated Compose
3. report healthy
```

Later versions may add Launchpad-managed upstream generation and drain/re-enable integration.

### Step 9: Report Convergence

Agents report status to control API:

```text
front: serving wp1/wp2/wp3
wp1: wordpress git-abc123 healthy
wp2: wordpress git-abc123 healthy
wp3: wordpress git-abc123 healthy
db: mariadb unchanged healthy
cache: memcached unchanged healthy
storage: nfs healthy
```

CLI exits when desired version equals observed version everywhere.

---

## 12. Rollback Process

Rollback should not rebuild.

```bash
launchpad rollback
```

Control API selects previous deployment and updates desired state to previous immutable image tags. For deployments that changed shared WordPress files, rollback should also select the previous shared-file artifact when available. Stateful data such as database contents and user uploads are still not rolled back automatically.

Agents perform the same rolling process:

```text
drain node -> pull old image -> recreate -> health check -> re-enable
```

Stateful volumes are not rolled back automatically. Database/user-content restore is a separate explicit operation. Rollback after irreversible database migrations may be unsafe and should be surfaced to the operator.

---

## 13. Failure Handling

### Build Failure

- deployment is not created or remains `build_failed`,
- current desired state remains unchanged,
- runtime nodes are untouched.

### One App Node Fails During Rollout

- rollout stops,
- failed node remains out of rotation if unhealthy,
- previous healthy nodes continue serving,
- operator can retry or rollback.

### DB Node Unhealthy

- new deploy should refuse to start unless `--force` is provided,
- status shows dependent services degraded.

### NFS Node Unhealthy

- app rollout should refuse to start,
- existing app containers may be degraded,
- backup warnings should be surfaced in later backup milestones.

### Control Plane Down

- existing app keeps running,
- agents keep the last successfully applied desired state locally,
- agents do not apply new changes while control is unreachable,
- nginx keeps the last rendered config and upstream list,
- deploy/status/secret changes unavailable until control plane returns,
- control-plane disaster recovery is out of scope for the MVP.

---

## 14. Security Model

- All control API traffic over TLS.
- CLI uses an admin/operator token.
- Each agent has a node-scoped token.
- Each node has a separate registry pull token.
- Runtime service traffic between nodes is not encrypted by Launchpad in v1; operators must secure it with private networking, firewalls, or an external VPN.
- Agent tokens can only:
  - read desired state for assigned node,
  - read scoped secrets for assigned services,
  - write node status/log metadata,
  - upload backup results for assigned stateful services in later backup milestones.
- Registry uses per-node pull tokens over HTTPS.
- `.env` files on nodes are root-owned and `0600`.
- Secret values are encrypted in SQLite.
- Backups should be encrypted before leaving the node or control plane once backup support is implemented.

---

## 15. MVP Milestones

### Milestone 1: Single Node Compose Deploy

Scope constraints:

- single control node,
- single project,
- single runtime node,
- no NFS,
- no managed nginx rolling upstreams,
- no backup/restore,
- no rollback beyond preserving previous deployment records,
- no external queue/pubsub,
- no automatic Docker/Compose installation.

Implementation goals:

- control install,
- node install over preconfigured SSH,
- assume Docker/Compose already installed,
- control API + SQLite,
- one containerized agent with Docker socket access,
- HTTPS token auth for CLI and agent,
- per-node registry pull token,
- `/agent/v1/work` long-poll endpoint,
- agent status/event reporting,
- parse Compose subset,
- remote build on control VPS,
- registry push/pull over HTTPS,
- generated per-node Compose file under `/var/lib/launchpad/projects/<project>/`,
- agent runs `docker compose -p <project> up -d --remove-orphans`,
- CLI waits until observed version matches desired version.

### Milestone 2: Secrets

- `secret set/list/rm`,
- encrypted storage,
- agent secret fetch,
- `.env` generation,
- restart on secret change.

### Milestone 3: Explicit Multi-Node Placement

- generic registered nodes,
- explicit service placement by node names/IDs,
- no label selectors,
- no autoscheduling,
- per-node desired state,
- app replicas across explicitly selected app nodes.

### Milestone 4: Multi-Node Front Node Support

- nginx deployed as a user-owned Compose service,
- nginx config owned by the application/client,
- Caddy-managed certificate acquisition/renewal where practical,
- nginx loads certificates from documented mounted paths or user-provided certificate mounts,
- upstream health checks,
- drain/re-enable API,
- rolling app-node updates.

Launchpad-managed nginx config generation is deferred beyond this milestone.

### Milestone 5: Stateful Accessories

- MariaDB as sticky accessory,
- local persistent volume lifecycle,
- destroy protection,
- no automatic backup/restore yet.

### Milestone 6: Shared NFS Volume

- explicit storage node placement,
- managed NFS container,
- NFS mount on front and app nodes,
- shared WordPress document root support,
- dependent-service health checks.

Shared volume backup is deferred to the backup milestone.

### Milestone 7: Production Hardening

- deploy history,
- rollback,
- log streaming or aggregation,
- backup/restore implementation,
- backup retention,
- image pruning/registry garbage collection,
- agent auto-upgrade,
- control-plane backup/restore,
- install diagnostics.

---

## 16. Key Design Principles

1. **Compose remains the user-facing app format.**
   Users should be able to run the app locally with `docker compose up`.

2. **Production uses immutable images.**
   The server never builds during runtime reconciliation. Builds happen on the control VPS.

3. **Stateful services are sticky.**
   MariaDB and NFS are pinned to one node unless the operator performs an explicit migration.

4. **No cloud-provider dependency.**
   Any VPS with SSH, Docker, and stable networking should work.

5. **Agents reconcile desired state.**
   Normal deploys should not depend on SSH sessions to every runtime node.

6. **Backups are part of the platform, not an afterthought.**
   Any first-class persistent service must have a backup story.

7. **Start simple.**
   Avoid Kubernetes, distributed filesystems, cloud APIs, autoscaling, and advanced schedulers until the basic loop is reliable.
