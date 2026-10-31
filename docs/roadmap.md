# Roadmap

## Goal

Make Launchpad as useful as [uncloud](https://github.com/psviderski/uncloud) for deploying Compose apps across a handful of VPSes, then pull ahead where its central control plane is an advantage. This is the canonical roadmap. A milestone that is being worked on gets a `plan-{task-name}.md` working file (see [AGENTS.md](../AGENTS.md)); when it lands, its lasting decisions move into the docs and its item here is checked off.

Comparison baseline: uncloud around v0.20 (WireGuard mesh, service DNS, Caddy with automatic HTTPS, rolling deploys, unregistry image push, `uc exec`/`logs`/`ps`, secrets, bare-host install over SSH, no control plane). Re-check its releases before starting each milestone, since it moves quickly.

## Positioning

Keep the single-writer control plane rather than decentralizing it like uncloud. Launchpad's deploy locks, ordered deployments and rollbacks, secret versions and build-then-deploy sequencing are simple and correct with one writer and hard to get right with several. The target is one control host plus a few app nodes, running containers keep serving while control is down, and control backup/restore covers recovery. If higher availability is needed later, add a warm-standby control host before considering anything multi-writer. Close the setup and operations gaps where uncloud is ahead, and invest in what a central API makes easy and a peer mesh makes hard: deploy safety, auditability, automation, and multi-operator access.

## Milestones

### M1 — TypeScript adoption (done)

Typed `src/protocol.ts` control↔agent contract and injectable agent runners, so later milestones build on typed payloads and unit-testable reconcile logic. Source and tests run as `.ts` through Node type stripping, and only the Docker image is compiled to `dist/`. See [Development](development.md) and [Architecture](architecture.md).

### M2 — Cross-node networking, DNS, ingress/TLS

WireGuard mesh with control as the IP allocator and peer registry, health-aware service DNS, and a managed Caddy ingress with `x-launchpad.ingress` routes and automatic TLS. Working plan: `plan-networking-ingress.md` (local, not committed).

### M3 — Zero-downtime rolling deploys + automatic rollback

Today the agent runs `docker compose up -d`, which recreates containers in place and drops traffic during a deploy. Using the M2 ingress, roll each service as: start the new container alongside the old one, health-check it, switch the ingress upstream, drain and stop the old one. Add `x-launchpad.rollout` options (`strategy: rolling|recreate`, `maxSurge`, drain timeout); `recreate` stays the default for stateful services such as databases.

Automatic rollback: convergence in `control.ts` already detects a node reporting `failed` health; add an opt-in `x-launchpad.rollback: auto` (or a project setting) that creates the rollback desired state automatically, reusing the existing `/api/v1/rollback` path. uncloud still lists this as upcoming, so it is a differentiator.

### M4 — Setup friction: images without a registry, bare-host install

Registry: `--registry` is mandatory today. Make it optional by having `control install` run an internal registry by default (control already runs Docker and manages htpasswd per-node tokens), keeping bring-your-own as an option. Later, consider agent-to-agent image streaming over the mesh, matching uncloud's unregistry.

Local builds: allow `launchpad deploy --build-local` to build on the operator's machine and push to the control registry, alongside the existing remote build on control.

Bare hosts: add an opt-in Docker Engine + Compose install step to `node install` and `control install`, and an `--install-docker` flag on `node enroll` that prints a cloud-init/user-data snippet, so a bare VPS becomes a working node in one step.

### M5 — Streaming channel between agent and control (day-2 operations)

`exec` and `logs -f` need a live stream, which the poll-based command queue cannot provide. Add an agent-initiated persistent connection to control (WebSocket, falling back to long-poll), keeping the property that agents only dial out so NAT'd nodes still work. On top of it build:

- `launchpad exec SERVICE [-- cmd]`, including interactive TTY shells
- `launchpad logs SERVICE -f` streaming, plus agent/daemon logs for troubleshooting
- `launchpad ps` and `launchpad inspect SERVICE` with per-container state
- faster convergence: control can push "work available" instead of waiting for the next poll

### M6 — Placement and scheduling

Multi-node projects currently require explicit `x-launchpad.placement.nodes` on every service, with `replicas` equal to the node count. Add node labels (set at `node install`/`node enroll`), placement by label (`placement.labels`), `replicas: N` spread across matching nodes, a `global: true` mode (one per matching node), and `launchpad scale SERVICE N`. The control plane already knows every node and its health, so scheduling stays central and simple: spread by count, no bin-packing.

### M7 — Shared volumes for the target topology

The primary use case in `plan.md` needs an NFS-backed WordPress docroot on a storage node, mounted by several app nodes. Add a first-class `x-launchpad` volume type `nfs` that runs or uses an NFS export on its placement node and generates matching NFS-driver volume definitions on consuming nodes over the M2 mesh. Not distributed storage; one exporter node, documented as a single point of failure.

### M8 — Central API advantages

What a single control plane makes easy:

- scoped API tokens (deploy-only, read-only, per-project) for CI, replacing the single operator token
- `launchpad deploy` from CI with a documented GitHub Actions example
- outbound webhooks for deployment state changes and failed health checks
- multiple operators with named tokens, recorded in the events audit trail
- a minimal read-only web dashboard over the existing `/api/v1/status` and `/api/v1/events`

### Later / only if needed

- Warm-standby control plane (WAL shipping or periodic backup + promote), see [Positioning](#positioning)
- Metrics per service and node (CPU, memory, restarts) via the M5 channel
- Managed DNS convenience domain for ingress, similar to uncloud's `*.uncloud.run`

## Sequencing notes

M1 → M2 are already sequenced as chained sessions. M3 depends on M2's ingress. M4 is independent of M2/M3 and can run in parallel once M1 lands. M5 is independent of M2 but should follow M1 so the stream protocol lives in `protocol.ts`. M6 is independent; M7 depends on M2. M8 is independent and can start any time after M1.

Rough parity with uncloud after M2 + M3 + M4 + M5. M3's automatic rollback and M8 are where Launchpad pulls ahead.

## Checklist

- [ ] M1 TypeScript adoption merged (`plan-typescript-adoption.md`)
- [ ] M2 networking, DNS, ingress/TLS merged (`plan-networking-ingress.md`)
- [ ] M3 spec written (`plan-rolling-deploys.md`)
- [ ] M3 rolling deploys with ingress upstream switching
- [ ] M3 `x-launchpad.rollout` options, `recreate` default for stateful services
- [ ] M3 opt-in automatic rollback on failed health
- [ ] M4 internal registry by default in `control install`, bring-your-own still supported
- [ ] M4 `deploy --build-local` push to control registry
- [ ] M4 opt-in Docker install for `node install`/`control install` and `node enroll --install-docker` cloud-init
- [ ] M5 spec written (`plan-agent-stream.md`)
- [ ] M5 agent-initiated persistent channel (WebSocket, long-poll fallback), dial-out only
- [ ] M5 `exec` (incl. TTY), `logs -f`, `ps`, `inspect`
- [ ] M6 node labels, label placement, replicas spread, `global` mode, `scale` command
- [ ] M7 `nfs` volume type for shared docroot over the mesh
- [ ] M8 scoped API tokens and CI deploy example
- [ ] M8 outbound webhooks
- [ ] M8 named multi-operator tokens in the audit trail
- [ ] M8 read-only web dashboard
- [ ] Re-check uncloud releases at the start of each milestone and update the baseline above
- [ ] Each milestone: tests added, README.md and docs updated, its own plan file folded into docs and deleted when done
