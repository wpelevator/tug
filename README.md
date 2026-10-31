# Tug

The name: tugboats pull ships into place, like the pull-based agents here; `tug` is the CLI.

Deploy Docker Compose projects to one or more ordinary Linux VPSes through a small self-hosted control plane and a pull-based agent on each node, without Kubernetes or a hosted PaaS. The original specification is in [plan.md](plan.md).

## Features

- Control API with bearer-token auth, scoped `read`/`deploy`/`admin` API tokens for CI and teammates, an audit trail naming who acted, and SQLite metadata.
- Nodes join over SSH (`node-install`) or enroll themselves with a single `docker run` (`node-enroll`), with per-node agent and registry tokens. Agents only dial out, so nodes behind NAT work.
- Agents pull desired state from control, apply a generated per-node Compose file, run TCP/HTTP/Docker health checks and report status. An outbound WebSocket wakes them as soon as control queues work and carries live `exec`, followed logs, `ps` and `inspect` sessions, with long-poll and periodic-poll fallbacks for ordinary work.
- `x-tug` placement of services and volumes on nodes, with immutable desired-state records per deployment.
- Build application images on control from uploaded source, or locally with `deploy --build-local`. Agents download saved images directly from control by default; a bring-your-own registry is optional.
- Secrets encrypted at rest, released only to the nodes whose services reference them, with targeted service recreation when only a secret changes.
- Deployment convergence, per-project operation locks, cancellation, rollback, per-service rollout events and log fetching through the agents.
- Opt-in zero-downtime rolling rollouts for ingress-fronted services (`x-tug.rollout`) and automatic rollback of failed deployments (`x-tug.rollback: auto`). See [Compose extensions](docs/compose.md#rolling-rollouts).
- Per-node registry pull tokens enforced by an htpasswd-backed registry you provide, with rotation and revocation.
- Optional WireGuard mesh between nodes, health-aware cross-node service names and a managed Caddy ingress with automatic HTTPS, each opt-in. See [Networking](docs/networking.md).
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
|   registry (optional)               |
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
2. Point the CLI at it: `tug init --control-url https://control.example.com --token "$TUG_TOKEN"`.
3. Set the secrets your services need: `tug secret-set DB_PASSWORD`.
4. Add nodes with `tug node-install root@app1.example.com --name app1 --install-docker`, or `tug node-enroll --name app1` and run the printed Docker command. For a bare cloud host, `tug node-enroll --name app1 --install-docker` prints cloud-init user-data.
5. Deploy: `tug deploy -f docker-compose.yml`. It waits until every node reports the new version healthy.
6. Operate with `tug status`, `events`, `exec`, `logs`, `ps`, `inspect`, `restart`, `rollback` and `doctor`.

## Documentation

- [Architecture](docs/architecture.md): components, reconciliation, workflow diagrams, secrets and runtime paths.
- [Compose extensions](docs/compose.md): `x-tug` placement, health checks, volumes and limitations.
- [Control plane](docs/control-plane.md): install, TLS, registry credentials, backup and restore.
- [Access control](docs/access-control.md): scoped API tokens, roles, audit trail and a GitHub Actions deploy example.
- [Networking](docs/networking.md): WireGuard mesh, service DNS, ingress and TLS, firewall notes.
- [Nodes](docs/nodes.md): SSH install, self-service enrollment, registration and status.
- [CLI reference](docs/cli.md): every `tug` command and option.
- [Configuration](docs/configuration.md): CLI, control and agent environment variables.
- [Development](docs/development.md): local setup, CI, Compose stack, host mode and the integration test.
- [Testing](docs/testing.md): test layers, the numbers rollouts are held to, and the backlog of mocked tests.
- [Observability](docs/observability.md): what can be observed today, and the proposed logs, metrics and alerting.
- [Releases](docs/releases.md): changesets, npm and Docker image publishing.
- [Standalone binary](docs/standalone-binary.md): proposed Bun-compiled CLI binaries and Homebrew distribution.
- [Roadmap](docs/roadmap.md): planned milestones toward parity with and beyond uncloud.

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details.
