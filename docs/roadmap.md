# Roadmap

## Goal

Make Tug as useful as [uncloud](https://github.com/psviderski/uncloud) for deploying Compose apps across a handful of VPSes, then pull ahead where its central control plane is an advantage. This is the canonical roadmap. A milestone that is being worked on gets a `plan-{task-name}.md` working file (see [AGENTS.md](../AGENTS.md)); when it lands, its lasting decisions move into the docs and its item here is checked off.

Comparison baseline: uncloud around v0.20 (WireGuard mesh, service DNS, Caddy with automatic HTTPS, rolling deploys, unregistry image push, `uc exec`/`logs`/`ps`, secrets, bare-host install over SSH, no control plane). Re-check its releases before starting each milestone, since it moves quickly.

## Positioning

Keep the single-writer control plane rather than decentralizing it like uncloud. Tug's deploy locks, ordered deployments and rollbacks, secret versions and build-then-deploy sequencing are simple and correct with one writer and hard to get right with several. The target is one control host plus a few app nodes, running containers keep serving while control is down, and control backup/restore covers recovery. If higher availability is needed later, add a warm-standby control host before considering anything multi-writer. Close the setup and operations gaps where uncloud is ahead, and invest in what a central API makes easy and a peer mesh makes hard: deploy safety, auditability, automation, and multi-operator access.

## Milestones

### M1 — TypeScript adoption (done)

Typed `src/protocol.ts` control↔agent contract and injectable agent runners, so later milestones build on typed payloads and unit-testable reconcile logic. Source and tests run as `.ts` through Node type stripping, and only the Docker image is compiled to `dist/`. See [Development](development.md) and [Architecture](architecture.md).

### M2 — Cross-node networking, DNS, ingress/TLS (done)

WireGuard mesh with control as the IP allocator and peer registry, health-aware service DNS through `extra_hosts`, and a managed Caddy ingress with `x-tug.ingress` routes and automatic TLS. Each layer is opt-in. See [Networking](networking.md). Deferred: routable container networks over the mesh (per-project subnets in `AllowedIPs`), load-balanced service names, multiple routes per service and wildcard certificates.

### M3 — Zero-downtime rolling deploys + automatic rollback

Today the agent runs `docker compose up -d`, which recreates containers in place and drops traffic during a deploy. Using the M2 ingress, roll each service as: start the new container alongside the old one, health-check it, switch the ingress upstream, drain and stop the old one. Add `x-tug.rollout` options (`strategy: rolling|recreate`, `maxSurge`, drain timeout); `recreate` stays the default for stateful services such as databases.

Automatic rollback: convergence in `control.ts` already detects a node reporting `failed` health; add an opt-in `x-tug.rollback: auto` (or a project setting) that creates the rollback desired state automatically, reusing the existing `/api/v1/rollback` path. uncloud still lists this as upcoming.

### M4 — Setup friction: images without a registry, bare-host install

Registry: a registry is only needed for services with `build:` (published images are pulled from their own source), but `control-install` requires `--registry` today. Make it optional: when no registry is configured, control keeps each built image as a compressed `docker save` file recorded in the `builds` table, and agents download it from a new agent endpoint (for example `GET /agent/v1/images/:buildId`, served only to nodes that run the service) and `docker load` it when it is missing locally, with `pull_policy: never` on those services in the generated Compose file. Bring-your-own registry stays supported for teams that already run one.

Why not an internal registry container: Docker only pulls from HTTPS registries unless every node's daemon lists the registry as insecure, and control installs over plain HTTP by default, so a Tug-run registry would need certificates or per-node daemon changes. Downloading from control reuses the agent's existing token and TLS trust, needs nothing new on the nodes, and keeps agents dial-out only, so nodes behind NAT still work.

Image files on control are kept for every version that rollback can still reach and deleted after that; agents prune old images the same way. The trade-off is that each deploy transfers the whole image with no layer reuse. If that becomes costly, a later step is for control to serve the read-only registry API from its own image store (as uncloud's unregistry does), so agents pull only missing layers.

Local builds: allow `tug deploy --build-local` to build on the operator's machine and upload the saved image to control, which stores and serves it the same way, alongside the existing remote build on control.

Bare hosts: add an opt-in Docker Engine + Compose install step to `node-install` and `control-install`, and an `--install-docker` flag on `node-enroll` that prints a cloud-init/user-data snippet, so a bare VPS becomes a working node in one step.

### M5 — Streaming channel between agent and control (day-2 operations)

`exec` and `logs -f` need a live stream, which the poll-based command queue cannot provide. Add an agent-initiated persistent connection to control (WebSocket, falling back to long-poll), keeping the property that agents only dial out so NAT'd nodes still work. On top of it build:

- `tug exec SERVICE [-- cmd]`, including interactive TTY shells
- `tug logs SERVICE -f` streaming, plus agent/daemon logs for troubleshooting
- `tug ps` and `tug inspect SERVICE` with per-container state
- faster convergence: control can push "work available" instead of waiting for the next poll

### M6 — Placement and scheduling

Multi-node projects currently require explicit `x-tug.placement.nodes` on every service, with `replicas` equal to the node count. Add node labels (set at `node-install`/`node-enroll`), placement by label (`placement.labels`), `replicas: N` spread across matching nodes, a `global: true` mode (one per matching node), and `tug scale SERVICE N`. The control plane already knows every node and its health, so scheduling stays central and simple: spread by count, no bin-packing.

### M7 — Shared volumes for the target topology

The primary use case in `plan.md` needs an NFS-backed WordPress docroot on a storage node, mounted by several app nodes. Add an `x-tug` volume type `nfs` that runs or uses an NFS export on its placement node and generates matching NFS-driver volume definitions on consuming nodes over the M2 mesh. Not distributed storage; one exporter node, documented as a single point of failure.

### M8 — Central API advantages

What a single control plane makes easy:

- scoped API tokens (deploy-only, read-only, per-project) for CI, alongside the operator token: shipped, see [Access control](access-control.md)
- `tug deploy` from CI with a documented GitHub Actions example: shipped, in [Access control](access-control.md)
- outbound webhooks for deployment state changes and failed health checks
- multiple operators with named tokens, recorded in the events audit trail: shipped, in [Access control](access-control.md)
- a minimal read-only web dashboard over the existing `/api/v1/status` and `/api/v1/events`

### Later / only if needed

- Warm-standby control plane (WAL shipping or periodic backup + promote), see [Positioning](#positioning)
- Metrics per service and node (CPU, memory, restarts) via the M5 channel
- Managed DNS convenience domain for ingress, similar to uncloud's `*.uncloud.run`

## Sequencing notes

The current priority is M3 design → M3 implementation. Real-server validation of M2 and M4 has been done on two Ubuntu 24.04 hosts (Linux 6.8): SSH installation including the Docker bootstrap, a WireGuard mesh with handshakes between hosts, an agent behind bridge NAT on a real host, a publicly trusted Let's Encrypt certificate issued by the managed Caddy, service names resolving across nodes over the mesh, a remote-build deploy, an operator-local `--build-local` deploy and rollback from the retained image. Not yet validated on real hosts: a physically separate node behind NAT, certificate renewal, `node-enroll --install-docker` cloud-init on a cloud-init host, and arm64 nodes.

M3 depends on M2's ingress and needs a design decision about reaching old and new containers concurrently: either routable container addresses over the mesh or per-version host ports with Caddy upstream switching. Today's service names depend on published host ports, so this decision belongs in the M3 spec before implementation. M4 is technically independent of M2/M3. After M3, prioritize M5's day-to-day operations; M8 can provide small independent wins, while M6/M7 primarily serve the WordPress topology. M5 should follow M1 so the stream protocol lives in `protocol.ts`. M6 is independent; M7 depends on M2.

Rough parity with uncloud after M2 + M3 + M4 + M5. M3's automatic rollback and M8 are where Tug pulls ahead.

## Checklist

- [x] M1 TypeScript adoption merged
- [x] M2 networking, DNS, ingress/TLS: WireGuard mesh, `node-rotate-wg-key`, service DNS, `x-tug.ingress`, managed Caddy with `auto`/`custom`/`off` TLS ([Networking](networking.md))
- [ ] M3 spec written (`plan-rolling-deploys.md`)
- [ ] M3 rolling deploys with ingress upstream switching
- [ ] M3 `x-tug.rollout` options, `recreate` default for stateful services
- [ ] M3 opt-in automatic rollback on failed health
- [x] M4 spec written
- [x] M4 `--registry` optional; built images stored on control and downloaded by agents, bring-your-own registry still supported
- [x] M4 image file retention tied to rollback history, and image pruning on agents
- [x] M4 `deploy --build-local` uploads the saved image to control
- [ ] M4 later, if transfer size matters: control serves the read-only registry API for layer reuse
- [x] M4 opt-in Docker install for `node-install`/`control-install`, verified on fresh Ubuntu 24.04 hosts
- [x] M4 `--install-docker` selects apt or dnf by `/etc/os-release` (unit-tested detection)
- [ ] M4 dnf bootstrap verified on real Fedora and Rocky/AlmaLinux hosts (not yet run outside detection tests)
- [ ] M4 `node-enroll --install-docker` cloud-init verified on a real cloud-init host (the output is unit-tested only)
- [ ] M5 spec written (`plan-agent-stream.md`)
- [ ] M5 agent-initiated persistent channel (WebSocket, long-poll fallback), dial-out only
- [ ] M5 `exec` (incl. TTY), `logs -f`, `ps`, `inspect`
- [ ] M6 node labels, label placement, replicas spread, `global` mode, `scale` command
- [ ] M7 `nfs` volume type for shared docroot over the mesh
- [x] M8 scoped API tokens and CI deploy example ([Access control](access-control.md))
- [ ] M8 outbound webhooks
- [x] M8 named multi-operator tokens in the audit trail
- [ ] M8 read-only web dashboard
- [ ] Re-check uncloud releases at the start of each milestone and update the baseline above
- [ ] Each milestone: tests added, README.md and docs updated, its own plan file folded into docs and deleted when done
