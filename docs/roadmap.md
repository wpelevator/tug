# Roadmap

This is the canonical statement of what Tug is for, the shape of deployment it targets, and the milestones that get it there. A milestone that is being worked on gets a `plan-{task-name}.md` working file (see [AGENTS.md](../AGENTS.md)); when it lands, its lasting decisions move into the docs and its item here is checked off.

## Goal

Run a few Docker Compose applications, WordPress sites first, across a handful of ordinary Linux VPSes from one small self-hosted control plane, without Kubernetes, a hosted PaaS or a cloud provider's API.

The operator this is for runs one to a few dozen sites on two to ten VPSes, deploys from a laptop or CI, and needs the day-2 jobs covered as well as the deploy: backups and restores, one-off commands such as `wp` CLI and database upgrades, logs, safe rollouts and rollbacks, and an audit of who changed what. Feature parity with other tools is not the goal; [uncloud](https://github.com/psviderski/uncloud) and Kamal are useful baselines for what operators expect (see [Positioning](#positioning)).

## Principles

1. **Compose stays the app format.** `docker compose up` works locally; `x-tug` adds deployment metadata, and Compose features that cannot work across nodes are rejected rather than half-supported ([Compose extensions](compose.md#not-supported)). Compose is the input, not the node runtime: nodes need only the Docker Engine ([M14](#m14--engine-api-agent)).
2. **Production runs immutable images.** Application code, including WordPress core, themes and plugins, ships inside an image built on control or on the operator's machine. Every image a deployment uses is pinned to a digest when the deployment is created ([M13](#m13--pinned-images-and-one-delivery-path-done)). Nothing is built or synced into a running node during reconciliation, so rollback is switching image references and always restores exactly what ran.
3. **Agents reconcile desired state and only dial out.** Normal deploys need no SSH and no inbound port on nodes, so nodes behind NAT or a deny-all firewall work. Running containers keep serving while control is down.
4. **One writer.** Desired state, locks, secrets and history live in one control plane. This keeps ordering, rollback and audit simple; availability comes from control backups and, if needed later, a warm standby.
5. **Stateful things are pinned and backed up.** Databases and data volumes stay on their placement node unless the operator moves them, are never deleted by a deploy, and every first-class stateful service has a backup and restore path.
6. **Private by default.** Nothing Tug deploys should become reachable from the internet unless it is routed through the ingress or the operator asked for it.
7. **Start simple.** No distributed storage, no autoscaling, no bin-packing scheduler, no database failover. Single points of failure are allowed when they are documented. A single node needs nothing beyond Docker, the agent and control: the mesh, the ingress and any other subsystem stay optional layers on top of that core.

Non-goals: Kubernetes compatibility, provisioning VPSes through provider APIs, autoscaling, distributed block or file storage, database HA, a multi-tenant hosted control plane.

## Reference topology

These are the shapes Tug is tested against and the ones the docs should steer people toward.

**Small: one node per site, or several sites per node.** App and database on the same node, the managed Caddy ingress on that node, data in local named volumes. This is what most WordPress sites need and what was validated first ([Real-host evaluation](real-host-evaluation.md)). Many sites per node is the common case, so per-project isolation, ingress routing for many hostnames and per-site backups matter more than multi-node features.

**Scaled WordPress:**

```text
Internet -> ingress node (managed Caddy, TLS)
              | HTTP, over the mesh
              v
         app1, app2, app3: nginx + php-fpm, image with core/themes/plugins
              | uploads             | SQL / cache
              v                     v
         uploads store         db node (MariaDB), cache (Memcached)
         (S3-compatible or a file server you run, wp-content/uploads only)
```

- WordPress code is in the image (Bedrock or Composer style), so every app node runs exactly the deployed version and a rolling rollout or rollback swaps images atomically per node.
- Only `wp-content/uploads` is shared: preferably on S3-compatible object storage through an offload plugin, otherwise on a file server you run and mount with plain Compose `driver_opts`. PHP code is never served from a network file system, which avoids opcache stat latency, mixed versions during a sync and non-atomic rollbacks.
- Each app node serves its own static files with nginx next to php-fpm, and the ingress balances HTTP across app nodes. There is no FastCGI across hosts and no front node that needs the shared filesystem.
- The database, cache, uploads store and ingress are each single instances. Scaling the app tier adds PHP capacity, not availability; the docs say so, and backups are the recovery story.

The earlier specification (a front nginx speaking FastCGI to app nodes over a shared NFS docroot, with WordPress files synced to NFS on deploy) was dropped for the reasons above.

## Positioning

Keep the single-writer control plane rather than decentralizing it like uncloud. Deploy locks, ordered deployments and rollbacks, secret versions and build-then-deploy sequencing are simple and correct with one writer and hard to get right with several. Invest in what a central API makes easy and a peer mesh makes hard: deploy safety, scheduled backups with a catalog, auditability, CI automation and multi-operator access.

Alternatives considered:

- **uncloud** (decentralized, WireGuard mesh, container-routable networking, unregistry image push). Closest in spirit. Tug differs by having one control plane and agents that only dial out; it should match uncloud's networking model ([M12](#m12--container-networking-over-the-mesh)) when multi-node users need it.
- **Docker Swarm** gives an overlay network, service VIPs, rolling updates, secrets, labels and global mode out of the box, which overlaps M2, M3 and M6. It needs inbound manager and overlay ports on every node (no NAT), three managers for HA, has MTU and overlay reliability issues on VPS providers, and offers no builds, audit trail or scoped API. Not adopted; it remains the yardstick for how much Tug should build itself.
- **Kamal** pushes over SSH with no control plane. Simpler, but no reconciliation, no central audit or scoped CI tokens, and no state for scheduled jobs such as backups.

Re-check uncloud's releases at the start of each milestone; baseline rechecked on 2026-10-31: [v0.21.0](https://github.com/psviderski/uncloud/releases/tag/v0.21.0), adding shared Caddy certificate storage, systemd socket activation and runtime templates to the existing mesh, DNS and deployment features.

## Milestones

Numbers are identifiers, not order; the order is in [Sequencing](#sequencing).

### M1 — TypeScript adoption (done)

Typed `src/protocol.ts` control↔agent contract and injectable agent runners. Source and tests run as `.ts` through Node type stripping; only the Docker image is compiled to `dist/`. See [Development](development.md) and [Architecture](architecture.md).

### M2 — Cross-node networking, DNS, ingress/TLS (done)

WireGuard mesh with control as the IP allocator and peer registry, health-aware service names through `extra_hosts`, and a managed Caddy ingress with `x-tug.ingress` routes and automatic TLS, each opt-in. See [Networking](networking.md). Service names resolve to node addresses and need published host ports; [M12](#m12--container-networking-over-the-mesh) can replace that.

### M3 — Zero-downtime rolling deploys + automatic rollback (done)

Rolling rollouts for ingress-fronted services (start the new revision on its own host port, health-check it, switch the Caddy upstream, drain the old one), `x-tug.rollout` options and opt-in `x-tug.rollback: auto`. See [Architecture](architecture.md#rolling-rollouts-and-automatic-rollback) and [Compose extensions](compose.md#rolling-rollouts). The numbers it is held to are in [Testing](testing.md#metrics). Rolling services have no stable cross-node name and port; M12 can fix that.

### M4 — Images without a registry, bare-host install (done)

Control stores built images as saved image files and agents download them with their own token, so no registry or daemon change is needed. `deploy --build-local` uploads an image built on the operator's machine. `--install-docker` bootstraps Docker on apt and dnf hosts and in `node-enroll` cloud-init. See [Architecture](architecture.md#image-artifacts). Each deploy transfers the whole image; layer reuse is in [Later](#later--only-if-needed).

### M5 — Streaming channel between agent and control (mostly done)

Agent-initiated WebSocket with long-poll fallback that wakes agents when work is queued and carries live sessions: non-TTY `tug exec` with stdin, `logs -f`, `ps` and `inspect` ([Architecture](architecture.md#agent-wake-channel), [Observability](observability.md#live-commands)). Remaining, at low priority: dropping the long-poll fallback (the WebSocket plus the periodic poll cover a lost socket), agent and daemon log streams, and terminating the remote process when an exec session is cancelled. PTY allocation and resize for `exec -t` shipped with [M14](#m14--engine-api-agent) through the Engine API.

### M6 — Placement and scheduling (done)

Node labels, `placement.labels`, `replicas: N` spread across matching nodes, `global: true` and `tug scale`. Scheduling stays central and simple: spread by count, skip stale nodes, no bin-packing. See [Compose extensions](compose.md).

### M7 — Shared volumes (removed)

An `x-tug.type: nfs` volume type was built and verified on real hosts, then removed: it mounted a share but could not run the NFS server, so users still prepared the host, and installing and exporting from Tug would make it a host configuration tool. Shared storage is the operator's: S3-compatible object storage, or a file server mounted with plain Compose `driver: local` and `driver_opts` ([Volumes](compose.md#volumes)).

### M8 — Central API advantages (partly done)

Shipped: scoped API tokens (`read`, `deploy`, `admin`, per project), a GitHub Actions deploy example and named operator tokens in the audit trail ([Access control](access-control.md)). Remaining: outbound webhooks for deployment state changes, failed health checks and backup results (shared with M9 alerting). The read-only web dashboard is dropped to [Later](#later--only-if-needed): `tug status`, `/metrics` and webhooks cover the need.

### M9 — Observability

Make behavior visible without adding required services: event hygiene (done), structured logs, a Prometheus `/metrics` endpoint on control that also carries node and service stats reported by agents (Prometheus cannot scrape nodes behind NAT, which is why agents report through control), a readiness endpoint, sample alert rules and webhooks. Design and status are in [Observability](observability.md). Keep agent-reported stats small; point operators who want depth at cAdvisor or node_exporter deployed as ordinary services.

### M10 — Private-by-default port exposure (done)

A published port such as `3306:3306` listened on every interface of the node, and Docker's iptables rules bypass host firewalls such as ufw, so a database published for cross-node service names was reachable from the internet. Now published ports without a host IP are bound to the node's overlay address with the mesh, to `127.0.0.1` when only the local ingress dials them, and otherwise to the node's `address` with a `ports.public` warning event when it is public; an explicit host IP (including `0.0.0.0`) is left as written, and `tug doctor --nodes` reports containers listening on a public address. See [Networking](networking.md#published-ports-private-by-default). This was a prerequisite for recommending the scaled topology.

### M11 — Backups, restores and run-once jobs

Working plan: `plan-backups.md`.

The stateful half of principle 5, and something a central control plane does better than a mesh: one schedule, one catalog, retention and restore.

- **Done: generic backups.** `x-tug.backup` marks a service or a volume. Tug has no database support of its own: a service backup is a `command` run in the running container whose output is stored (database recipes are documentation), a volume backup archives its files. Control schedules them as agent commands on the placement node; the agent streams into restic in a helper container, uploading to a destination configured on control (S3-compatible, encrypted before leaving the node), one repository per project. Retention, a catalog, `backup-run` and `backup-list`, and `backup.*` events for completed, failed, missed and stale runs. See [Backups](backups.md).
- **Done: restore.** `tug restore` locks the project, stops the services that write to the target, takes a safety backup, restores through the service's own `restore` command or the volume's files, and starts them again; an interrupted restore keeps the writers stopped until resumed or released. A scratch restore of a volume touches nothing live.
- **Done: `tug run`.** `tug run SERVICE -- cmd` runs a one-off container with the service's image, environment, secrets, network and mounts, returns the exit code and is audited.
- Not done: `x-tug.release` (a command that runs once per deployment before or after rollout, recorded on the deployment, a failure stopping the rollout), SFTP and postgres-free extras such as a weekly `restic check`/prune, a restore drill, `destination test`, and failed or missed backups as webhooks (M8).
- Moving a stateful service to another node (`tug move SERVICE --to NODE`) as backup, stop, restore and re-place, since the pieces are the same.

### M12 — Container networking over the mesh

Optional, and not on the critical path. The reference topology already works with M10's mesh-bound published ports; this milestone removes two real annoyances: rolling services have no stable cross-node name and port, and an endpoint change recreates client containers through `extra_hosts`. Start it when a multi-node user hits them.

- The mesh stays opt-in, and a single node is never affected. Without the mesh, today's node-address names and port binding stay as they are. Two nodes behind NAT cannot reach each other over WireGuard, so making the mesh mandatory would break principle 3 for multi-node setups.
- Each node gets a fixed container subnet from control (for example a `/24` out of a mesh-wide `/16`); the agent creates the project networks inside it and adds the other nodes' subnets to their WireGuard `AllowedIPs`, with the forwarding rules this needs.
- A small DNS resolver per node, fed by control's endpoint list, answers `service` and `service.project.tug` with the IPs of healthy containers and forwards everything else; containers use it instead of `extra_hosts`.
- Rolling revisions become reachable by container IP on the declared port, so per-revision host ports (`TUG_ROLLOUT_PORTS`) go away for meshed projects and the ingress dials containers directly.
- A node option may carry WireGuard over an existing private network by using the node's private `address` as its peer endpoint; traffic stays encrypted.

Prerequisites: [M14](#m14--engine-api-agent), and a decision on the agent's form. Running WireGuard, forwarding rules, a resolver and a host-bound endpoint from a container needs host networking and broad capabilities, which is the host-level helper in [Later](#later--only-if-needed). It gets its own spec before implementation: MTU, IPv6, forwarding rules, resolver placement, how an existing project's networks are recreated, and how rollouts stay zero-downtime.

### M13 — Pinned images and one delivery path (done)

Make rollback restore exactly what ran, and leave one way for images to reach a node.

- **Digest pinning.** Control resolves each distinct published image tag once per deployment and stores `image@sha256:…` in desired state and canonical Compose before publication. Explicit pins need no lookup. Multi-platform indexes stay intact. Resolution failure leaves current desired state unchanged; rollback and scaling reuse stored pins. Nodes pull by digest from upstream. Private HTTPS registries use the encrypted project secret `TUG_REGISTRY_AUTH` and Engine API authentication, released only to assigned services. See [Control plane](control-plane.md#published-images-and-private-registries).
- **One built-image delivery path.** Remote and local builds always travel as retained saved archives from control. Built-image registry configuration, `--no-build-upload`, registry pull tokens and their rotate/revoke commands, registry auth hooks and node `docker login` are removed. Each node has one agent credential. CI-built images can be pushed independently and deployed through `image:`.

Each deploy still transfers whole Tug-built images; a control-hosted image store, mirroring of published images and layer reuse are in [Later](#later--only-if-needed) until image size hurts.

### M14 — Engine API agent

The agent stops running the `docker compose` CLI and reconciles containers through the Docker Engine API. The agent already works around Compose: rolling revisions are separate Compose projects with hand-made networks and volumes carrying copied Compose labels, `depends_on` is stripped across them, and secret changes need forced recreates.

- The CLI normalizes the Compose file with `docker compose config` (Compose does interpolation, `extends`, profiles and `env_file`; secret variables are left as sentinels for the agent to substitute) and sends the canonical definition (read from Compose's YAML rendering, since its JSON rendering drops `x-tug`); control validates an explicit allowlist of supported keys, including resource limits; agents never parse Compose YAML. Nodes need only the Docker Engine, not the Compose plugin. The control host keeps using Compose for its own install unless that moves to `docker run`.
- One reconciler for every service: containers carry `tug.*` labels with a hash of their resolved configuration, including the image reference and the versions of the secrets they use, and are recreated when it changes. `recreate` and `rolling` become two strategies of the same loop. Tug names its own networks, volumes and containers; service names are network aliases.
- Secrets are substituted into the container environment by the agent; no `.env` file on disk. Health checks stay agent-run, because images often lack the tools a Docker `HEALTHCHECK` would need.
- `exec -t` with a real PTY and resize, and `logs`, `ps` and `inspect` from the API instead of CLI output.

### M15 — Flexible node roles

- **Control on a runtime node.** Installing control and a node on the same host is supported, so a small setup needs no dedicated control VPS. Control's API is then served through the node's managed Caddy, since both need ports 80 and 443. Keep a direct control port bound to loopback or the mesh as break-glass access, so a broken ingress or agent never locks out the fix path.
- **Builder nodes.** Builds run on a node labelled `builder`: control queues a build command, the agent downloads the source context from control, builds it and uploads the saved image to control the way `deploy --build-local` does. Without a builder node, control builds, as today. This keeps untrusted Dockerfile builds and their CPU and memory use off the host that holds the secrets database.

## Later / only if needed

- Warm-standby control plane (WAL shipping or periodic backup plus promote), see [Positioning](#positioning).
- A host-level agent helper or standalone agent binary, for work a container should not do: host mounts and WireGuard outside Docker. Shares the build with the standalone CLI binary ([Standalone binary](standalone-binary.md)). Decide this before M12.
- A control-hosted OCI image store, mirroring of published images and an agent-local registry endpoint for layer reuse, once whole-image transfers or upstream rate limits hurt. Mirroring is opt-in; it makes control a bandwidth and disk bottleneck and a dependency for every pull.
- A mandatory mesh with no non-mesh fallback, if the maintenance cost of two networking paths outweighs losing NAT-friendly multi-node setups.
- Standalone Bun-compiled `tug` binaries and a Homebrew tap, so operators need no Node.js.
- A minimal read-only web dashboard over `/api/v1/status` and `/api/v1/events`.
- Load-balanced service names and multiple routes per service, wildcard certificates.
- Managed DNS convenience domain for ingress, similar to uncloud's `*.uncloud.run`.

## Sequencing

Current priority order:

1. M14 Engine API agent: removes the Compose workarounds, and makes M11's `tug run` a one-off container create.
2. M11 backups and run-once jobs: the main gap for the target operator.
3. M15 flexible node roles.
4. M9 metrics and M8/M9 webhooks.
5. Remaining M5 items (long-poll removal, agent and daemon log streams, process termination).
6. M12 container networking, when multi-node users need stable names for rolling services.

M10 (private-by-default ports) is done.

Dependencies: M10 builds on M2. M11 uses the M5 command channel for job output and M8 webhooks for alerts but needs neither to start. M13 is independent of M14, and M14's config hash uses the pinned image references. M12 depends on M2 and M14, needs the agent-form decision, and changes M3's rollout mechanics, so its spec must keep rollouts zero-downtime. M15's control-on-a-node needs the managed Caddy from M2.

The reference topology also needs a validated example: a scaled WordPress project with code in the image and uploads on S3-compatible storage or a file server the operator runs, deployed on real hosts once M11 lands (M10 is done).

Validation so far: [real-host runs](real-host-evaluation.md) on two Ubuntu 24.04 hosts covered SSH install with the Docker bootstrap, the WireGuard mesh, an agent behind bridge NAT, a publicly trusted Let's Encrypt certificate from the managed Caddy, cross-node service names, remote and `--build-local` deploys, rollback from a retained image, a rolling rollout through the public ingress with no failed requests (over 2,200 sampled), a failing version rejected while the old revision kept serving, automatic rollback, and on freshly wiped hosts label placement, `global`, `tug scale`, `ps`/`inspect`/`exec`/`logs -f` and a cloud-init enrolled node behind a deny-all-inbound firewall ([M6, M7 and enrollment](real-host-evaluation.md#m6-m7-and-enrollment-on-fresh-hosts)). Not yet validated on real hosts: a node behind real NAT, certificate renewal, arm64 nodes and dnf-based hosts.

The test layers, the metrics milestones are held to and the backlog of mocked tests are in [Testing](testing.md).

## Checklist

- [x] M1 TypeScript adoption merged
- [x] M2 networking, DNS, ingress/TLS: WireGuard mesh, `node-rotate-wg-key`, service DNS, `x-tug.ingress`, managed Caddy with `auto`/`custom`/`off` TLS ([Networking](networking.md))
- [x] M3 rolling deploys with ingress upstream switching, `x-tug.rollout` (`strategy`, `drain`; `maxSurge` not implemented), opt-in automatic rollback, run on real hosts through the public ingress
- [x] M4 images stored on control, retention tied to rollback history, agent image pruning, `deploy --build-local`; M13 makes this the only built-image delivery path
- [x] M4 opt-in Docker install for `node-install`/`control-install` (verified on Ubuntu 24.04) and `node-enroll --install-docker` cloud-init (verified on a cloud-init host)
- [ ] M4 dnf bootstrap verified on real Fedora and Rocky/AlmaLinux hosts
- [x] M5 wake channel, faster convergence, non-TTY `exec` with stdin, `logs -f`, `ps`, `inspect`
- [ ] M5 agent/daemon log streams
- [ ] M5 long-poll wake fallback removed; WebSocket plus periodic poll
- [ ] M5 remote process termination when an exec session is cancelled or disconnected
- [x] M6 node labels, label placement, replicas spread, `global` mode, `scale` command, verified on real hosts
- [x] M7 `nfs` volume type, removed: shared storage is the operator's (S3-compatible storage or `driver_opts`)
- [x] M8 scoped API tokens, CI deploy example, named operator tokens in the audit trail ([Access control](access-control.md))
- [ ] M8 outbound webhooks
- [x] M9 event hygiene ([Architecture](architecture.md#events)) and observability design ([Observability](observability.md))
- [ ] M9 structured logs (`TUG_LOG_FORMAT`, `TUG_LOG_LEVEL`)
- [ ] M9 `GET /metrics` on control (Prometheus text, `read` token), with agent-reported node and service stats
- [ ] M9 `/readyz`, sample alert rules, and the metrics documentation test gate
- [x] M10 published ports bound to the overlay, loopback or node address by default; `doctor` reports public listeners
- [x] M11 spec written
- [x] M11 `x-tug.backup` (generic: a command in a service, or a volume's files), scheduled backups to S3-compatible storage with restic, catalog, `backup-run`, `backup-list`, `restore` (verified against real Docker; not yet on real hosts or a real bucket)
- [x] M11 `tug run` one-off containers
- [ ] M11 `x-tug.release` run-once hooks
- [ ] M11 weekly maintenance (`restic check`, prune), restore drill, `backup-destination-test`, SFTP
- [x] M11 `restore` waits for the restored writers to be serving again (five minutes, then it finishes with a warning)
- [ ] M11 list and remove scratch-restore volumes, and expire safety snapshots (they accumulate for ever and only `restic forget` removes them)
- [x] M11 `backup-list --check`: exit nonzero when any target is stale, failed or missed, as an interim for cron and monitors until webhooks (M8) exist
- [x] M11 `memory` under `x-tug.backup` for the restic helper's memory limit
- [x] A failed health check says when the agent runs outside a container (`doctor` does not check it separately)
- [x] `TUG_ROLE=agent` works in the runtime image: it no longer sets a default command
- [ ] A `tug run` option to start without the service's volumes (`--no-volumes`), and a decision on whether it should take the project lock
- [ ] M11 `tug move` for stateful services
- [ ] M12 spec written (subnets, resolver, rollout changes, MTU, IPv6, network recreation)
- [ ] M12 per-node container subnets over WireGuard and per-node service DNS, mesh stays opt-in
- [ ] M12 rolling services reachable by stable name and port on meshed projects; per-revision host ports removed there
- [ ] M12 WireGuard over an existing private network as a node option
- [x] M13 stopgap: published images pulled only when a deployment revision is new to the node
- [x] M13 digest pinning for every `image:` at deploy time, used by rollback
- [x] M13 bring-your-own registry, registry pull tokens and `docker login` removed; one node credential
- [x] M14 Compose normalized on the operator machine; allowlist validation on control
- [x] M14 Engine API reconciler with config-hash recreation, `recreate` and `rolling` strategies, no `.env` on disk
- [x] M14 `exec -t` with PTY and resize; `logs`, `ps`, `inspect` and ingress on the Engine API
- [x] M14 Compose plugin no longer required on nodes
- [ ] M15 control on a runtime node behind the managed Caddy, with a break-glass control port
- [ ] M15 builds on `builder`-labelled nodes, uploaded to control as saved images
- [ ] Scaled WordPress reference example (code in image, shared uploads) validated on real hosts
- [ ] Mocked tests from the [Testing](testing.md#backlog-of-mocked-tests-proposed) backlog: revisions started per deployment, WireGuard key re-report, old-schema database, preflight remedies
- [x] M13 uncloud release baseline rechecked and updated in [Positioning](#positioning); repeat at the start of each milestone
- [ ] Each milestone: tests added, README.md and docs updated, its own plan file folded into docs and deleted when done
