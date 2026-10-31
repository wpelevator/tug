# CLI reference

Run `tug --help` to list commands and `tug <command> --help` for command options, units and defaults. Commands are flat, with dash-separated names such as `node-install` and `secret-set`; there are no command groups, colon names or compatibility aliases.

## Arguments, options and configuration

A positional argument names the primary target: the SSH host for `node-install`, node for `node-register`, service for `logs`, secret name for `secret-set` or backup archive for `control-restore`. Named options qualify the operation. For example, `node-install root@app1.example.com --name app1` distinguishes the SSH destination from the registered node name. Commands reject unknown options and extra positional arguments instead of ignoring typos. Numeric options accept bounded integers; invalid values and contradictory options fail before an API request or Docker/SSH operation.

| Global option | Environment | Config key | Default |
|---|---|---|---|
| `--config <file>` | `TUG_CONFIG` | — | `.tug.json` in the current directory |
| `--control-url <url>` (operator API endpoint) | `TUG_CONTROL_URL` | `controlUrl` | `http://localhost:8080` |
| `--project <name>` | `TUG_PROJECT` | `project` | `site` |
| `--token <token>` on `init`/`control-install` | `TUG_TOKEN` | `operatorToken` for API calls | No API token; `init`/`control-install` generate one if needed |

Global options can appear before or after a command. Explicit options take precedence over environment variables, then the selected config, then defaults. Relative config paths resolve from the working directory. A missing default `.tug.json` is allowed; an explicitly selected missing file, invalid JSON or invalid known setting is an error. `init` can create a new selected file. `--project` applies only to project-scoped operations; status and node operations retain their control-wide scope.

Most commands print the API result as JSON. `init` prints the written config path, `control-token` prints a token, `logs` writes service output to stdout/stderr, and enrollment prints a runnable command or cloud-init document. `node-enroll --json` returns JSON with `command`, and also `cloudInit` with `--install-docker`; its stdout contains no explanatory prose. There is no global `--json` flag. Install preflight and image-transfer tools may also print progress. Errors go to stderr and exit nonzero.

Prefer `TUG_TOKEN` to a token argument, since arguments can appear in process listings and shell history. `secret-set --value` has the same exposure; omit it to read the value from stdin. Config files contain the operator token and should be kept private and out of version control.

Remote source uploads always exclude `.tug.json` files and the selected CLI config inside the source directory, even if an ignore rule attempts to include them. Local builds use Docker's own context and `.dockerignore`; exclude `.tug.json` and any custom credential-config path there before using a broad `COPY . .` instruction.

## Setup

- `tug init [--token <token>]` writes the selected config with the resolved control URL, project and token. Use global `--control-url`, `--project` or `--config` to select them.
- `tug control-install <ssh-target> [--install-docker] [--registry <host>] [--token <token>] [--port <port>] [--image <tag>] [--build-local-image] [--registry-auth-path <path>] [--registry-container <name>]` installs control over SSH. The API port defaults to `8080`. A registry is optional; without one, control stores built images and agents download them directly. Registry credential-management options require `--registry`. See [Control plane](control-plane.md).
- `tug control-token` prints the local development operator token from `./data/operator.token`.

