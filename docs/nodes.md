# Nodes

A node is a Docker host running the Tug agent container. Add nodes either by pushing an install over SSH or by letting a fresh host enroll itself.

## Install over SSH (`node-install`)

```bash
tug node-install root@app1.example.com --name app1 --address 10.0.0.11 --install-docker
```

The node generates its own key and certificate request; an admin credential authorizes the identity at that moment and the certificate is installed back over SSH, so no bootstrap secret travels and the private key never leaves the node's state volume. In order, the command runs SSH preflight checks, runs `agent identity` on the host (printing the CSR for the pending key in `/var/lib/tug/agent-pending.json`), posts it to `POST /api/v1/nodes/:name/identity` with `mode: create`, pipes the response into `agent install-cert` (which validates that the certificate names this node, chains to the CA in the response and matches the pending key before durably writing `/var/lib/tug/agent.json`), writes `/etc/tug/agent.env` and starts the agent container. Every step is safe to repeat: rerunning after a partial failure reuses the pending key, and `create` with the identical key is an idempotent retry that keeps the first call's metadata. No secret appears in an SSH command line or log. The command then waits for a status report from the new identity (`--no-wait` skips it).

`--address` is where other nodes and the ingress reach this node's services without the mesh, and the address its published ports bind to ([Published ports](networking.md#published-ports-private-by-default)); give an IP on one of the host's interfaces, preferably a private one. `--public-address` is only the WireGuard endpoint.

Built application images are downloaded directly from control. Published images are pulled by their stored digest from upstream registries, with private credentials released through control when needed. No node registry login is required.

Small hosts: a 1 GB VPS is enough for one site (a database and WordPress together use a few hundred MB), but not for much else. Ubuntu's `unattended-upgrades` and `apt-check` can run for hours on such a host and starve Docker of memory and CPU until commands time out; during testing one pegged a 1 GB node at load 16. Tug does not manage host updates; if the host is small, schedule them for a quiet window or disable the timers (`systemctl disable --now apt-daily.timer apt-daily-upgrade.timer`) and patch deliberately. A control plane and a node on the same host also compete for port 8443 if a service publishes it, which is why the WordPress example is not meant to share a host with control until [M15](roadmap.md#m15--flexible-node-roles).

Preflight checks fail early, with a fix hint, unless the host has Docker Engine accessible to the SSH user, writable `/opt`, `/var/lib` and `/etc/tug` paths, at least 1024 MB free under `/var/lib`, and can open a TCP connection to the control port. Preflight checks reachability only and copies no operator credential to the host; real TLS authorization happens when the agent first connects.

The global `--control-url` changes only where the operator CLI connects; the certificate is still verified against the credential's public URL. When agents must dial a different address, pass `--agent-control-url`; it is written to the agent environment as `TUG_CONTROL_URL` and is likewise a connect target only. For a local SSH tunnel to control and a private endpoint for nodes: `tug --control-url https://127.0.0.1:18082 node-install root@app1.example.com --name app1 --agent-control-url https://10.110.0.3:8443`. Both overrides must be `https://`.

### Certificates, renewal and recovery

Node certificates last 90 days. The agent renews at two thirds of the lifetime plus up to ten percent random jitter by sending a CSR for its existing key to `POST /agent/v1/renew`, saves the new certificate durably, then swaps its HTTP client and reconnects the stream. If renewal fails it keeps working on the old certificate until that expires. Authorization follows the key, so old certificates stay valid until they expire and routine renewal closes no connection. Control enforces a minimum interval between renewals per node (`TUG_RENEW_MIN_INTERVAL_MS`, default one hour).

| Situation | Command |
| --- | --- |
| Cut a node off immediately, without SSH or deleting anything | `tug node-disable <node>` |
| Certificate expired, key lost or suspected compromised, node disabled, CA loss, or an older backup restored | `tug node-replace <ssh-target> --name <node>` installs a new key (`mode: replace`); the old key's certificates stop working at once and their sockets close |
| `agent.json` or `agent-pending.json` is corrupt | `tug node-repair <ssh-target> --name <node>` moves the corrupt documents aside (never service volumes or agent event state) and replaces the identity |
| Every node after a CA loss or older restore | recover root on the control host (`control-install --recover-root`), then `tug node-replace --all` |

`node-install --all` and `node-replace --all` walk the SSH targets declared in `tug.yml` one node at a time, continue after failures and print a per-node result. Suspected key compromise is `node-disable` followed by `node-replace`. `node-remove` revokes the node's key and any unconsumed join key.

