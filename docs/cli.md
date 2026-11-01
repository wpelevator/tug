# CLI reference

Run `tug --help` to list commands and `tug <command> --help` for command options, units and defaults. Commands are flat, with dash-separated names such as `node-install` and `secret-set`; there are no command groups, colon names or compatibility aliases.

## Arguments, options and configuration

A positional argument names the primary target: the SSH host for `node-install`, node for `node-register`, service for `logs`, secret name for `secret-set` or backup archive for `control-restore`. Named options qualify the operation. For example, `node-install root@app1.example.com --name app1` distinguishes the SSH destination from the registered node name. Commands reject unknown options and extra positional arguments instead of ignoring typos. Numeric options accept bounded integers; invalid values and contradictory options fail before an API request or Docker/SSH operation.

| Global option | Environment | Config key | Default |
|---|---|---|---|
| `--config <file>` | `TUG_CONFIG` | — | `tug.yml`, `tug.yaml`, `tug.json` or `.tug.json` in the current directory |
| `--control-url <url>` (operator API endpoint) | `TUG_CONTROL_URL` | `controlUrl` | `http://localhost:8080` |
| `--project <name>` | `TUG_PROJECT` | `project` | `site` |
| `--token <token>` on `init`/`control-install` | `TUG_TOKEN` | `token`, only in the untracked overlay | No API token; `init`/`control-install` generate one if needed |

Global options can appear before or after a command. Explicit options take precedence over environment variables, then the overlay, then the tracked config, then defaults. Relative `--config` paths resolve from the working directory. A missing default config is allowed; an explicitly selected missing file, invalid YAML or JSON, an unknown key or an invalid value is an error. `init` can create a new selected file. `--project` applies only to project-scoped operations; status and node operations retain their control-wide scope.

Most commands print the API result as JSON. `init` prints the written config path, `control-token` prints a token, `exec` and `logs` write container output to stdout/stderr, and enrollment prints a runnable command or cloud-init document. `ps` and `inspect` print live Docker data as JSON. `node-enroll --json` returns JSON with `command`, and also `cloudInit` with `--install-docker`; its stdout contains no explanatory prose. There is no global `--json` flag. Install preflight and image-transfer tools may also print progress. Errors go to stderr and exit nonzero.

Prefer `TUG_TOKEN` to a token argument, since arguments can appear in process listings and shell history. `secret-set --value` has the same exposure; omit it to read the value from stdin. The token belongs in the untracked overlay (see below), never in the tracked config.

Remote source uploads always exclude the overlay files (`tug.local.yml`, `tug.local.yaml`, `tug.local.json`, `.tug.local.json`) and `.tug.json` at any depth, the tracked config names (`tug.yml`, `tug.yaml`, `tug.json`) at the source root, and the selected config and overlay, even if an ignore rule attempts to include them. A nested `tug.json` that belongs to your application is kept. Local builds use Docker's own context and `.dockerignore`; exclude the overlay names and any custom credential-config path there before using a broad `COPY . .` instruction.

## Config file

The CLI reads a YAML or JSON file, `tug.yml` by convention, so a repository can record how to reach its control plane and which servers it uses. [`examples/tug.yml`](../examples/tug.yml) is a complete sample.

- **Lookup.** `--config` or `TUG_CONFIG` select a file, which must exist. Otherwise the working directory is searched for `tug.yml`, `tug.yaml`, `tug.json` and `.tug.json`; more than one is an error, and none is fine. The format follows the extension (`.json` is JSON, anything else YAML, which also reads JSON). Only the working directory is searched, not its parents.
- **Overlay.** `tug.local.yml` next to `tug.yml` (`.tug.local.json` next to `.tug.json`, `<name>.local<ext>` in general) holds what must not be committed. It has the same keys plus `token`, and its values win key by key, including inside `nodeDefaults` and each node. `token` in the tracked file is an error. `tug init` writes the tracked file only when it is missing (an existing one keeps its comments), stores the token in the overlay with mode `0600`, and adds the overlay to `.gitignore` in a git checkout. Connection flags given to `init` for an existing tracked file are saved in the overlay.
- **Strict keys.** Unknown keys, wrong types and out-of-range values fail with the file and key in the message. Paths in the file (`file`, `ca`) resolve relative to the file, not the working directory.

Each key is the camelCase of the long flag it supplies a default for, with the same value type. A repeatable flag takes a list (`label: [web, db]`; a single string is a one-item list), and a negated flag maps to the positive key set to `false` (`--no-wait` is `wait: false`). A flag on the command line always wins over the file; a list from the file is replaced by flags, not appended to. A key applies only to the commands listed for it.