`--image` defaults to `ghcr.io/wpelevator/tug:<CLI version>`. `--build-local-image` builds and transfers the Tug runtime image from a checkout for development, tagging it `tug:local` unless `--image` is set. It is distinct from `deploy --build-local`, which builds application images. `--install-docker` explicitly installs missing Docker Engine and Compose on supported Debian/Ubuntu hosts; see [Nodes](nodes.md#bare-host-docker-installation).

## Nodes

- `tug node-install <ssh-target> --name <node> [--agent-control-url <url>] [--install-docker] [--address <ip>] [--public-address <ip>] [--registry <host>] [--mesh] [--wg-port <port>] [--image <tag>] [--build-local-image] [--http-only-dev]` registers a node and installs its agent. `--mesh` enables host networking and `NET_ADMIN` and adds WireGuard kernel and UDP-port checks; `--wg-port` defaults to `51820`.
- `tug node-enroll [--name <node>] [--agent-control-url <url>] [--install-docker] [--ttl <seconds>] [--uses <n>] [--ca <ca.pem>] [--image <tag>] [--mesh] [--json] [--http-only-dev]` mints an enrollment key and prints a Docker command, or cloud-init with `--install-docker`. TTL defaults to `3600` seconds and uses to `1`. Without `--name`, the host uses its hostname. The printed image must be pullable by the new host; a development `tug:local` override must already be loaded there.
- `tug node-register <node> [--address <ip>] [--public-address <ip>]` registers a node and prints its tokens without installing it.
- `tug node-rotate-wg-key <node> [--timeout <seconds>]` requests a new WireGuard keypair and waits for the result; timeout defaults to `60` seconds.
- `tug node-ingress <node> [--disable]` enables the managed Caddy ingress role, or removes it with `--disable`.
- `tug node-rotate-registry-token <node>` and `tug node-revoke-registry-token <node>` manage registry pull tokens.

Node installation and enrollment require an HTTPS control URL unless `--http-only-dev` is given for local/private development. A node without a public address can dial out to control. See [Nodes](nodes.md) and [Networking](networking.md).

`--control-url` always selects the operator API endpoint. `--agent-control-url` separately selects the endpoint written into the agent environment or enrollment key, defaulting to the resolved operator URL. Use it when the operator connects through a local SSH tunnel while nodes connect over a private network, for example `tug --control-url http://127.0.0.1:18082 node-install root@app1.example.com --name app1 --agent-control-url http://10.110.0.3:8080 --http-only-dev`. Registration still uses the tunnel; the node uses the private address. The HTTP override applies to the advertised agent URL.

## Secrets

- `tug secret-set <name> [--value <value>]` sets a secret, reading stdin if `--value` is omitted.
- `tug secret-list` lists names and versions, without values.
- `tug secret-remove <name>` deletes a secret.

These operations use the resolved project.

## Deployments

- `tug deploy [-f, --file <file>] [--version <version>] [--build-local | --no-build-upload] [--no-wait] [--timeout <seconds>]` deploys Compose from `docker-compose.yml` by default. Services with `build:` upload the current directory for remote builds, or build on the operator's Docker daemon with `--build-local` and upload saved images without source. Published-image-only applications need no context upload. `--no-build-upload` skips source upload; it cannot be combined with `--build-local`. Control rejects a built service with no available build input. The display version defaults to `git-<Compose hash>`; deployment image identities are immutable even when that display version is reused. Local builds are single-platform and must match the target node architecture. Deployment waits for convergence by default, with a `300` second timeout; `--no-wait` returns once desired state is created.
- `tug status` shows all projects, recent deployments, nodes and per-node status.
- `tug events [--limit <n>]` lists events in the resolved project; the limit defaults to `100`, with a maximum of `500`.
- `tug rollback [--force] [--no-wait] [--timeout <seconds>]` rolls the resolved project back; `--force` permits rollback while a deployment is active. Waiting defaults to `300` seconds.
- `tug deploy-cancel <deployment-id>` cancels an active deployment.

To build on a laptop and deploy without a registry: `tug deploy --build-local -f docker-compose.yml`. To use an existing registry, configure it on control with `control-install --registry <host>`; local builds are uploaded to control and pushed through that registry too.

Local builds use generated temporary image tags and remove those tags after saving each archive, including cleanup attempts after build/save failure. They do not remove your published image tags or the Tug runtime image. A refused cleanup produces a warning without hiding the original build error.

## Services and volumes

- `tug restart <service> [--timeout <seconds>]` restarts a service and waits for the result; timeout defaults to `60` seconds.
- `tug logs <service> [--tail <n>]` fetches recent service logs; the default is `200` lines.
- `tug volume-list` lists recorded volumes.
- `tug volume-remove <name> [--delete-data]` removes a volume record; `--delete-data` also removes the Docker volume on its node. See [Compose extensions](compose.md#volumes).

These operations use the resolved project.

## Operations

- `tug doctor [--nodes] [--node <name>]` runs local and control diagnostics; `--nodes` queues agent diagnostics for all nodes and `--node` selects one. Mesh checks include WireGuard keys and ingress status.
- `tug control-backup` creates a control-plane backup including retained built-image archives.
- `tug control-restore <artifact-path> --confirm` restores a backup and requires control restart. The archive path is on the control host. See [Control plane](control-plane.md#backup-and-restore).

## CLI architecture and naming

The interface follows the relevant conventions used by `wp-release`: one flat operation per command; kebab-case command/flag names; primary targets as positional arguments; named qualifiers with consistent meanings; and positive camelCase internal options (`--no-wait` becomes `wait: false`, never `noWait`). New structured CLI results use camelCase; API responses printed unchanged may retain their existing database field names. Help, docs and tests must change together when the interface changes.

CLI adapters resolve configuration, parse arguments and format results. Build, archive, installation and API primitives receive explicit values and injectable runners; they do not discover CLI config or read unrelated environment variables. Keep domain logic in ordinary module functions, and introduce stateful classes only when a multi-step workflow needs shared state/dependencies. Only operations that use Docker or SSH should require those tools. Validation must complete before side effects, and stdout intended as a runnable artifact or JSON must remain directly usable. These conventions do not imply GitHub Actions logging or additional output modes.
