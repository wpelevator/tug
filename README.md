# Tug

The name: tugboats pull ships into place, like the pull-based agents here; `tug` is the CLI.

Deploy Docker Compose projects to one or more ordinary Linux VPSes through a small self-hosted control plane and a pull-based agent on each node, without Kubernetes or a hosted PaaS. What it is for, the deployment shapes it targets and the planned milestones are in the [Roadmap](docs/roadmap.md).

## Features

- Control API with bearer-token auth, scoped `read`/`deploy`/`admin` API tokens for CI and teammates, an audit trail naming who acted, and SQLite metadata through Node's built-in driver.
- Nodes join over SSH (`node-install`) or enroll themselves with a single `docker run` (`node-enroll`), with a per-node certificate for the one mTLS port control listens on. Agents only dial out, so nodes behind NAT work.
- Agents pull desired state from control, reconcile containers through the Docker Engine API, run TCP/HTTP/Docker health checks and report status. An outbound WebSocket wakes them as soon as control queues work and carries live `exec`, followed logs, `ps` and `inspect` sessions, with long-poll and periodic-poll fallbacks for ordinary work.
- `x-tug` placement of services and volumes on nodes, with immutable desired-state records per deployment.
- Build application images on control from uploaded source, or locally with `deploy --build-local`. Agents download saved images directly from control. Published images are pinned to registry digests at deployment creation.
- Secrets encrypted at rest, released only to the nodes whose services reference them, with targeted service recreation when only a secret changes.
- Deployment convergence, per-project operation locks, cancellation, rollback, per-service rollout events and log fetching through the agents.
- Opt-in zero-downtime rolling rollouts for ingress-fronted services (`x-tug.rollout`) and automatic rollback of failed deployments (`x-tug.rollback: auto`). See [Compose extensions](docs/compose.md#rolling-rollouts).
- Private published images use encrypted project credentials for digest resolution and Engine API pulls.
- Optional WireGuard mesh between nodes, health-aware cross-node service names and a managed Caddy ingress with automatic HTTPS, each opt-in. See [Networking](docs/networking.md).
- Private-by-default published ports: generated Compose binds them to the overlay IP, loopback or the node address, never every interface unless you write `0.0.0.0`. See [Networking](docs/networking.md#published-ports-private-by-default).
- Control-plane backup and restore, and `tug doctor` diagnostics.

## How it fits together

```text
  tug CLI / CI (API token)
       |
       |  HTTPS: deploy, status, logs, exec
       v
+-------------------------------------+
| Control plane                       |
|   Control API (role-checked)        |
|   SQLite: desired states, secrets   |
|   image builds, saved images        |
+-------------------------------------+
       ^                       ^
       |  agents dial out: work, status,
       |  WebSocket wake and live sessions
       |                       |
+------+------------+   +------+------------------+
| Node app1         |   | Node app2 (ingress node)|
|   Agent           |<->|   Agent                 |
|   Docker Compose  |   |   Docker Compose        |
|   services        |   |   services              |
|                   |   |   managed Caddy ingress |
+-------------------+   +-------------------------+
        <-> optional WireGuard mesh between nodes

  SSH is used only by the CLI to install the control plane and nodes.
```

Operators and CI talk to the control API. The control plane stores desired state and builds images; each agent dials out to fetch the work for its node, applies it with Docker Compose and reports health back, so nodes behind NAT need no inbound ports. SSH is used only to install control and agents. The optional WireGuard mesh and Caddy ingress are described in [Networking](docs/networking.md), and every flow in detail in [Architecture](docs/architecture.md).

## Quick start

Install the CLI (Node >= 22.18), or run it without installing through `npx @wpelevator/tug`:

```bash
npm install -g @wpelevator/tug
```

The CLI installs the matching `ghcr.io/wpelevator/tug:<version>` image on your hosts.

1. Install the control plane: `tug control-install root@control.example.com --install-docker`. The flag installs missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts; omit it when Docker is ready. Put HTTPS in front of the control API as described in [Control plane](docs/control-plane.md).
2. Point the CLI at it: `tug init tug-root.credential.json` (the file `control-install` wrote). It writes `tug.yml` (commit it, and list your servers in it), copies the credential to a `0600` file in `~/.config/tug/credentials/` and points the git-ignored `tug.local.yml` at it; see [CLI reference](docs/cli.md#config-file).
3. Set the secrets your services need: `tug secret-set DB_PASSWORD`.
4. Add nodes with `tug node-install root@app1.example.com --name app1 --install-docker`, or `tug node-enroll --name app1` and run the printed Docker command. For a bare cloud host, `tug node-enroll --name app1 --install-docker` prints cloud-init user-data.
5. Deploy: `tug deploy -f docker-compose.yml`. It waits until every node reports the new version healthy.
6. Operate with `tug status`, `events`, `exec`, `run`, `logs`, `ps`, `inspect`, `restart`, `rollback`, `backup-run`, `restore` and `doctor`.

## Documentation

- [Terminology](docs/terminology.md): core concepts, naming review, industry comparisons and proposed interface improvements.
- [Architecture](docs/architecture.md): components, reconciliation, workflow diagrams, secrets and runtime paths.
- [Compose extensions](docs/compose.md): `x-tug` placement, health checks, volumes and limitations.
- [Control plane](docs/control-plane.md): install, TLS, image delivery, backup and restore.
- [Backups](docs/backups.md): scheduled restic backups with `x-tug.backup`, restore, recipes for common databases, and a restore drill. See also the [WordPress example](examples/wordpress/README.md).
- [Access control](docs/access-control.md): scoped API tokens, roles, audit trail and a GitHub Actions deploy example.
- [Security](docs/security.md): deployment trust boundaries, security audit findings and validation limits.
- [Networking](docs/networking.md): WireGuard mesh, service DNS, ingress and TLS, firewall notes.
- [Nodes](docs/nodes.md): SSH install, self-service enrollment, registration and status.
- [CLI reference](docs/cli.md): every `tug` command and option.
- [Configuration](docs/configuration.md): CLI, control and agent environment variables.
- [Development](docs/development.md): local setup, CI, Compose stack, host mode and the integration test.
- [Testing](docs/testing.md): test layers, rollout metrics, mocked test backlog, and the [Caddy/PHP and static-file benchmark](docs/testing.md#caddy-proxy-overhead-benchmark).
- [Observability](docs/observability.md): what can be observed today, and the proposed logs, metrics and alerting.
- [Releases](docs/releases.md): changesets, npm and Docker image publishing.
- [Standalone binary](docs/standalone-binary.md): proposed Bun-compiled CLI binaries and Homebrew distribution.
- [Roadmap](docs/roadmap.md): goals, principles, the reference WordPress topology and planned milestones.

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details.