## Declaring nodes in the config file

A repository can record its servers in the [config file](cli.md#config-file) so nobody has to remember `root@203.0.113.7`:

```yaml
# tug.yml
nodeDefaults:
  installDocker: true
nodes:
  app1:
    ssh: root@203.0.113.7
    publicAddress: 203.0.113.7
    label: [web, ingress]
```

`tug node-install --name app1` then runs as if `root@203.0.113.7 --address ... --label web --label ingress --install-docker` had been typed; `tug node-register app1` and `tug node-enroll --name app1` read the same entry. Flags override the file key by key, and a `label` list on the command line replaces the file's list. An `<ssh-target>` argument overrides `ssh`; without one, a node with no `ssh` in the file is an error that names the missing key. The argument is never guessed to be a node name, because `app1` is also a valid hostname. `nodeDefaults` apply to every node, declared or not.

The control plane stays the source of truth. Only `node-install`, `node-replace`, `node-repair`, `node-register` and `node-enroll` read `nodes`, as flag defaults; `status`, `deploy`, `scale`, `ps`, `logs`, `exec`, `node-remove` and every other command ask control and never consult the file. Re-running `node-install` with the same key is an idempotent retry that keeps the first call's metadata; `node-replace` installs a new key and keeps the node's ID, metadata and placement. Editing the file without re-running anything changes nothing in control.

## Self-service enrollment (`node-enroll`)

For hosts you cannot SSH to or do not want to touch: cloud-init and user-data provisioning, autoscaling and golden images, hosts behind NAT or in private networks, and delegated onboarding by someone without admin credentials. Mint a join key with an admin credential, then run the printed `docker run` on the fresh host or put it in user-data. The agent dials out to control.

```bash
tug node-enroll --name app1
# prints, e.g.:
#   docker run -d --name tug-agent --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v tug-agent:/var/lib/tug \
#     -e TUG_JOIN_KEY=<key> \
#     ghcr.io/wpelevator/tug:<CLI version> agent
```

The join key (`TUG_JOIN_KEY`) is base64url-encoded JSON `{ v: 2, credential, name, connectUrl? }`. The credential is a **bootstrap certificate** with SAN `tug:enroll:<id>` and its private key; it can reach `POST /agent/v1/enroll` and nothing else. The agent generates its own node key (into `agent-pending.json`), sends a CSR with the bootstrap certificate, validates and installs the returned node certificate exactly as `agent install-cert` does, and from then on ignores the join key. On restart the agent loads `/var/lib/tug/agent.json` and skips enrollment.

Join keys are single-use, name-bound and short-lived (default one hour). There is no `--uses` and no reusable or unbound key, so golden-image and autoscaling flows mint one key per instance, for example into each instance's cloud-init. Name and labels come from the control-side row, never from the join key or the request. Enrollment is create-only: an existing name is refused and a join key can never replace a node. A retry with the same CSR key after a lost response signs another certificate and changes nothing stored. Minting again for a name revokes its previous unconsumed key, and `node-remove` revokes it too. The join key is as sensitive as the enrollment token it replaces: a saved user-data document contains a credential, and in cloud user-data it may be readable from the provider's metadata service by processes on the host. Single use, short life, name binding and create-only enrollment limit the damage.

Options:

- `--name <node>` (required) binds the node name.
- `--agent-control-url <url>` sets `connectUrl`, a connect-only target; the credential's public URL is still the verified name.
- `--ttl <seconds>` sets the key lifetime (default `3600`).
- `--label <label>` sets node labels (repeatable).
- `--image <tag>` sets the image in the printed command (default `ghcr.io/wpelevator/tug:<CLI version>`).
- `--mesh` prints a mesh-capable command.
- `--json` prints machine-readable output.
- `--install-docker` prints a complete cloud-init document that installs Docker Engine and Compose before starting the agent. With `--json`, the result includes both `command` and `cloudInit` fields.

To keep the key out of shell history and `docker inspect`, mount it as a `0600` file and set `TUG_JOIN_KEY_FILE=/path/to/key` instead of `TUG_JOIN_KEY`. Without an identity or a join key the agent refuses to start and points to `tug node-install`, `tug node-enroll` or `tug node-repair`.

## Bare-host Docker installation

`control-install --install-docker` and `node-install --install-docker` run the same Docker bootstrap over SSH before Docker preflight or runtime-image transfer. Without the flag, Docker Engine and Compose must already work. The SSH target must be root for installation; Tug does not modify group membership or configure passwordless sudo.

For a host created by your cloud provider, save `tug node-enroll --name app1 --install-docker` as user-data. Its stdout starts with `#cloud-config`, includes the bootstrap script and starts the agent only after Docker installation succeeds. The default version-matched Tug runtime image must be accessible from the host; an overridden development `tug:local` image must already be loaded there. Enrollment tokens remain short-lived and should be treated as credentials when saving user-data.

Bootstrap requires systemd and supports these releases:

| Family | Releases | Docker repository |
| --- | --- | --- |
| Debian (apt) | 12 `bookworm`, 13 `trixie` | [Debian](https://docs.docker.com/engine/install/debian/) |
| Ubuntu (apt) | 22.04 `jammy`, 24.04 `noble`, 26.04 `resolute`, 26.10 `stonking` | [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) |
| Fedora (dnf) | 42, 43, 44 | [Fedora](https://docs.docker.com/engine/install/fedora/) |
| RHEL (dnf) | 9, 10 | [RHEL](https://docs.docker.com/engine/install/rhel/) |
| Rocky Linux, AlmaLinux, CentOS Stream (dnf) | 9, 10 | [CentOS](https://docs.docker.com/engine/install/centos/) |

It adds Docker's official apt or dnf repository, installs Engine and Buildx, and enables Docker (the control host also gets the Compose plugin). A working Engine installation is preserved. If only Compose is missing, it installs the plugin without upgrading Engine. An inaccessible existing daemon, unsupported OS or release, or conflicting distribution packages (`docker.io` and `podman-docker` on Debian/Ubuntu; `docker`, `moby-engine` and `podman-docker` on RPM hosts) produce a clear error for manual resolution; Tug does not remove them or alter Docker daemon trust settings. Other distributions, such as Alpine or Arch, and hosts without systemd need Docker installed manually.

## Image

`node-install` and `node-enroll` default `--image` to `ghcr.io/wpelevator/tug:<version>`, where `<version>` is the installed CLI's own package version, so the CLI and the agents it installs stay on the same release. Pass `--image <tag>` to run another image, for example `ghcr.io/wpelevator/tug:edge` for the latest build of `main` or a mirror in your own registry.

`node-install --build-local-image` is for development: it builds the image from the current checkout, copies it to the host with `docker save` / `scp` / `docker load` and runs it, tagging it `tug:local` unless `--image` is also given. It needs a Tug checkout (the Dockerfile) in the working directory. See [Releases](releases.md) for how images are published. The image is built for the target host's architecture (read with `uname -m` over SSH), so an arm64 laptop can install an amd64 VPS; x86_64 and aarch64 hosts are supported.

## Node labels

`node-install`, `node-enroll` and `node-register` accept a repeatable `--label <label>`. Labels are plain tags stored on the node and listed by the node list API; services select nodes with `x-tug.placement.labels` (see [Compose extensions](compose.md#services)). Re-registering a node replaces its labels.

## Joining the WireGuard mesh

The agent always runs with host networking (`--network host`): it dials container IPs for TCP and HTTP health checks, which a bridge-networked agent cannot reach on current Docker (29.x). Add `--mesh` to `node-install` or `node-enroll` (and set `TUG_MESH=true` on control) to also give it `NET_ADMIN`, so it can create `wg0` and join the overlay. Give nodes that other nodes must dial a `--public-address`; nodes behind NAT can omit it. See [Networking](networking.md).

## CSR in, certificate out (`node-register`)

`tug node-register <name> --csr node.csr [--mode create|replace]` is the primitive behind the SSH commands: it posts a CSR you generated on the node (for example with `agent identity`) to the identity endpoint and prints the certificate, CA and public URL. Use it for local development or when you drive the steps yourself; install the output with `agent install-cert`.

## Status and diagnostics

Nodes are `online` while they contact control and become `stale` after `TUG_STALE_SECONDS` (default `60`) without an authenticated work fetch, status report or wake wait. Agents keep an outbound WebSocket open so control can wake them for deployments and commands; if WebSockets are unavailable they use an HTTP long poll, and `TUG_POLL_INTERVAL_MS` remains the periodic reconciliation fallback. `tug status` lists nodes, deployments and per-node project status; `tug doctor --nodes` (or `--node <name>`) runs Docker and Compose checks on agents and waits for the result. The wait defaults to 60 seconds.

## Configuration

See [Configuration](configuration.md#agent) for agent environment variables.
