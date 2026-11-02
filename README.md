# Tug

The name: tugboats pull ships into place, like the pull-based agents here; `tug` is the CLI.

Deploy Docker Compose applications to one or more ordinary Linux VPSes through a small self-hosted control plane and a pull-based agent on each node, without Kubernetes or a hosted PaaS. Tug runs an agent on each node; the agents drive the node's Docker Engine API directly, and Compose is only used on your machine to read the file. What it is for, the deployment shapes it targets and the planned milestones are in the [Roadmap](docs/roadmap.md).

## Features

- One mutual-TLS port: every operator, CI job and node authenticates with a certificate from the control plane's private CA, and control authorizes it by public key. Scoped `read`/`deploy`/`admin` operator credentials for CI and teammates, an audit trail naming who acted, and SQLite metadata through Node's built-in driver.
- Nodes join over SSH (`node-install`) or enroll themselves with a single `docker run` after `node-prepare-enrollment`, each with its own certificate and an immutable node ID. Agents only dial out, so nodes behind NAT work.
- Agents pull desired state from control, reconcile containers through the Docker Engine API, run TCP/HTTP/Docker health checks and report status. An outbound WebSocket wakes them as soon as control queues work and carries live `exec`, followed logs, `ps` and `inspect` sessions, with long-poll and periodic-poll fallbacks for ordinary work.
- `x-tug` placement of services and volumes on nodes, with immutable desired-state records per deployment.
- Build application images on control from uploaded source, or locally with `deploy --build-local`. Agents download saved images directly from control. Published images are pinned to registry digests at deployment creation.
- Secrets encrypted at rest, released only to the nodes whose services reference them, with targeted service recreation when only a secret changes.
- Deployment convergence, per-project operation locks, cancellation, rollback, per-service rollout events and log fetching through the agents.
- Opt-in zero-downtime rolling rollouts for ingress-fronted services (`x-tug.rollout`) and automatic rollback of failed deployments (`x-tug.rollback: auto`). See [Compose extensions](docs/compose.md#rolling-rollouts).
- Private published images use encrypted project credentials for digest resolution and Engine API pulls.
- Health-aware cross-node service names (hosts-file entries injected into containers), on by default with a `TUG_SERVICE_NAMES=false` opt-out, and an optional managed Caddy ingress with automatic HTTPS. Both use each node's private `address` on your existing network. See [Networking](docs/networking.md).
- Private-by-default published ports: agent-generated container definitions bind them to the node address or loopback, never every interface unless you write `0.0.0.0`. Tug does not encrypt node-to-node workload traffic; your network owns reachability, firewalling and encryption. See [Networking](docs/networking.md#published-ports-private-by-default).
- Workload backups of service commands and volumes with restic, a separate control-plane backup and restore, and `tug doctor` diagnostics for certificate expiry, node connectivity and clock skew.

## How it fits together

```text
  tug CLI / CI (operator credential)
       |
       |  mTLS: deploy, status, logs, exec
       v
+-------------------------------------+
| Control plane (one mTLS port)       |
|   Control API (role-checked)        |
|   SQLite: desired states, secrets   |
|   private CA, image builds          |
+-------------------------------------+
       ^                       ^
       |  agents dial out: work, status,
       |  WebSocket wake and live sessions
       |                       |
+------+------------+   +------+------------------+
| Node app1         |   | Node app2 (ingress node)|
|   Agent           |   |   Agent                 |
|   Docker Engine   |   |   Docker Engine         |
|   services        |   |   services              |
|                   |   |   managed Caddy ingress |
+-------------------+   +-------------------------+
        \_________________________/
          workload traffic between node addresses
          over the operator's private network

  SSH is used only by the CLI to install the control plane and nodes.
```

Operators and CI talk to the control API. The control plane stores desired state and builds images; each agent dials out to fetch the work for its node, applies it through the Docker Engine API and reports health back, so the control channel works through NAT without inbound ports. SSH is used only to install the control plane and its nodes. Cross-node service names and Caddy ingress use each node's `address` over the operator's private network; Tug provides no overlay or encryption for that workload traffic. See [Networking](docs/networking.md), and [Architecture](docs/architecture.md) for every flow in detail.

## Quick start

Install the CLI (Node >= 22.18), or run it without installing through `npx @wpelevator/tug`:

```bash
npm install -g @wpelevator/tug
tug control-install root@203.0.113.5 --install-docker
tug init tug-root.credential.json
tug node-install root@198.51.100.7 --name app1 --address 10.0.0.7 --install-docker
tug deploy -f docker-compose.yml
```

The CLI installs the matching `ghcr.io/wpelevator/tug:<version>` image on your hosts. Control serves mutual TLS directly on its port (`8443`): every operator, CI job and node authenticates with a certificate from a private CA created at install, and clients verify a name generated from that CA, so the address can be a bare IP and can change later. Do not terminate TLS in front of it.

A `controlUrl` in `tug.yml` is the one name for where control is: `control-install` advertises it, and every other command connects to it. Pass `--control-url` (or set `TUG_CONTROL_URL`) to override it for one invocation. See [CLI configuration](docs/cli.md#config-file) for precedence and per-node defaults.

The full walkthrough, including nodes you cannot SSH to (`tug node-prepare-enrollment`), CI credentials (`tug credential-create`), moving the control plane and recovery, is in [Getting started](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md): install control, add nodes, deploy, give CI a credential, move control, recover.
- [Terminology](docs/terminology.md): core concepts, the naming review (which recommendations are implemented), industry comparisons and the remaining proposed interface improvements.
- [Architecture](docs/architecture.md): components, reconciliation, workflow diagrams, secrets and runtime paths.
- [Compose extensions](docs/compose.md): `x-tug` placement, health checks, volumes and limitations.
- [Control plane](docs/control-plane.md): install, mutual TLS and the private CA, image delivery, control-plane backup and restore.
- [Backups](docs/backups.md): scheduled workload backups with `x-tug.backup` (restic), restore, recipes for common databases, and a restore drill. See also the [WordPress example](examples/wordpress/README.md).
- [Access control](docs/access-control.md): certificate identity classes, scoped operator credentials, roles, audit trail and a GitHub Actions deploy example.
- [Security](docs/security.md): deployment trust boundaries, security audit findings and validation limits.
- [Networking](docs/networking.md): bring-your-own private networking, cross-node service names, ingress and TLS, firewall notes.
- [Nodes](docs/nodes.md): node names and IDs, SSH install, self-service enrollment, certificate renewal and recovery, registration and status.
- [CLI reference](docs/cli.md): every `tug` command and option.
- [Configuration](docs/configuration.md): CLI, control and agent environment variables.
- [Development](docs/development.md): local setup, CI, Compose stack, host mode and the integration test.
- [Testing](docs/testing.md): test layers, rollout metrics, mocked test backlog, and the [Caddy/PHP and static-file benchmark](docs/testing.md#caddy-proxy-overhead-benchmark).
- [Observability](docs/observability.md): what can be observed today, and the proposed logs, metrics and alerting.
- [Releases](docs/releases.md): changesets, npm and Docker image publishing.
- [Standalone binary](docs/standalone-binary.md): proposed Bun-compiled CLI binaries and Homebrew distribution, with the mTLS dependency findings.
- [Roadmap](docs/roadmap.md): goals, principles, the reference WordPress topology and planned milestones.

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details.
