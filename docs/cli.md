# CLI reference

Commands that take `--project` default to the project in `.tug.json`, then `site`. Most commands print the control API response as JSON.

## Setup

- `tug init [--control-url <url>] [--token <token>] [--project <name>]` writes `.tug.json`. Defaults: `http://localhost:8080`, `$TUG_TOKEN` or a new token, `site`.
- `tug control install <sshTarget> --registry <host> [--token <token>] [--port <port>] [--image <tag>] [--build-local-image] [--registry-auth-path <path>] [--registry-container <name>]` installs the control plane over SSH. `--image` defaults to `ghcr.io/wpelevator/tug:<CLI version>`; `--build-local-image` builds and copies a local image instead (development). See [Control plane](control-plane.md).
- `tug control:token` prints the local development operator token from `./data/operator.token`.

## Nodes

- `tug node install <sshTarget> --name <node> [--address <ip>] [--public-address <ip>] [--control-url <url>] [--registry <host>] [--mesh] [--wg-port <port>] [--image <tag>] [--build-local-image] [--http-only-dev]` registers a node and installs its agent over SSH. `--image` and `--build-local-image` work as for `control install`. `--mesh` runs the agent with host networking and `NET_ADMIN` for the WireGuard mesh and adds kernel and UDP-port preflight checks.
- `tug node enroll [--name <node>] [--control-url <url>] [--ttl <seconds>] [--uses <n>] [--ca <ca.pem>] [--image <tag>] [--mesh] [--json] [--http-only-dev]` mints an enrollment key and prints a `docker run` for the host, using `ghcr.io/wpelevator/tug:<CLI version>` unless `--image` is given.
- `tug node:register --name <node> [--address <ip>] [--public-address <ip>]` registers a node and prints its tokens.
- `tug node:rotate-wg-key <node> [--timeout <seconds>]` has the node generate a new WireGuard keypair and waits for the result; peers pick up the new public key on their next poll.
- `tug node:ingress <node> [--disable]` marks a node as an ingress node (managed Caddy), or removes the role.
- `tug node:rotate-registry-token <node>` and `tug node:revoke-registry-token <node>` manage registry pull tokens.

See [Nodes](nodes.md) and [Networking](networking.md).

## Secrets

- `tug secret:set <name> [--value <value>] [--project <name>]` sets a secret, prompting for the value if `--value` is omitted.
- `tug secret:list [--project <name>]` lists names and versions (not values).
- `tug secret:rm <name> [--project <name>]` deletes a secret.

## Deployments

- `tug deploy [-f <file>] [--project <name>] [--version <version>] [--no-build-upload] [--no-wait] [--timeout <seconds>]` creates a deployment from a Compose file (default `docker-compose.yml`). It uploads the current directory as a build context unless `--no-build-upload`, and waits for convergence unless `--no-wait` (default timeout `300`). The version defaults to `git-<hash of the Compose file>`.
- `tug status` shows projects, recent deployments, nodes and per-node status.
- `tug events [--project <name>] [--limit <n>]` lists recent events (default `100`, max `500`).
- `tug rollback [--project <name>] [--force] [--no-wait] [--timeout <seconds>]` rolls back to the previous deployment; `--force` rolls back even while a deployment is active.
- `tug deploy:cancel <deploymentId>` cancels an active deployment.

## Services

- `tug restart <service> [--project <name>] [--timeout <seconds>]` restarts a service on its node and waits for the result (default `60`).
- `tug logs <service> [--project <name>] [--tail <n>]` fetches recent logs from the service's node (default `200` lines).

## Volumes

- `tug volume:list [--project <name>]` lists recorded volumes.
- `tug volume:rm <name> [--project <name>] [--delete-data]` removes a volume record; `--delete-data` also deletes the Docker volume on its node. See [Compose extensions](compose.md#volumes).

## Operations

- `tug doctor [--nodes] [--node <name>]` runs local, control-plane and optionally agent diagnostics. With the mesh on it also checks that every node has reported a WireGuard key, with ingress nodes that each is `serving`, and agent diagnostics add `wg` checks (version and `wg show wg0`, which includes latest handshakes) and the Caddy container state.
- `tug control-backup run` and `tug control-backup restore <artifactRef> --confirm` back up and restore the control plane. See [Control plane](control-plane.md#backup-and-restore).
