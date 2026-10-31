# Architecture

Launchpad deploys Docker Compose projects to one or more Docker hosts through a small self-hosted control plane and a pull-based agent on each node. SSH is used only to bootstrap hosts; normal deploys go through the control API and the agents.

## Components

- **Control plane** (`src/control.ts`): an Express API backed by SQLite (`launchpad.db`) and an install-time master key (`master.key`) in `LAUNCHPAD_DATA_DIR`. It stores nodes, projects, deployments, desired states, encrypted secrets, volumes, queued commands, events and locks, and optionally builds and pushes images from uploaded source tarballs.
- **Agent** (`src/agent.ts`): runs on every node, polls `GET /agent/v1/work`, renders a per-node Compose file and `.env`, runs `docker compose pull` / `up -d`, executes health checks, runs queued commands and reports back with `POST /agent/v1/status`. Agents only dial out to control, so nodes behind NAT or firewalls work.
- **CLI** (`src/cli.ts`): the `launchpad` command for operators. It talks to the control API and uses SSH only for `control install` and `node install`. See [CLI reference](cli.md).
- **Networking** (`src/mesh.ts`, `src/ingress.ts`): optional WireGuard mesh, health-aware service endpoints and the managed Caddy edge. `mesh.ts` has overlay IP allocation, key handling, `wg` config rendering, peer diffing and the idempotent `wg0` reconcile; `ingress.ts` resolves service endpoints and ingress routes, renders the Caddyfile (control) and reconciles the Caddy container (agent). See [Networking](networking.md).
- **Registry**: bring your own. Launchpad can manage per-node pull credentials for a registry that uses an htpasswd file. See [Control plane](control-plane.md#registry).
- **Entrypoint** (`src/main.ts`, `dist/main.js` in the image): one image serves both roles; `node src/main.ts control|agent` or `LAUNCHPAD_ROLE`.
- **Protocol** (`src/protocol.ts`): the control↔agent contract. It holds the types, and a few shared constants such as the active and terminal deployment states, for everything crossing the boundary: `DesiredState`, `ServiceSpec` and `HealthCheck`; the `/agent/v1/*` payloads (`WorkResponse` with its optional `network`, `serviceEndpoints` and `ingress` blocks, `Command` / `CommandResult`, `StatusReport` / `ProjectStatus` / `IngressStatus`, `SecretsResponse`, `WgKeyRequest`); and enrollment (`EnrollRequest` / `EnrollResponse`, `RegisterResponse`, `JoinKey`). `control.ts`, `agent.ts`, `compose.ts` and `cli.ts` all import from it, so change the wire format there first.
- **Injectable agent runners** (`src/runners.ts`): `reconcile`, `executeCommand`, `waitForHealth`, `containerIp` and `pollOnce` take an `AgentContext` (`{ docker, http, nodeName, stateDir, apply, controlUrl, token, host?, mesh?, caddyImage? }`). `docker` is a `DockerRunner` (`createDockerRunner()` wraps `run('docker', …)` from `build.ts`), `host` is a `HostRunner` for `wg` and `ip` (`createHostRunner()`), and `http` is a `fetch`-compatible client. The Caddy reload goes through `docker`. Production code uses `defaultContext()`; `src/agent.test.ts` passes a fake docker runner to unit-test rollout ordering, secret-triggered `--force-recreate` and the docker, tcp and http health-check branches without a Docker daemon. The privileged-Docker integration test remains the end-to-end check.

## Desired state and reconciliation

`launchpad deploy` sends the Compose file to control, which validates `x-launchpad` placement (see [Compose extensions](compose.md)), optionally builds images for services with `build:`, and stores an immutable desired-state record for the deployment. Each agent receives the desired states that place services on its node, applies them, and reports the observed version and health per project. When every node assigned to the current deployment reports that version as `serving` (or `skipped`), the deployment becomes `succeeded`; if one reports `failed`, the deployment becomes `failed`.

Deploys, rollbacks, secret changes and data-deleting volume removals take a per-project operation lock, so concurrent operations on one project are rejected with `409`. Rollback creates a new deployment whose desired state copies the most recent earlier `succeeded` or `rolling_out` one.

Restarts, log fetches, diagnostics and volume deletions are queued as commands for the node that runs the service; the agent picks them up on its next poll and posts results back.

## Node bootstrap (`launchpad node install`)

```mermaid
sequenceDiagram
    participant Op as Operator
    participant CLI as launchpad CLI
    participant Ctrl as Control plane
    participant DB as SQLite
    participant Host as Remote host (SSH)
    participant Agent as Agent container

    Op->>CLI: node install root@host --name app1
    CLI->>Host: SSH preflight (docker, compose, paths, disk, control reachable)
    CLI->>Ctrl: POST /api/v1/nodes/register
    Ctrl->>DB: insert node, generate agentToken + registryToken
    Ctrl->>Ctrl: write htpasswd entry, restart registry container
    Ctrl-->>CLI: { node, agentToken, registryToken }
    CLI->>Host: docker save | scp | docker load (image transfer)
    CLI->>Host: ssh node-install.sh (writes /etc/launchpad/agent.env, docker login, docker run agent)
    Host->>Agent: start container
    loop every LAUNCHPAD_POLL_INTERVAL_MS
        Agent->>Ctrl: GET /agent/v1/work (Bearer agentToken)
        Ctrl->>DB: update last_seen_at, status=online
    end
    CLI-->>Op: { ok, node, registryToken }
```

## Self-service enrollment (`launchpad node enroll`)

```mermaid
sequenceDiagram
    participant Op as Operator
    participant CLI as launchpad CLI
    participant Ctrl as Control plane
    participant DB as SQLite
    participant Host as Fresh host
    participant Agent as Agent container

    Op->>CLI: node enroll --name app1
    CLI->>Ctrl: POST /api/v1/nodes/enroll-token { name, ttl, uses }
    Ctrl->>DB: insert enroll_token (hash, name, uses, expiry)
    Ctrl-->>CLI: { enrollToken, expiresAt }
    CLI-->>Op: docker run ... -e LAUNCHPAD_JOIN_KEY=<key> ... agent
    Op->>Host: paste docker run (or cloud-init)
    Host->>Agent: start container
    Agent->>Agent: no token on volume -> decode join key
    Agent->>Ctrl: POST /agent/v1/enroll (enrollToken + hostname/ip)
    Ctrl->>DB: validate & consume enroll_token, insert node, mint agentToken + registryToken
    Ctrl->>Ctrl: write htpasswd entry, restart registry container
    Ctrl-->>Agent: { node, agentToken, registryToken, registry }
    Agent->>Agent: persist creds to volume, docker login registry
    loop every LAUNCHPAD_POLL_INTERVAL_MS
        Agent->>Ctrl: GET /agent/v1/work (Bearer agentToken)
        Ctrl->>DB: update last_seen_at, status=online
    end
```

## Deploy (`launchpad deploy`)

```mermaid
sequenceDiagram
    participant Op as Operator
    participant CLI as launchpad CLI
    participant Ctrl as Control plane
    participant DB as SQLite
    participant Agent as Agent (per node)

    Op->>CLI: deploy -f docker-compose.yml
    CLI->>CLI: read & hash compose, tar build context
    CLI->>Ctrl: POST /api/v1/deployments (compose + context)
    Ctrl->>DB: lock project, insert deployment (state=building)
    Ctrl->>Ctrl: build & push images for services with build:
    Ctrl->>DB: insert desired_state, set current_deployment_id, state=rolling_out
    Ctrl-->>CLI: { deployment, desiredState }
    loop poll interval
        Agent->>Ctrl: GET /agent/v1/work
        Ctrl-->>Agent: matching desiredStates for this node
        Agent->>Agent: fetch secrets, write compose+.env, pull, up -d, health checks
        Agent->>Ctrl: POST /agent/v1/status (observedVersion, health)
        Ctrl->>DB: upsert node_statuses, check convergence
    end
    Ctrl->>DB: all nodes serving desired version -> deployment state=succeeded
    CLI->>Ctrl: GET /api/v1/deployments/:id (poll until terminal state)
    CLI-->>Op: deployment result
```

## Rollback (`launchpad rollback`)

```mermaid
sequenceDiagram
    participant Op as Operator
    participant CLI as launchpad CLI
    participant Ctrl as Control plane
    participant DB as SQLite
    participant Agent as Agent (per node)

    Op->>CLI: rollback [--force]
    CLI->>Ctrl: POST /api/v1/rollback { project, force }
    Ctrl->>DB: lock project, reject 409 if active deployment & not --force
    Ctrl->>DB: find most recent prior succeeded/rolling_out desired_state
    Ctrl->>DB: insert new deployment (version=rollback-...), insert desired_state copy, set current_deployment_id
    Ctrl-->>CLI: { deployment, desiredState: previousState }
    loop poll interval
        Agent->>Ctrl: GET /agent/v1/work
        Ctrl-->>Agent: previous desiredState
        Agent->>Agent: reconcile (pull/apply prior images, health checks)
        Agent->>Ctrl: POST /agent/v1/status (observedVersion=previousState.version)
        Ctrl->>DB: convergence check -> deployment state=succeeded
    end
    CLI-->>Op: rollback deployment result
```

## Networking

With `LAUNCHPAD_MESH=true`, `GET /agent/v1/work` also returns a `network` block (this node's overlay IP and every other node's WireGuard peer), `serviceEndpoints` (serving endpoints per service for injecting `extra_hosts`) and, for nodes marked as ingress nodes, an `ingress` block with the rendered Caddyfile. Agents report their public key with `POST /agent/v1/wireguard/key` (or `wgPublicKey` at enrollment) and ingress state in the status report. Control stores overlay IPs in `nodes.overlay_ip` and keys in `wg_peers`. See [Networking](networking.md) for the model and the mesh/ingress sequence diagram.

## Secrets

Secrets are encrypted at rest with AES-256-GCM using the control master key, and versioned per project. An agent only receives the secrets referenced by the `environment` of services placed on its node, written to the project's `.env` with mode `0600`. When only a referenced secret's version changes, the agent force-recreates just the affected services.

## Runtime paths

Agents write generated state under `LAUNCHPAD_STATE_DIR` (default `/var/lib/launchpad`):

```text
/var/lib/launchpad/agent.json                                # durable creds persisted after self-service enrollment
/var/lib/launchpad/agent.db                                  # last applied version and secret versions per project
/var/lib/launchpad/wireguard/private.key                     # mesh only: node's WireGuard private key (0600), never sent to control
/var/lib/launchpad/wireguard/wg0.conf                        # mesh only: last config passed to `wg syncconf`
/var/lib/launchpad/ingress/                                  # ingress nodes only: applied Caddy config and its hash
/var/lib/launchpad/projects/<project>/docker-compose.yml
/var/lib/launchpad/projects/<project>/.env
```

When agents enroll via `node enroll`, mount the state directory as a named volume (`-v launchpad-agent:/var/lib/launchpad`) so `agent.json` survives container recreation and the agent does not re-enroll after an image update or reboot.
