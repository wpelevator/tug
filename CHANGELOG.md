# @wpelevator/tug

## 0.7.0

### Minor Changes

- c52bb43: Add an `examples/wordpress` project (WordPress and MariaDB with scheduled backups, restore and one-off commands) and replace the sidecar backup recipe with it. Fix Compose escaping: literal dollars written `$$` in a Compose file now reach the container as `$`, as they do with `docker compose up`, which also lets backup and restore commands read passwords from the container's environment. Make `restore --from latest` skip the safety snapshot taken before a previous restore.
  
  Also: `tug restore` waits for the services it stopped to serve again, `backup-list --check` exits nonzero for stale, failed or missed targets, `x-tug.backup.memory` sets the restic helper's memory limit, a failed health check says when the agent runs outside a container, and the runtime image no longer defaults to the control role, so `TUG_ROLE=agent` works.

## 0.6.0

### Minor Changes

- 3015c4a: Validate `x-tug.backup` on services (a command whose output is stored) and volumes, with project defaults and single-placement rules, and add a UTC cron parser.
- 28c4156: Add the backup destination: `backup-destination-set|show|remove` store S3-compatible credentials encrypted on control, `backup-key` prints a project's derived restic repository password, and agents can fetch credentials only for their own running backup command. Backups themselves are not scheduled yet.
- 8ab3fb1: Add a committable CLI config file (`tug.yml`, YAML or JSON) that records the control URL, default project, `deploy` defaults and the servers to install, where each key is the camelCase of the flag it defaults and flags always win. `node-install --name app1` reads the SSH target and install flags from `nodes.app1`. The API token is no longer read from the tracked config: it lives in the git-ignored `tug.local.yml` overlay (or `TUG_TOKEN`), `tug init` writes it there, and the config key is renamed from `operatorToken` to `token`. Source uploads now also exclude the overlay and the root config file.
- eae358e: Remove the `x-tug.type: nfs` volume type and its `x-tug.address` and `x-tug.export` keys. Tug never ran the NFS server, so users prepared the exporter anyway; mount a file server you operate with plain Compose `driver: local` and `driver_opts` instead. Backup validation no longer has an NFS exporter rule.
- 28c4156: Run scheduled backups. `x-tug.backup` on a service names a command run in the service's container whose output is stored (so any database or tool works, with recipes in the docs), and on a volume archives its files. Control schedules them, agents run restic in a helper container, and runs are recorded in a catalog with `backup.completed`, `backup.failed`, `backup.missed`, `backup.stale` and `backup.no_destination` events. Add `backup-run`, `backup-list` and restores (`restore`, `restore-list`, `restore-resume`, `restore-release`): an in-place restore locks the project, stops the services that write to the target, takes a safety backup, restores through the service's own `restore` command or the volume's files, and starts them again; a scratch restore of a volume touches nothing live.
- 28c4156: Add `tug run SERVICE -- command`: a one-off container with the service's image, environment, secrets, network and mounts, removed afterwards, returning the command's exit code and recorded as a `job.run` event.

### Patch Changes

- a14fb06: Correct node documentation: nodes need only the Docker Engine, not the Compose plugin, and the rollout and ingress descriptions now match the Engine API agent.

## 0.5.0

### Minor Changes

- c715f8b: Pin published images to registry digests before deployment so rollback and new nodes reuse the same image. Always deliver Tug-built images as saved archives, remove build-registry configuration and node registry tokens, and support private published images through the encrypted TUG_REGISTRY_AUTH project secret.

### Patch Changes

- 72c112b: Preserve base64url padding in private registry pull credentials so Docker Engine accepts authentication for all username and password lengths.
  
  Use a direct PHP health endpoint in the WordPress backup example so installed sites do not depend on their public ingress route to pass local health checks.
- 6840b72: Add reproducible Docker Compose benchmarks comparing nginx, Caddy proxying to nginx, and direct Caddy for PHP-FPM and static files, including latency, throughput and CPU measurements.
- 69dcba9: Use Node's built-in SQLite for control and agent state, removing SQLite native-addon installation and its Docker build toolchain. Node >= 22.18 remains supported. Snapshot creation and restore integrity checks run synchronously; large databases can briefly pause control traffic.

## 0.4.0

### Minor Changes

- f58e2f8: The agent reconciles containers through the Docker Engine API instead of the `docker compose` CLI (M14). `tug deploy` normalizes the Compose file with `docker compose config` on the operator machine (control secrets travel as sentinels), control validates a supported-key allowlist, nodes no longer need the Compose plugin, secrets are no longer written to `.env`, and `exec -t` gets a real PTY with resize. Tug now names its own network, volumes and containers (`tug_<project>`), so volumes created by earlier versions are not reused.

## 0.3.0

### Minor Changes

- 2e93255: Implement M6 placement and scheduling (node labels, label-based placement, replica spread, global mode, `tug scale`) and M7 NFS shared volumes.
- 2e93255: Add `tug node-remove` to delete a retired node and `control-install --mesh` to enable the WireGuard mesh on control.
- 319b45f: Published ports are private by default (M10). Generated Compose binds `ports` entries that name no host IP to the node's overlay IP when the mesh is on, to `127.0.0.1` when only the managed Caddy on the same node dials the service, and otherwise to the node's `address`, with a `ports.public` warning event when that address is public. Entries with an explicit host IP, including `0.0.0.0`, are unchanged, so write `"0.0.0.0:80:80"` to publish something on purpose. `tug doctor --nodes` adds a `ports.public` check listing containers of Tug projects that listen on a public address. A node's `--address` must be an IP on one of its interfaces (or a hostname that resolves to one), because ports bind to it.
- e14afdd: Wake agents immediately for deployments and queued work through an authenticated outbound WebSocket, with cursor-based long-poll and periodic polling fallbacks.
- db98497: Add live non-TTY exec, followed service logs, ps, and inspect over the outbound agent stream.