| Key | Flag | Commands |
|---|---|---|
| `controlUrl` | `--control-url` | all |
| `project` | `--project` | project-scoped commands |
| `token` (overlay only) | `--token`, `TUG_TOKEN` | all |
| `file` | `-f, --file` | `deploy` |
| `buildLocal` | `--build-local` | `deploy` |
| `wait` | `--no-wait` | `deploy`, `rollback` |
| `nodes.<name>.ssh` | `<ssh-target>` | `node-install` |
| `nodes.<name>.address` | `--address` | `node-install`, `node-register` |
| `nodes.<name>.publicAddress` | `--public-address` | `node-install`, `node-register` |
| `label` | `--label` | `node-install`, `node-register`, `node-enroll` |
| `mesh` | `--mesh` | `node-install`, `node-enroll` |
| `wgPort` | `--wg-port` | `node-install` |
| `installDocker` | `--install-docker` | `node-install`, `node-enroll` |
| `image` | `--image` | `node-install`, `node-enroll` |
| `agentControlUrl` | `--agent-control-url` | `node-install`, `node-enroll` |
| `httpOnlyDev` | `--http-only-dev` | `node-install`, `node-enroll` |
| `ca` | `--ca` | `node-enroll` |

The rows from `label` down are node keys: set them under `nodes.<name>`, or once for every node under `nodeDefaults` (everything except `ssh`, `address` and `publicAddress`). Secrets and per-invocation choices have no key: `--value`, `--force`, `--confirm`, `--version`, `--ttl`, `--uses`, `--timeout`, `--build-local-image` and the like.

