# CLI reference

Commands that take `--project` default to the project in `.launchpad.json`, then `site`. Most commands print the control API response as JSON.

## Setup

- `launchpad init [--control-url <url>] [--token <token>] [--project <name>]` writes `.launchpad.json`. Defaults: `http://localhost:8080`, `$LAUNCHPAD_TOKEN` or a new token, `site`.
- `launchpad control install <sshTarget> --registry <host> [--token <token>] [--port <port>] [--image <tag>] [--registry-auth-path <path>] [--registry-container <name>] [--no-transfer-image]` installs the control plane over SSH. See [Control plane](control-plane.md).
- `launchpad control:token` prints the local development operator token from `./data/operator.token`.

## Nodes

- `launchpad node install <sshTarget> --name <node> [--address <ip>] [--public-address <ip>] [--control-url <url>] [--registry <host>] [--mesh] [--wg-port <port>] [--image <tag>] [--no-transfer-image] [--http-only-dev]` registers a node and installs its agent over SSH. `--mesh` runs the agent with host networking and `NET_ADMIN` for the WireGuard mesh and adds kernel and UDP-port preflight checks.
- `launchpad node enroll [--name <node>] [--control-url <url>] [--ttl <seconds>] [--uses <n>] [--ca <ca.pem>] [--image <tag>] [--mesh] [--json] [--http-only-dev]` mints an enrollment key and prints a `docker run` for the host.
- `launchpad node:register --name <node> [--address <ip>] [--public-address <ip>]` registers a node and prints its tokens.
- `launchpad node:rotate-wg-key <node> [--timeout <seconds>]` has the node generate a new WireGuard keypair and waits for the result; peers pick up the new public key on their next poll.
- `launchpad node:ingress <node> [--disable]` marks a node as an ingress node (managed Caddy), or removes the role.
- `launchpad node:rotate-registry-token <node>` and `launchpad node:revoke-registry-token <node>` manage registry pull tokens.

See [Nodes](nodes.md) and [Networking](networking.md).

## Secrets

- `launchpad secret:set <name> [--value <value>] [--project <name>]` sets a secret, prompting for the value if `--value` is omitted.
- `launchpad secret:list [--project <name>]` lists names and versions (not values).
- `launchpad secret:rm <name> [--project <name>]` deletes a secret.

## Deployments

- `launchpad deploy [-f <file>] [--project <name>] [--version <version>] [--no-build-upload] [--no-wait] [--timeout <seconds>]` creates a deployment from a Compose file (default `docker-compose.yml`). It uploads the current directory as a build context unless `--no-build-upload`, and waits for convergence unless `--no-wait` (default timeout `300`). The version defaults to `git-<hash of the Compose file>`.
- `launchpad status` shows projects, recent deployments, nodes and per-node status.
- `launchpad events [--project <name>] [--limit <n>]` lists recent events (default `100`, max `500`).
- `launchpad rollback [--project <name>] [--force] [--no-wait] [--timeout <seconds>]` rolls back to the previous deployment; `--force` rolls back even while a deployment is active.
- `launchpad deploy:cancel <deploymentId>` cancels an active deployment.

## Services

- `launchpad restart <service> [--project <name>] [--timeout <seconds>]` restarts a service on its node and waits for the result (default `60`).
- `launchpad logs <service> [--project <name>] [--tail <n>]` fetches recent logs from the service's node (default `200` lines).

## Volumes

- `launchpad volume:list [--project <name>]` lists recorded volumes.
- `launchpad volume:rm <name> [--project <name>] [--delete-data]` removes a volume record; `--delete-data` also deletes the Docker volume on its node. See [Compose extensions](compose.md#volumes).

## Operations

- `launchpad doctor [--nodes] [--node <name>]` runs local, control-plane and optionally agent diagnostics. With the mesh on it also checks that every node has reported a WireGuard key, with ingress nodes that each is `serving`, and agent diagnostics add `wg` checks (version and `wg show wg0`, which includes latest handshakes) and the Caddy container state.
- `launchpad control-backup run` and `launchpad control-backup restore <artifactRef> --confirm` back up and restore the control plane. See [Control plane](control-plane.md#backup-and-restore).
