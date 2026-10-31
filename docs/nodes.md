# Nodes

A node is a Docker host running the Tug agent container. Add nodes either by pushing an install over SSH or by letting a fresh host enroll itself.

## Push install over SSH (`node-install`)

```bash
tug node-install root@app1.example.com --name app1 --address 10.0.0.11 \
  --control-url https://control.example.com --install-docker
```

This registers the node with control (issuing an agent token and a registry pull token), runs SSH preflight checks, pulls the Tug image on the host (by default `ghcr.io/wpelevator/tug:<CLI version>`; see [Image](#image)), writes `/etc/tug/agent.env`, runs `docker login` against `--registry` if given, and starts the agent container.

A registry is optional: built application images are downloaded directly from control when it has no registry configured. Published images still come from their original registries. Pass `--registry <host>` only when the host needs Tug's per-node registry login.

Preflight checks fail early, with a fix hint, unless the host has Docker Engine accessible to the SSH user, Docker Compose v2, writable `/opt`, `/var/lib` and `/etc/tug` paths, at least 1024 MB free under `/var/lib`, and can reach `<control-url>/healthz`. The control URL must be `https://` unless you pass `--http-only-dev` for local or private development.

The global `--control-url` selects the operator's API connection. When agents must use a different address, pass `--agent-control-url` to `node-install` or `node-enroll`; it controls node preflight and the address stored in the agent environment/enrollment key, while API requests keep using the operator endpoint. Without the option, agents use the resolved operator URL. For a local SSH tunnel to control and a private endpoint for nodes: `tug --control-url http://127.0.0.1:18082 node-install root@app1.example.com --name app1 --agent-control-url http://10.110.0.3:8080 --http-only-dev`. Prefer HTTPS for the advertised URL; the explicit HTTP override is needed for this private-network example.

## Self-service enrollment (`node-enroll`)

A pull-based alternative modeled on Portainer Edge agents: the operator never needs SSH to the host. Mint an enrollment key, then run the printed `docker run` on the fresh host or put it in cloud-init/user-data so the host enrolls on first boot. The agent dials out to control, so this works behind NAT and firewalls.

```bash
tug node-enroll --name app1
# prints, e.g.:
#   docker run -d --name tug-agent --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v tug-agent:/var/lib/tug \
#     -e TUG_JOIN_KEY=<key> \
#     ghcr.io/wpelevator/tug:<CLI version> agent
```

The enrollment key (`TUG_JOIN_KEY`) is base64url-encoded JSON with the control URL, a short-lived limited-use `enrollToken` and, with `--ca`, the control plane's CA certificate. The durable agent token is minted by control during enrollment and persisted to the agent's state volume (`/var/lib/tug/agent.json`); it never appears on the `docker run` command line or in `docker inspect`. On restart the agent loads the persisted token and skips enrollment; on a fresh volume it enrolls again. A leaked join key is spent after its uses and expires on its own.

Options:

- `--name <node>` binds the node name; without it each host names itself from its hostname.
- `--agent-control-url <url>` advertises an agent-reachable endpoint independently of the operator's global `--control-url`.
- `--uses <n>` lets one key enroll several hosts (default `1`).
- `--ttl <seconds>` sets the key lifetime (default `3600`).
- `--ca <ca.pem>` embeds a private or self-signed control CA, so agents trust it without a separate `NODE_EXTRA_CA_CERTS`.
- `--image <tag>` sets the image in the printed command (default `ghcr.io/wpelevator/tug:<CLI version>`).
- `--json` prints machine-readable output.
- `--install-docker` prints a complete cloud-init document that installs Docker Engine and Compose before starting the agent. With `--json`, the result includes both `command` and `cloudInit` fields.
- `--http-only-dev` allows a plaintext HTTP control URL.

To keep the key out of shell history and `docker inspect`, mount it as a file and set `TUG_JOIN_KEY_FILE=/path/to/key` instead of `TUG_JOIN_KEY`.

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

It adds Docker's official apt or dnf repository, installs Engine, Buildx and the Compose plugin, and enables Docker. A working Engine and Compose installation is preserved. If only Compose is missing, it installs the plugin without upgrading Engine. An inaccessible existing daemon, unsupported OS or release, or conflicting distribution packages (`docker.io` and `podman-docker` on Debian/Ubuntu; `docker`, `moby-engine` and `podman-docker` on RPM hosts) produce a clear error for manual resolution; Tug does not remove them or alter Docker daemon trust settings. Other distributions, such as Alpine or Arch, and hosts without systemd need Docker installed manually.

## Image

`node-install` and `node-enroll` default `--image` to `ghcr.io/wpelevator/tug:<version>`, where `<version>` is the installed CLI's own package version, so the CLI and the agents it installs stay on the same release. Pass `--image <tag>` to run another image, for example `ghcr.io/wpelevator/tug:edge` for the latest build of `main` or a mirror in your own registry.

`node-install --build-local-image` is for development: it builds the image from the current checkout, copies it to the host with `docker save` / `scp` / `docker load` and runs it, tagging it `tug:local` unless `--image` is also given. It needs a Tug checkout (the Dockerfile) in the working directory. See [Releases](releases.md) for how images are published.

## Joining the WireGuard mesh

Add `--mesh` to `node-install` or `node-enroll` (and set `TUG_MESH=true` on control) to run the agent with host networking and `NET_ADMIN`, so it can create `wg0` and join the overlay. Give nodes that other nodes must dial a `--public-address`; nodes behind NAT can omit it. See [Networking](networking.md).

## Register only (`node-register`)

`tug node-register <node> [--address <ip>] [--public-address <ip>]` registers a node and prints its agent and registry tokens without installing anything, for running the agent yourself (see [Development](development.md)).

## Status and diagnostics

Nodes are `online` while they poll and become `stale` after `TUG_STALE_SECONDS` (default `60`) without a poll. `tug status` lists nodes, deployments and per-node project status; `tug doctor --nodes` (or `--node <name>`) queues Docker and Compose checks on agents.

## Configuration

See [Configuration](configuration.md#agent) for agent environment variables.