### Patch Changes

- 28c50c2: The agent now always runs with `--network host` (`node-install`, `node-enroll` and its cloud-init). Its TCP and HTTP health checks dial container IPs, which an agent on the default Docker bridge cannot reach on current Docker (29.x), so every first deploy on a fresh node failed health. `--mesh` still adds `NET_ADMIN` and `TUG_MESH`.
- 72e2b67: `--build-local-image` now builds for the target host's architecture, read with `uname -m` over SSH, instead of the machine running the CLI. Before, installing an amd64 VPS from an arm64 Mac produced an image that failed with `exec format error`.
- 74e6345: `control-install` can be run again over a running control to upgrade it. Its port preflight no longer fails when the port is held by the existing `tug-control-control-1` container; any other listener still fails it.
- 446a291: Agents pull published `image:` services only when a deployment revision is new to the node, instead of on every poll. Before, a tag that moved upstream (for example `mariadb:11`) was pulled and the container recreated within seconds without a deploy.
- 2e93255: Skip stale nodes when resolving label and `global` placement and in `tug scale`, so a dead host cannot hold a rollout open. Fix NFS volumes so consumers mount the exporter's overlay or node address and the exporter bind-mounts the export path.
- 446a291: Add an interim WordPress backup recipe: an `examples/wordpress-backup` Compose project with a restic backup sidecar (database dump, uploads, retention, health), and `docs/backups.md` with multi-node and NFS variants, a control-plane backup cron and a restore drill, until `x-tug.backup` (M11) exists.

## 0.2.1

### Patch Changes

- ac04ba0: Failed deploys now include the node apply error and any rollout error in the message `tug deploy` prints, instead of only "failed health". `tug logs` and `tug restart` name the project when the service is missing. `tug doctor --node` and `--nodes` wait for the agent result.
- f429756: Agents now report a service's lifecycle events only when something changes (a new revision, changed secrets or configuration), plus one event when an apply fails and one when it recovers, instead of four events per service on every poll. Control deletes events older than 30 days and keeps at most 100,000 (`TUG_EVENT_RETENTION_DAYS`, `TUG_EVENT_MAX_ROWS`), so `tug events` shows deployments, rollbacks and failures again.

## 0.2.0

### Minor Changes

- a052d94: Extend `--install-docker` beyond Debian and Ubuntu to Fedora and RHEL-compatible hosts (RHEL, Rocky Linux, AlmaLinux and CentOS Stream 9/10) using Docker's official dnf repository. Unsupported distributions still stop with an instruction to install Docker manually.
- 367a340: Deploy built applications without provisioning a registry: control stores verified compressed image archives and agents download them with their existing credentials. Add local application builds with `deploy --build-local`, immutable deployment revisions, rollback-safe image retention and image-aware control backups.
  
  Add opt-in Docker Engine/Compose setup with `--install-docker`. Use flat command names such as `control-install`, `node-install` and `secret-set`, stricter argument validation, and shared CLI configuration precedence. Set `--agent-control-url` when agents need a different control address from the operator, such as with an SSH tunnel or private network.
  
  Ship the Docker Compose plugin inside the Tug runtime image so agents installed on real hosts can apply application Compose files without depending on host CLI plugins.
- 8c72d59: Add opt-in zero-downtime rolling rollouts: a service with `x-tug.rollout: { strategy: rolling, drain: 30s }`, an ingress and a health check starts each new revision next to the old one on its own host port (`TUG_ROLLOUT_PORTS` on the agent), switches the Caddy ingress once it is healthy and removes the old revision after the drain. A revision that fails its health check is removed and the old one keeps serving. `recreate` stays the default and behaves as before.
  
  Add `x-tug: { rollback: auto }` at the top level of a Compose file to roll a failed deployment back automatically to the previous succeeded one (recorded as a `deployment.auto_rollback` event, never applied to rollback deployments). Deployment versions starting with `rollback-` are now reserved.
- 3a87fef: Add named, scoped API tokens for CI and teammates: `token-create`, `token-list` and `token-revoke` manage `read`, `deploy` and `admin` tokens, optionally limited to projects and with an optional expiry. Tokens are stored hashed, shown once, revocable immediately and included in control backups; the operator token keeps full access. Deployments and control events (deploy, rollback, cancel, restart, secret and token changes) now record the acting token, shown by `tug events` (use `--all` for events outside the current project). Includes a documented GitHub Actions deploy workflow in the new access-control guide.

## 0.1.0

### Minor Changes

- c548ed5: First public release: the `tug` CLI and `tug-node` agent/control entrypoint are published to npm as `@wpelevator/tug`, and the matching Docker image to `ghcr.io/wpelevator/tug`. `control install`, `node install` and `node enroll` now default `--image` to the image for the CLI's own version; `--build-local-image` replaces the old build-and-copy default.
