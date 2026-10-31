# Nodes

A node is a Docker host running the Launchpad agent container. Add nodes either by pushing an install over SSH or by letting a fresh host enroll itself.

## Push install over SSH (`node install`)

```bash
launchpad node install root@app1.example.com --name app1 --address 10.0.0.11 \
  --control-url https://control.example.com --registry registry.example.com
```

This registers the node with control (issuing an agent token and a registry pull token), runs SSH preflight checks, transfers the Launchpad image (skip with `--no-transfer-image`), writes `/etc/launchpad/agent.env`, runs `docker login` against `--registry` if given, and starts the agent container.

Preflight checks fail early, with a fix hint, unless the host has Docker Engine accessible to the SSH user, Docker Compose v2, writable `/opt`, `/var/lib` and `/etc/launchpad` paths, at least 1024 MB free under `/var/lib`, and can reach `<control-url>/healthz`. The control URL must be `https://` unless you pass `--http-only-dev` for local or private development.

## Self-service enrollment (`node enroll`)

A pull-based alternative modeled on Portainer Edge agents: the operator never needs SSH to the host. Mint an enrollment key, then run the printed `docker run` on the fresh host or put it in cloud-init/user-data so the host enrolls on first boot. The agent dials out to control, so this works behind NAT and firewalls.

```bash
launchpad node enroll --name app1
# prints, e.g.:
#   docker run -d --name launchpad-agent --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v launchpad-agent:/var/lib/launchpad \
#     -e LAUNCHPAD_JOIN_KEY=<key> \
#     launchpad:local agent
```

The enrollment key (`LAUNCHPAD_JOIN_KEY`) is base64url-encoded JSON with the control URL, a short-lived limited-use `enrollToken` and, with `--ca`, the control plane's CA certificate. The durable agent token is minted by control during enrollment and persisted to the agent's state volume (`/var/lib/launchpad/agent.json`); it never appears on the `docker run` command line or in `docker inspect`. On restart the agent loads the persisted token and skips enrollment; on a fresh volume it enrolls again. A leaked join key is spent after its uses and expires on its own.

Options:

- `--name <node>` binds the node name; without it each host names itself from its hostname.
- `--uses <n>` lets one key enroll several hosts (default `1`).
- `--ttl <seconds>` sets the key lifetime (default `3600`).
- `--ca <ca.pem>` embeds a private or self-signed control CA, so agents trust it without a separate `NODE_EXTRA_CA_CERTS`.
- `--image <tag>` sets the image in the printed command (default `launchpad:local`).
- `--json` prints machine-readable output.
- `--http-only-dev` allows a plaintext HTTP control URL.

To keep the key out of shell history and `docker inspect`, mount it as a file and set `LAUNCHPAD_JOIN_KEY_FILE=/path/to/key` instead of `LAUNCHPAD_JOIN_KEY`.

## Joining the WireGuard mesh

Add `--mesh` to `node install` or `node enroll` (and set `LAUNCHPAD_MESH=true` on control) to run the agent with host networking and `NET_ADMIN`, so it can create `wg0` and join the overlay. Give nodes that other nodes must dial a `--public-address`; nodes behind NAT can omit it. See [Networking](networking.md).

## Register only (`node:register`)

`launchpad node:register --name <node> [--address <ip>] [--public-address <ip>]` registers a node and prints its agent and registry tokens without installing anything, for running the agent yourself (see [Development](development.md)).

## Status and diagnostics

Nodes are `online` while they poll and become `stale` after `LAUNCHPAD_STALE_SECONDS` (default `60`) without a poll. `launchpad status` lists nodes, deployments and per-node project status; `launchpad doctor --nodes` (or `--node <name>`) queues Docker and Compose checks on agents.

## Configuration

See [Configuration](configuration.md#agent) for agent environment variables.