The file is not desired state and Tug never reconciles against it. Only `node-install`, `node-register` and `node-enroll` read `nodes`, as defaults for flags; every other command asks the control plane. See [Nodes](nodes.md#declaring-nodes-in-the-config-file).

## Setup

- `tug init [--token <token>]` creates the config file with the resolved control URL and project when it is missing and stores the token in the git-ignored overlay next to it; see [Config file](#config-file). Use global `--control-url`, `--project` or `--config` to select them.
- `tug control-install <ssh-target> [--mesh] [--install-docker] [--token <token>] [--port <port>] [--image <tag>] [--build-local-image]` installs control over SSH. The API port defaults to `8080`. Control stores built images and agents download them directly. See [Control plane](control-plane.md).
- `tug control-token` prints the local development operator token from `./data/operator.token`.

`--image` defaults to `ghcr.io/wpelevator/tug:<CLI version>`. `--build-local-image` builds and transfers the Tug runtime image from a checkout for development, tagging it `tug:local` unless `--image` is set. It is distinct from `deploy --build-local`, which builds application images. `--install-docker` explicitly installs missing Docker Engine and Compose on supported Debian, Ubuntu, Fedora and RHEL-compatible hosts; see [Nodes](nodes.md#bare-host-docker-installation). The image is built for the target host's architecture (read with `uname -m` over SSH), so an arm64 laptop can install an amd64 VPS; x86_64 and aarch64 hosts are supported.

## Nodes

- `tug node-install [<ssh-target>] --name <node> [--agent-control-url <url>] [--install-docker] [--address <ip>] [--public-address <ip>] [--label <label>]... [--mesh] [--wg-port <port>] [--image <tag>] [--build-local-image] [--http-only-dev]` registers a node and installs its agent. Without `<ssh-target>` the target is `nodes.<node>.ssh` from the [config file](#config-file). `--mesh` enables host networking and `NET_ADMIN` and adds WireGuard kernel and UDP-port checks; `--wg-port` defaults to `51820`.
- `tug node-enroll [--name <node>] [--agent-control-url <url>] [--install-docker] [--label <label>]... [--ttl <seconds>] [--uses <n>] [--ca <ca.pem>] [--image <tag>] [--mesh] [--json] [--http-only-dev]` mints an enrollment key and prints a Docker command, or cloud-init with `--install-docker`. TTL defaults to `3600` seconds and uses to `1`. Without `--name`, the host uses its hostname. The printed image must be pullable by the new host; a development `tug:local` override must already be loaded there.
- `tug node-remove <node> [--force]` removes a retired node: its agent token, WireGuard peer, statuses and queued commands. It is refused while a current deployment still places a service or volume on the node (deploy without it first) and while its agent is still reporting, unless `--force`. Stop the agent and remove its containers on the host yourself.
- `tug node-register <node> [--address <ip>] [--public-address <ip>] [--label <label>]...` registers a node and prints its tokens without installing it.
- `tug node-rotate-wg-key <node> [--timeout <seconds>]` requests a new WireGuard keypair and waits for the result; timeout defaults to `60` seconds.
- `tug node-ingress <node> [--disable]` enables the managed Caddy ingress role, or removes it with `--disable`.

Node installation and enrollment require an HTTPS control URL unless `--http-only-dev` is given for local/private development. A node without a public address can dial out to control. See [Nodes](nodes.md) and [Networking](networking.md).

`--control-url` always selects the operator API endpoint. `--agent-control-url` separately selects the endpoint written into the agent environment or enrollment key, defaulting to the resolved operator URL. Use it when the operator connects through a local SSH tunnel while nodes connect over a private network, for example `tug --control-url http://127.0.0.1:18082 node-install root@app1.example.com --name app1 --agent-control-url http://10.110.0.3:8080 --http-only-dev`. Registration still uses the tunnel; the node uses the private address. The HTTP override applies to the advertised agent URL.

## Secrets

- `tug secret-set <name> [--value <value>]` sets a secret, reading stdin if `--value` is omitted.
- `tug secret-list` lists names and versions, without values.
- `tug secret-remove <name>` deletes a secret.

## Backups

Backup commands are flat like the rest of the CLI, and need an admin token.

- `tug backup-destination-set <url> [--env NAME ...]` sets where backups go, for example `s3:https://s3.example.com/bucket/tug-backups` with `--env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY`. Each value is read from the environment variable of that name, otherwise from a line on stdin; it is never a command-line argument. S3 needs both AWS variables. Values are stored encrypted on control and released only to a node running a backup. An absolute path is accepted for development, but it is read on each node and is not shared. Setting a destination replaces the previous one.
- `tug backup-destination-show` prints the URL and the variable names, never values.
- `tug backup-destination-remove` removes the destination and its credentials. Existing backups stay in the repository.
- `tug backup-key` prints the project's repository and its password. Each project has its own restic repository at `<destination>/<project>` with a password derived from control's master key, so keep the printed password with the destination credentials: losing the master key loses every repository.

These operations use the resolved project.

## Deployments

- `tug deploy [-f, --file <file>] [--version <version>] [--build-local] [--no-wait] [--timeout <seconds>]` deploys Compose from `docker-compose.yml` by default. Services with `build:` upload the current directory for remote builds, or build on the operator's Docker daemon with `--build-local` and upload saved images without source. Published-image-only applications need no context upload. Control rejects a built service with no available build input. The display version defaults to `git-<Compose hash>`; deployment image identities are immutable even when that display version is reused. Local builds are single-platform and must match the target node architecture. Deployment waits for convergence by default, with a `300` second timeout; `--no-wait` returns once desired state is created. Needs Docker Compose v2 on the operator machine to normalize the file.
- `tug status` shows all projects, recent deployments, nodes and per-node status.
- `tug events [--limit <n>] [--all]` lists events in the resolved project, or in every project with `--all` (including control events that belong to no project, such as token changes); the limit defaults to `100`, with a maximum of `500`. Control actions show the `actor` token that caused them. Agents add a `service.*` event when a service changes, not on every poll: `pulling`, `starting`, `health_checking` and `serving` when a new revision, changed secrets or a changed rendered configuration are applied, one `failed` event when an apply fails, and one `serving` event when it recovers. Control deletes events older than 30 days and keeps at most 100,000; see [Configuration](configuration.md#control-plane).
- `tug rollback [--force] [--no-wait] [--timeout <seconds>]` rolls the resolved project back; `--force` permits rollback while a deployment is active. Waiting defaults to `300` seconds. Projects with `x-tug: { rollback: auto }` roll back failed deployments themselves; see [Compose extensions](compose.md#automatic-rollback).
- `tug deploy-cancel <deployment-id>` cancels an active deployment.

To build on a laptop and upload image archives, run `tug deploy --build-local -f docker-compose.yml`. To deploy CI-built images, push them to your registry and declare `image:`; control pins tags to digests before publishing the deployment. See [Private registry credentials](control-plane.md#published-images-and-private-registries).

Local builds use generated temporary image tags and remove those tags after saving each archive, including cleanup attempts after build/save failure. They do not remove your published image tags or the Tug runtime image. A refused cleanup produces a warning without hiding the original build error.

## API tokens

Scoped credentials for CI and teammates; see [Access control](access-control.md) for roles, scoping and a GitHub Actions example. All three commands need an admin token (or the operator token).

- `tug token-create <name> --role read|deploy|admin [--project <name> ...] [--expires-in-days <n>]` creates a token and prints it once on stdout. Repeat `--project` to allow several projects; without it the token covers all projects (admin tokens cannot be limited). Here `--project` selects the token's scope rather than the connection project. Names are 1 to 64 letters, numbers, dots, underscores or hyphens, and cannot be reused after revocation. Expiry is at most `3650` days and defaults to never.
- `tug token-list` lists tokens with role, projects, creator, last use, expiry and revocation, never secrets.
- `tug token-revoke <name>` revokes a token immediately.

Use a created token anywhere `TUG_TOKEN` works, for example `TUG_TOKEN=tug_tok_... tug deploy`.

## Services and volumes

- `tug restart <service> [--timeout <seconds>]` restarts a service and waits for the result; timeout defaults to `60` seconds.
- `tug scale <service> <replicas>` changes how many matching nodes run a service, spreading by count over nodes that carry the service's `placement.labels` (all nodes without labels), and updates the current desired state without a new deployment. `global` services run on every matching node and are scaled to that set. The next `deploy` re-resolves placement from the Compose file.
- `tug exec <service> [-i, --interactive] [-t, --tty] [--node <name>] [-- <command> ...]` executes a command in the current service container, defaulting to `sh`. Arguments are passed directly without a shell. `-i` forwards stdin. `-t` requires a local terminal but currently fails explicitly because the agent runtime has no PTY backend; use non-TTY `-i` for interactive programs until PTY support lands. Use `--node` when a service has more than one placement.
- `tug logs <service> [--tail <n>] [-f, --follow] [--node <name>]` fetches recent service logs through the durable command queue, or follows them live with `-f`; the default is `200` lines. `--node` applies to followed logs and is required when the service has more than one eligible node.
- `tug ps [--node <name>]` prints live per-container state as JSON. Without `--node`, the project must resolve to exactly one eligible connected node.
- `tug inspect <service> [--node <name>]` prints the live Docker inspection object as JSON. It can include container environment variables, so it requires the `deploy` role and should be handled as sensitive output. Use `--node` when a service has more than one placement.
- `tug volume-list` lists recorded volumes.
- `tug volume-remove <name> [--delete-data]` removes a volume record; `--delete-data` also removes the Docker volume on its node. See [Compose extensions](compose.md#volumes).

These operations use the resolved project. Live operations use an authenticated WebSocket from the CLI through control to the agent's existing outbound connection. They are ephemeral: control does not queue or replay them, and disconnecting any hop closes the local session. Cancelling or disconnecting `exec` kills the agent's Docker client, but an already-started process inside the container may continue because the Docker exec stream does not expose a remote process identifier.

## Operations

- `tug doctor [--nodes] [--node <name>] [--timeout <seconds>]` runs local and control diagnostics. `--nodes` runs agent diagnostics on every node and `--node` selects one; both wait for the agent result (timeout defaults to `60` seconds) instead of returning the queued command id. An unknown `--node` is an error. Mesh checks include WireGuard keys and ingress status. Agent diagnostics include `ports.public`, a warning listing containers of Tug projects that listen on all interfaces or a public IP ([Networking](networking.md#published-ports-private-by-default)).
- `tug control-backup` creates a control-plane backup including retained built-image archives.
- `tug control-restore <artifact-path> --confirm` restores a backup and requires control restart. The archive path is on the control host. See [Control plane](control-plane.md#backup-and-restore).

## CLI architecture and naming

The interface follows the relevant conventions used by `wp-release`: one flat operation per command; kebab-case command/flag names; primary targets as positional arguments; named qualifiers with consistent meanings; and positive camelCase internal options (`--no-wait` becomes `wait: false`, never `noWait`). New structured CLI results use camelCase; API responses printed unchanged may retain their existing database field names. Help, docs and tests must change together when the interface changes.

CLI adapters resolve configuration, parse arguments and format results. Build, archive, installation and API primitives receive explicit values and injectable runners; they do not discover CLI config or read unrelated environment variables. Keep domain logic in ordinary module functions, and introduce stateful classes only when a multi-step workflow needs shared state/dependencies. Only operations that use Docker or SSH should require those tools. Validation must complete before side effects, and stdout intended as a runnable artifact or JSON must remain directly usable. These conventions do not imply GitHub Actions logging or additional output modes.
