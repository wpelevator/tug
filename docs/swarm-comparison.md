# Tug compared with Docker Swarm

Assessment date: 2 November 2026. Tug baseline: package version 0.9.0, checkout `355bf61` ("Improve site recovery and deployment visibility", #58). The checkout advanced during review; the final assessment reflects that revision, including ingress acknowledgement and the documented trusted-author access model. This report compares implemented behavior with Docker Engine Swarm mode, not discontinued Classic Swarm. Recommendations below are proposals, not shipped capabilities.

## Assessment

**Tug offers a more integrated workflow for a small trusted team hosting Compose applications; Swarm offers substantially stronger cluster orchestration.** Tug's advantage is the combination of source builds, registry-free application image delivery, managed HTTPS, scoped operator access, deployment history and workload backup/restore. Swarm's advantage is continuous scheduling, stable cross-host service networking, richer update policies and an available replicated control plane.

There is considerable overlap. Tug implements its own desired-state distribution, node identities, placement, health reporting, container reconciliation, rolling replacement and rollback. Those are orchestration responsibilities, even though Tug uses ordinary Docker containers instead of Swarm services. Calling Tug merely a deployment CLI understates its scope; treating it as a Swarm-equivalent scheduler overstates its recovery behavior.

For the [target workload](roadmap.md#goal)—one to a few dozen sites on two to ten VPSes—Tug's integrated operating workflow is a credible reason to exist. The strongest case for Swarm is an application whose stateless capacity must recover automatically after a machine fails. Neither tool alone makes a database or local uploads highly available.

This is a source and documentation assessment, not a comparative benchmark or a live Swarm failure test. “Better” below means better suited to a stated requirement, not a measured performance or reliability ranking.

## Capability overlap and differences

| Concern | Tug today | Docker Swarm mode | Assessment |
| --- | --- | --- | --- |
| Runtime | A separate Tug agent drives each node's Docker Engine API; Compose normalizes input on the operator machine. | Orchestration and worker execution are built into Docker Engine. [D1] | Swarm requires less custom runtime software; Tug controls the complete deployment workflow. |
| Application definition | Current `docker compose config` normalization, followed by Tug's explicit supported-key allowlist and `x-tug` extensions; `deploy`, top-level `configs`/`secrets` and custom networks are rejected. | `docker stack deploy` consumes legacy Compose v3, with Swarm deployment settings; it does not support the whole current Compose specification. [D2] | Neither accepts every local Compose project unchanged. |
| Desired state | Control stores revisions; agents fetch their assigned state and repair local containers while connected. | Managers maintain services through scheduled tasks. [D3] | Strong overlap; the scheduling boundary differs. |
| Placement and replicas | Named nodes or matching labels; one container per service per node; explicit `tug scale`; no capacity-aware admission. | Replicated/global services, constraints, spread preferences and CPU/memory reservations; multiple replicas can occupy one node when constraints allow. [D4] | Swarm is more flexible for capacity and placement. |
| Worker failure | Stale/unhealthy endpoints are withdrawn; existing placement is not automatically reassigned. | Replacement tasks are scheduled onto available eligible nodes. [D1] | Swarm can restore stateless replica count without an operator. |
| Global mode | Expands to a concrete list of matching nodes at deploy or scale. | Maintains a task on each eligible available node, including new nodes. [D4] | The matching name hides different lifecycle behavior. |
| Service discovery | Local Docker DNS; remote names use health-filtered `extra_hosts` entries pointing at host addresses and published ports. | Overlay connectivity with service DNS and VIP or DNS round-robin discovery. [D5] | Swarm provides a more stable cross-node application interface. |
| External traffic | Managed Caddy routes hostnames to serving endpoints and obtains HTTPS certificates. | Routing mesh exposes a service port across nodes; host publication can bypass it. [D6] | Tug bundles web ingress; Swarm needs a reverse proxy for a comparable hostname/ACME workflow. |
| Port exposure | Ports without an explicit host IP bind to the node address or loopback. | Routing-mesh publication is reachable on all node IPs; internal overlay services can remain unpublished. [D6] | Tug guards accidental public binding, but remote internal services need host ports that Swarm's overlay avoids. |
| Rolling deployment | Opt-in healthy candidate, ingress switch and drain; requires managed ingress, an `x-tug.health` check and exactly one published port. | Configurable start/stop order, batches, delays, monitoring and failure action. [D7] | Tug covers its web use case; Swarm supports broader rollout policies. |
| Rollback | New project deployment from earlier desired state; optional automatic rollback after reported deployment failure. | Manual or automatic rollback of an individual service update. [D8] | Tug groups history around projects; neither rollback reverses data changes or creates an atomic application transaction. |
| Images | Build on control or locally, deliver saved application images over mTLS; published images must resolve to a digest before publication. | Uses available images, normally distributed through a registry; tags can be resolved to digests. [D2][D4] | Tug integrates build/delivery; digest pinning itself overlaps. |
| Secrets and config | Secrets encrypted in control storage, released by placement/reference and substituted into container environment; no general managed config-file object. | Encrypted secrets mounted as in-memory files on Linux; separate file-based config objects. [D9][D10] | Swarm has the stronger runtime secret interface; Tug fits environment-based applications. |
| Identity | Private CA, node certificates with automatic renewal, key-based revocation and named operator credentials. | Node mTLS, automatic certificate renewal, role-specific join tokens and coordinated CA rotation. [D11] | mTLS and renewal overlap; Tug adds operator policy, Swarm has a more complete CA lifecycle. |
| Operator access | Built-in `read`/`deploy`/`admin`, project scope and actor-attributed deployment events; no project-specific node grants. | Docker daemon access is all-or-nothing by default; authorization plugins can add policy. [D12] | Tug has useful built-in team/CI controls, subject to its trusted-author model. |
| Control availability | One SQLite-backed control plane; backup/restore recovery; no implemented automatic standby promotion. | Replicated manager state with quorum and leader election; three managers tolerate one manager failure. [D13] | Swarm supports control-plane HA. |
| Persistent data | Node-local volumes, guarded deletion and integrated restic backup/restore; external shared storage remains operator-managed. | Volumes and drivers; scheduling does not replicate local volume contents. [D4] | Tug bundles recovery tooling; neither supplies database or storage HA. |
| One-off work | `tug exec`, service-derived `tug run`, scheduled backup commands and restore holds. | Replicated/global jobs are available through the service CLI. [D14] | Swarm has job primitives; Tug bundles application operating tasks. Neither fact implies a general built-in cron service. |
| Diagnostics | JSON or human-readable status, events, doctor and live container commands; metrics, alerting and webhooks remain planned. | Task states, service inspection/logs and Docker events. [D15][D16] | Neither core product is a complete monitoring stack. |

Tug evidence: [Architecture](architecture.md), [Compose extensions](compose.md), [Networking](networking.md), [Access control](access-control.md), [Control plane](control-plane.md), [Backups](backups.md) and [Observability](observability.md). Code references for the less obvious differences follow below. Docker references are listed under [Sources](#sources).

## Where Tug is better suited

### A complete path from source to an operating site

Tug can accept a source context, build the application image on control, retain it as an immutable artifact and deliver it to agents over their existing authenticated connection. Local builds are also supported. An operator does not need to set up an application registry to use that path. Published third-party images still come from their upstream registries; this is not an offline deployment system.

Swarm's stack workflow expects images to be built separately, and its documented distribution workflow uses a registry; `build` is ignored by stack deployment. [D2] A Swarm installation can add CI builds and a registry, but Tug already integrates those steps. Its corresponding cost is concentrating build execution, artifact bandwidth and storage on control. See [image delivery](control-plane.md#image-delivery-without-a-registry) and [`src/images/build.ts`](../src/images/build.ts).

Tug also refuses to publish an unresolved image tag. Swarm can warn and let workers resolve it independently; explicit digest references avoid that fallback. [D4] This gives Tug a stricter default for published-image identity, rather than a unique ability to pin images.

### The small-site operating workflow

Tug combines hostname ownership checks, Caddy/ACME, per-project credentials, deployment audit history, scheduled restic backups, a backup catalog and guarded restores. This closely matches the work of operating WordPress sites. These are useful product integrations beyond the scheduling and service-networking primitives in Swarm's core. A fair alternative is Swarm plus a proxy, CI, backup tooling and an access layer; that assembled system can close much of the workflow gap, with more integration to own.

Backup convenience is not a consistency guarantee. Database commands and file snapshots can describe different instants; live database files need an application-appropriate backup method. See [Backups](backups.md). Likewise, a project rollback restores desired images/configuration, not database schema, uploads or external effects.

### An outbound management channel

A Tug node needs only outbound access to the control mTLS listener for desired state, image downloads and live commands. That is a useful fit for restricted nodes and management access through NAT. Workload traffic is a separate requirement: remote ingress and inter-node services still need reachable node addresses on an operator-provided network.

Swarm requires reachable manager endpoints and, for overlay networking, peer connectivity on TCP/UDP 7946 and UDP 4789; managers use TCP 2377. [D17] Those are private-network requirements, not a reason to expose the ports publicly. Swarm can operate over a suitable VPN behind NAT, so “Swarm cannot use NAT” is too broad. The actual Tug advantage is avoiding a peer-to-peer overlay requirement for its management channel.

### Scoped team and CI access

Tug exposes a narrow application-oriented API with named actors and built-in roles/projects. This is more convenient than granting a deployment job unrestricted manager Docker access. Swarm's default authorization can be extended with plugins, so it is inaccurate to say Swarm cannot have scoped access. [D12] Docker events also exist; Tug's distinction is an application deployment history that records the acting credential, rather than the mere existence of events. [D16]

These controls do not make Tug a hostile-tenant platform. Deployment authors must be trusted with their selectable hosts, co-located workloads and runtime secrets. See the current [access boundaries](access-control.md) and [security findings](security.md); some findings remain partial, and this report does not re-audit them.

## Where Tug is worse or more limited

### Scheduling is resolved at an operation, not continuously

At deploy, [`src/control/control.ts`](../src/control/control.ts) resolves label/global placement to named nodes. Label candidates are sorted by name and sliced to the requested count. `tug scale` also selects a concrete node list, using registration order. Agents reconcile that assignment; there is no controller continuously moving replicas to replace lost nodes or adding newly enrolled nodes to global services.

There are several practical consequences:

- A service on `app1` and `app2` loses capacity when `app1` disappears; withdrawing its endpoint does not create a replacement on `app3`.
- Requesting three replicas with only two eligible nodes records two. The unmet third replica does not remain as a pending demand. Scaling to zero is rejected.
- Each service gets at most one steady-state replica on a node. Repeated selection of the first candidates across different services is not cluster-wide load balancing.
- CPU/memory settings can constrain individual containers, but Tug does not reserve capacity before placement. A deployment can overload a selected node.
- `node disable` revokes management access and removes endpoints; it neither stops the existing containers nor drains them elsewhere.

See [`src/control/placement.test.ts`](../src/control/placement.test.ts), [`src/container-spec.ts`](../src/container-spec.ts) and the [CLI](cli.md). Swarm has continuing task replacement and resource-aware placement, and its drain operation moves eligible service tasks. [D3][D14][D18] These semantics matter more than both tools having a `replicas` field.

### Remote service names are a weaker contract

Tug's remote names map to host addresses, require published ports and do not provide a service VIP or general load balancing. A changed hosts entry changes the client container definition, which can recreate or roll that client. This couples endpoint churn to otherwise unrelated application restarts.

Rolling web services are especially constrained: the active host port changes per revision, but a hosts entry carries no port. A remote client must use the ingress hostname, rather than the declared service host port. On the same node, both old and new revisions can share the service alias during overlap, allowing local name traffic to reach a candidate before it is healthy. Only the ingress path supplies the documented readiness gate. See [Networking](networking.md#rolling-services-and-service-names).

Swarm's DNS/VIP and overlay remove the need to publish an internal database port to the host network and provide a stable service endpoint across task changes. [D5] This is a substantial advantage for applications with many cross-node dependencies.

### Web rollouts cover a narrower failure model

Tug's candidate/drain mechanism is useful for ingress-fronted stateless services, and a rejected candidate leaves the prior revision serving. Deployment success also waits for enabled managed-ingress nodes to acknowledge the current routing configuration when routes change; this verifies applied configuration, not external DNS, certificate issuance or a successful public request. Without an enabled ingress node, convergence covers service health only. See [deployment convergence](architecture.md#desired-state-and-reconciliation).

It is not a general rolling-update engine for workers, TCP-only services or services with several published ports. There is no configurable cluster-wide batch size or tolerated failure ratio. Swarm exposes those update controls. [D7]

Local reconciliation also differs: [`ensureContainer` in `src/agent/reconciler.ts`](../src/agent/reconciler.ts) restarts a stopped matching container but reuses a running matching container. Repeated failed health checks do not, by themselves, replace that unhealthy running container. Swarm replaces failed/unhealthy tasks. [D3] Neither approach establishes that a service is application-correct merely because a health check passes.

### One control plane is a real availability limit

Tug intentionally has one writer. Existing containers and already-configured Caddy can keep serving during a control outage, but `pollOnce` fetches work before reconciling: without control, the agent does not keep applying an independently cached desired state. Docker restart policies can still restart configured containers. Deploys, endpoint/config updates and newly scheduled backup work wait for control to return. See [`src/agent/agent.ts`](../src/agent/agent.ts) and [`src/backup/scheduler.ts`](../src/backup/scheduler.ts).

Swarm can run with one manager too; three managers are required to tolerate one manager loss while retaining quorum, not to run Swarm at all. Existing tasks continue if quorum is lost, but orchestration cannot proceed. [D13] Tug's backup/restore path is disaster recovery, not an equivalent to replicated managers.

### Secret handling and certificate recovery have gaps

Tug's secret values end up in container environments and are consequently visible through sufficiently privileged Docker/container access. Redacting a CLI inspection response does not remove them from Docker's configuration. Swarm's Linux in-memory secret files avoid routinely putting secret values in environment metadata, although host administrators and authorized applications remain trusted. [D9]

Both systems secure management traffic; neither encrypts all workload traffic by default. Swarm has opt-in encrypted overlays, including separate configuration for encrypted ingress. Tug supplies no workload encryption and relies on application TLS or the operator's network. [D5]

Swarm also has coordinated root CA rotation and optional manager autolock. [D11][D19] Tug renews leaf certificates and supports replacing node identities, but has no equivalent coordinated CA rotation workflow. Its CA/master key and workload recovery secrets need careful recovery planning. This is a difference in available mechanisms, not evidence of a particular exploitable flaw.

## What happens when something fails?

| Event | Tug | Swarm |
| --- | --- | --- |
| A local container exits | Docker's configured restart policy may restart it; a connected agent also starts/recreates missing or stopped desired containers. | Desired service state drives replacement tasks, subject to restart policy. [D3] |
| One application host disappears | Remaining replicas may serve; control withdraws stale endpoints as other agents receive updates. Placement stays unchanged until an operation changes it. | With manager quorum, eligible capacity and accessible images/data, replacement tasks can restore stateless capacity. [D1] |
| An isolated host still runs its database | Losing its management identity or endpoint does not stop its containers. Operator fencing is required before another writer is promoted. | Scheduling a replacement is not proof the isolated original writer has stopped. Quorum is not database fencing. This is an operational inference from the scheduling and storage model. [D3][D4] |
| The control host fails | Existing traffic may continue; no new control-driven work until restart/restore. | A three-manager cluster can continue managing after one manager loss; a single-manager cluster has no such tolerance. [D13] |
| An ingress host fails | Other configured ingress nodes help only if DNS or an external traffic mechanism directs clients to them. Tug does not move the public endpoint automatically. | Routing mesh helps through another reachable node; moving a public IP, DNS or external load balancer still requires an external mechanism. [D6] |
| A database host loses its disk | Restore data and recover placement; backup frequency determines potential data loss. | Local volumes do not follow tasks. A replacement on a different host can have a new empty volume unless storage/placement is handled explicitly. [D4] |
| A deployment introduces a bad database migration | Image rollback does not reverse it; an application recovery procedure is required. | Service rollback also does not reverse database writes. |

The key availability lesson for the reference WordPress topology is that extra PHP replicas do not remove a single database, uploads server or public ingress endpoint as a failure point. Swarm improves scheduling; it does not supply the missing data architecture. Tug improves integrated recovery; it does not turn recovery into uninterrupted service.

## Choosing between them

| Requirement | Better starting point | Reason |
| --- | --- | --- |
| A few sites, a trusted operator, existing private network, acceptable manual host recovery | Tug | Integrated build, HTTPS, backup/restore and operating commands align with the project's scope. |
| Management of restricted or NATed nodes | Tug | Agents only initiate control connections; separately establish any needed workload connectivity. |
| Many replicas, several tasks per host, continuous capacity recovery or planned host draining | Swarm | Those are core scheduler responsibilities already implemented there. |
| Frequent cross-node service communication | Swarm | Stable DNS/VIP/overlay networking avoids Tug's hosts-file and published-port constraints. |
| Continued deployments after a control machine fails | Swarm with replicated managers | Tug currently requires recovery of its single control plane. |
| A fully HA database-backed application | Either needs additional design | Database replication/fencing, shared data, traffic failover and restore testing determine the outcome. |
| Mutually untrusted customers deploying arbitrary code | Neither default setup | Tug's documented trust model and default Docker daemon authorization do not provide that product boundary. |

No measurements here support claiming Tug is faster, uses less memory, scales further or is more reliable than Swarm. Swarm's orchestrator is already in Docker Engine; Tug adds Node processes and supporting containers. Tug avoids overlay machinery, but that alone does not establish a lower total operating cost. Compare equivalent deployments, including the proxy, builds, registry, backups and access layer, before making a resource claim.

## Recommendations for Tug

1. **Keep the product centered on operating small applications.** Build/delivery, safe deployment history, HTTPS, backup/restore and useful CI access are its strongest differentiators. Reimplementing every Swarm scheduler feature would substantially increase scope.
2. **Document scheduling semantics precisely.** Describe replicas/global as resolved placement, expose requested versus assigned capacity and explain that stale endpoint withdrawal is not rescheduling. Any future automatic movement should start with explicit stateless eligibility and a clear policy for isolated old containers; local-volume workloads should remain pinned unless a recovery workflow handles their data.
3. **Improve discovery before adding more scheduling.** Avoid recreating clients merely because remote endpoints change, and provide a stable address/port contract for rolling services if cross-node clients become a priority. Keep overlay-free networking as an explicit tradeoff rather than claiming networking parity.
4. **Prioritize recovery evidence and visibility.** Test control outage during rollout, full control restore, lost-node behavior and restore freshness; add the planned metrics/alerts. A continuously running backup service is less valuable than knowing a recent backup can actually be restored.
5. **Borrow narrow lifecycle features where justified.** File-based secret delivery, a documented CA rotation/recovery procedure, graceful node retirement and clearer insufficient-capacity reporting would improve today's model without requiring a general scheduler. These are proposals, not commitments added by this report.

Using Swarm as a backend is technically plausible: Tug could retain builds, access policy, audit, ingress and backups while delegating services to Swarm. That would require a new scheduling/identity boundary, changes to rollout and live-command targeting, different image distribution and continued handling of node-local backups/restores. Merely enabling Swarm mode would not manage Tug's existing standalone containers, and Swarm drain explicitly excludes such containers. [D18] Treat a backend change as a separate architecture decision justified by requirements for continuous failover or service networking; this comparison alone does not justify replacing the runtime.

## Sources

Tug implementation reviewed: [`src/control/control.ts`](../src/control/control.ts) (deploy placement, scale, access checks, convergence), [`src/agent/agent.ts`](../src/agent/agent.ts) (work fetch before reconciliation and live operations), [`src/agent/reconciler.ts`](../src/agent/reconciler.ts) (local replacement and rollout state), [`src/container-spec.ts`](../src/container-spec.ts) (resources and secret substitution), [`src/ingress.ts`](../src/ingress.ts), [`src/pki.ts`](../src/pki.ts), [`src/agent/credential.ts`](../src/agent/credential.ts), [`src/backup/scheduler.ts`](../src/backup/scheduler.ts) and [`src/backup/restore.ts`](../src/backup/restore.ts). Existing behavior coverage includes [`src/control/placement.test.ts`](../src/control/placement.test.ts), [`src/agent/reconciler.test.ts`](../src/agent/reconciler.test.ts), [`src/control/rollout.test.ts`](../src/control/rollout.test.ts), [`src/agent/network.test.ts`](../src/agent/network.test.ts), [`src/control/mtls.test.ts`](../src/control/mtls.test.ts) and [`tests/integration`](../tests/integration).

Docker primary documentation, consulted 2 November 2026. The service CLI is used to verify actual Swarm options; the Compose specification describes policy vocabulary and does not imply that every current Compose feature is accepted by `docker stack deploy`.

- D1: [Swarm mode overview][D1].
- D2: [Deploy a stack to a swarm][D2].
- D3: [How services work][D3].
- D4: [Deploy services: images, placement and volumes][D4].
- D5: [Swarm service networking and encryption][D5].
- D6: [Routing mesh][D6].
- D7: [Update and rollback policy vocabulary][D7].
- D8: [Service update and rollback CLI][D8].
- D9: [Docker secrets][D9].
- D10: [Docker configs][D10].
- D11: [Swarm PKI and CA rotation][D11].
- D12: [Docker authorization plugins and default authorization][D12].
- D13: [Swarm administration, quorum and recovery][D13].
- D14: [Service creation CLI, resources and job modes][D14].
- D15: [Task states][D15].
- D16: [Docker events][D16].
- D17: [Swarm network prerequisites][D17].
- D18: [Drain a node][D18].
- D19: [Manager autolock][D19].

[D1]: https://docs.docker.com/engine/swarm/
[D2]: https://docs.docker.com/engine/swarm/stack-deploy/
[D3]: https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/
[D4]: https://docs.docker.com/engine/swarm/services/
[D5]: https://docs.docker.com/engine/swarm/networking/
[D6]: https://docs.docker.com/engine/swarm/ingress/
[D7]: https://docs.docker.com/reference/compose-file/deploy/
[D8]: https://docs.docker.com/reference/cli/docker/service/update/
[D9]: https://docs.docker.com/engine/swarm/secrets/
[D10]: https://docs.docker.com/engine/swarm/configs/
[D11]: https://docs.docker.com/engine/swarm/how-swarm-mode-works/pki/
[D12]: https://docs.docker.com/engine/extend/plugins_authorization/
[D13]: https://docs.docker.com/engine/swarm/admin_guide/
[D14]: https://docs.docker.com/reference/cli/docker/service/create/
[D15]: https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/
[D16]: https://docs.docker.com/reference/cli/docker/system/events/
[D17]: https://docs.docker.com/engine/swarm/swarm-tutorial/
[D18]: https://docs.docker.com/engine/swarm/swarm-tutorial/drain-node/
[D19]: https://docs.docker.com/engine/swarm/swarm_manager_locking/
