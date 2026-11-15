# Terminology

The words Tug uses, and the one name for each concept. The [CLI reference](cli.md) is authoritative for command names. The naming review that produced them is in [Terminology review](design/terminology-review.md).

## Core concepts

Tug has a control plane and managed nodes. Each node runs an agent, which connects to the control plane and manages that node's containers. Operators use the `tug` CLI to deploy projects made up of Compose services.

| Term | Meaning in Tug | Usage guidance |
| --- | --- | --- |
| Control plane | The central software: API, state store, deployment coordination, image builds and delivery, certificate issuance and backup scheduling. | Use the full name in prose; **control API** specifically means its HTTP/WebSocket interface. Existing `control-*` commands and the `control` runtime mode abbreviate it. |
| Control name | The name control answers to, generated from its CA (`control-<hash>.tug`). | Clients derive it from the CA they pin and verify the server against it, never against the address they dial. Distinct from the control URL, which is only an address. |
| Control-plane host | The machine running the control plane. | Distinguish the machine from the software. Installing the control plane does not automatically register a workload node. |
| Node | A registered Docker host on which Tug places services, represented by a stable record with an immutable generated ID (`node_...`) beside its chosen name. | Use for placement, addresses, labels, connectivity and lifecycle operations. The record remains when its agent stops or its identity is replaced. The ID never changes and is never reused after `node remove`, even if the name is. |
| Agent | The process/container on a node that fetches work, reconciles containers through the Docker Engine API, reports status and handles operations. | Use for software behavior, logs, configuration, upgrades and connections. A node runs an agent. |
| Host | An underlying Linux machine, whether or not registered with Tug. | Use in OS, SSH, Docker and resource discussions; use **node** for a managed deployment target. Qualify hostname fields separately. |
| Project | A named application instance grouping services, secrets, deployment history and volume records. | Keep the Compose term. Different projects can represent separate installations of the same application. Project scope is not host or tenant isolation. |
| Service | A named Compose component, such as `web` or `db`, run on selected nodes. | Keep the Compose meaning; this is not a Kubernetes Service networking object. |
| Replica | One steady-state running copy of a service on a selected node. | Currently at most one steady-state copy per project/service/node; rolling replacement temporarily overlaps old and new containers. |
| Placement | The selection of nodes on which a service runs. | Names pin nodes; labels select matching nodes when deploying or scaling. Do not imply continuous rescheduling or resource-aware scheduling. |
| Deployment | A recorded attempt to publish and converge a project's desired state, with its own ID and lifecycle. | Use for the operation/history record, including a rollback deployment. |
| Desired-state revision | The immutable identity of a desired-state record. | Deploy and rollback use their deployment ID as the revision; scaling can create a separate revision. Distinguish this from a display version. |
| Display version | The supplied or generated label shown for a deployment; current option: `deploy --version`. | It can be reused; it is not an image digest or the installed Tug version. |
| Rollout | Applying a desired-state change to running services. | A deployment has a rollout; `recreate` and `rolling` are service rollout strategies. |
| Service revision | A particular rendered service configuration, identified by a configuration hash for rolling replacement. | Qualify **revision**: this differs from a project's desired-state revision. |
| Ingress | The managed HTTP reverse proxy, currently Caddy, and its hostname routes. | Introduce as **HTTP ingress (managed reverse proxy)**. An ingress node has this capability; it is not a separate machine type. |
| Node address | The node's sole inter-node `address`, used for cross-node service names, ingress upstreams and private published-port binding. | Set it to a private IP on the operator's existing network. Tug does not provide an overlay, tunnel or workload-traffic encryption; local volumes are not shared by networking. |
| Operator credential | A certificate, private key, pinned CA and default control-plane address used by a person or automation. | Created and managed with `credential create`, `credential list` and `credential revoke`; transport uses mTLS. **Operator** includes CI. |
| Node identity | The registered node principal and authorized public key; its agent holds the private key and certificate. | Certificate renewal keeps the key. Identity replacement changes it and invalidates certificates for the old key. |
| Join key | The encoded, short-lived bootstrap credential and node binding used for self-service enrollment. | Explain as an **enrollment credential** containing private-key material. Current variables: `TUG_JOIN_KEY` and `TUG_JOIN_KEY_FILE`. |
| Workload backup | A restic snapshot of a configured service command's output or a volume's files. | Distinguish target, backup run and resulting snapshot. |
| Control-plane backup | An archive of Tug's control-plane state and retained artifacts. | Current command: `control backup`. It does not capture workload volume contents. See [Control plane](control-plane.md#backup-and-restore). |
