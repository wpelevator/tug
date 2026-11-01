# CLI reference

Run `tug --help` to list commands and `tug <command> --help` for command options, units and defaults. Commands are flat, with dash-separated names such as `node-install` and `secret-set`; there are no command groups, colon names or compatibility aliases.

## Arguments, options and configuration

A positional argument names the primary target: the SSH host for `node-install`, node for `node-register`, service for `logs`, secret name for `secret-set` or backup archive for `control-restore`. Named options qualify the operation. For example, `node-install root@app1.example.com --name app1` distinguishes the SSH destination from the registered node name. Commands reject unknown options and extra positional arguments instead of ignoring typos. Numeric options accept bounded integers; invalid values and contradictory options fail before an API request or Docker/SSH operation.

| Global option | Environment | Config key | Default |
|---|---|---|---|
| `--config <file>` | `TUG_CONFIG` | — | `tug.yml`, `tug.yaml`, `tug.json` or `.tug.json` in the current directory |
| `--control-url <url>` (operator API endpoint) | `TUG_CONTROL_URL` | `controlUrl` | the credential's public URL (an override is a connect target only) |
| `--project <name>` | `TUG_PROJECT` | `project` | `site` |
| `--credential <file>` | `TUG_CREDENTIAL` (inline) or `TUG_CREDENTIAL_FILE` | `credential` (a file path), only in the untracked overlay | No credential |

Global options can appear before or after a command. Explicit options take precedence over environment variables, then the overlay, then the tracked config, then defaults. Relative `--config` paths resolve from the working directory. A missing default config is allowed; an explicitly selected missing file, invalid YAML or JSON, an unknown key or an invalid value is an error. `init` can create a new selected file. `--project` applies only to project-scoped operations; status and node operations retain their control-wide scope.

Most commands print the API result as JSON. `init` prints the written config path, `exec` and `logs` write container output to stdout/stderr, and enrollment prints a runnable command or cloud-init document. `ps` and `inspect` print live Docker data as JSON. `node-enroll --json` returns JSON with `command`, and also `cloudInit` with `--install-docker`; its stdout contains no explanatory prose. There is no global `--json` flag. Install preflight and image-transfer tools may also print progress. Errors go to stderr and exit nonzero.

Credentials are never command-line arguments, since arguments can appear in process listings and shell history; use `TUG_CREDENTIAL`, `TUG_CREDENTIAL_FILE` or `tug init`. `secret-set --value` has the same exposure; omit it to read the value from stdin. The credential path belongs in the untracked overlay (see below), never in the tracked config.

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
| `credential` (overlay only) | `--credential`, `TUG_CREDENTIAL_FILE` | all |
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

The rows from `label` down are node keys: set them under `nodes.<name>`, or once for every node under `nodeDefaults` (everything except `ssh`, `address` and `publicAddress`). Secrets and per-invocation choices have no key: `--value`, `--force`, `--confirm`, `--version`, `--ttl`, `--timeout`, `--build-local-image` and the like.

The file is not desired state and Tug never reconciles against it. Only `node-install`, `node-register` and `node-enroll` read `nodes`, as defaults for flags; every other command asks the control plane. See [Nodes](nodes.md#declaring-nodes-in-the-config-file).

## Setup

- `tug init [<credential-file>|-]` creates the config file with the resolved control URL and project when it is missing, imports the credential (a file, or `-` for stdin) into a `0600` file under `~/.config/tug/credentials/` and points the git-ignored overlay next to the config at it; see [Config file](#config-file). Use global `--control-url`, `--project` or `--config` to select them.
- `tug control-install <ssh-target> --public-url <https-origin> [--extra-san <name>]... [--mesh] [--install-docker] [--port <port>] [--image <tag>] [--build-local-image] [--credential-out <file>] [--recover-root]` installs control over SSH and, on a fresh install, issues the root credential straight into a `0600` local file. The mTLS port defaults to `8443`. `--recover-root` replaces only root's key from the control host. See [Control plane](control-plane.md).
- `tug node-disable <node>` blocks a node's key immediately without SSH, deleting or changing placement; `node-replace` brings it back.
- `tug node-install|node-replace|node-repair [<ssh-target>] --name <node> [--all] [--agent-control-url <url>] [--install-docker] [--address <ip>] [--public-address <ip>] [--label <label>]... [--mesh] [--wg-port <port>] [--image <tag>] [--build-local-image] [--no-wait]` runs the SSH-assisted identity flow (`create`, or `replace` for the latter two; `node-repair` first moves corrupt agent credential documents aside). Without `<ssh-target>` the target is `nodes.<node>.ssh` from the [config file](#config-file); `--all` walks every node with an `ssh` entry, continues after failures and prints per-node results. `--mesh` enables host networking and `NET_ADMIN` and adds WireGuard kernel and UDP-port checks; `--wg-port` defaults to `51820`. See [Nodes](nodes.md).
- `tug node-register <node> --csr <file> [--mode create|replace]` signs a node-generated CSR and prints the identity response.
- `tug node-enroll --name <node> [--agent-control-url <url>] [--install-docker] [--label <label>]... [--ttl <seconds>] [--image <tag>] [--mesh] [--json]` mints a single-use, name-bound join key and prints a Docker command, or cloud-init with `--install-docker`. TTL defaults to `3600` seconds. A saved cloud-init document contains a credential. The printed image must be pullable by the new host; a development `tug:local` override must already be loaded there.
- `tug node-remove <node> [--force]` removes a retired node: its agent token, WireGuard peer, statuses and queued commands. It is refused while a current deployment still places a service or volume on the node (deploy without it first) and while its agent is still reporting, unless `--force`. Stop the agent and remove its containers on the host yourself.
- `tug node-register <node> [--address <ip>] [--public-address <ip>] [--label <label>]...` registers a node and prints its tokens without installing it.
- `tug node-rotate-wg-key <node> [--timeout <seconds>]` requests a new WireGuard keypair and waits for the result; timeout defaults to `60` seconds.
- `tug node-ingress <node> [--disable]` enables the managed Caddy ingress role, or removes it with `--disable`.

Every control URL, including overrides, must be `https://`. A node without a public address can dial out to control. See [Nodes](nodes.md) and [Networking](networking.md).

`--control-url` selects where the operator CLI connects and `--agent-control-url` where the agent connects; both are connect targets only, and the certificate is always verified against the credential's public URL (DNS or IP). Use them when the operator connects through a local SSH tunnel while nodes connect over a private network, for example `tug --control-url https://127.0.0.1:18082 node-install root@app1.example.com --name app1 --agent-control-url https://10.110.0.3:8443`.

## Secrets

- `tug secret-set <name> [--value <value>]` sets a secret, reading stdin if `--value` is omitted.
- `tug secret-list` lists names and versions, without values.
- `tug secret-remove <name>` deletes a secret.

## Backups

Backup commands are flat like the rest of the CLI, and need an admin token.

- `tug backup-destination-set <url> [--env NAME ...]` sets where backups go, for example `s3:https://s3.example.com/bucket/tug-backups` with `--env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY`. Each value is read from the environment variable of that name, otherwise from a line on stdin; it is never a command-line argument. S3 needs both AWS variables. Values are stored encrypted on control and released only to a node running a backup. An absolute path is accepted for development, but it is read on each node and is not shared. Setting a destination replaces the previous one.
- `tug backup-run [targets...] [--no-wait] [--timeout <seconds>]` backs up the named services or volumes now, or every backup target of the project, and waits for the result. It exits nonzero if any backup fails or is missed. Needs the `deploy` role.
- `tug backup-list [--limit <n>] [--check]` shows each backup target with its node, schedule, last success and next run, then the most recent runs. With `--check` it also prints a `PROBLEM` line for each target that is stale (no success for two periods), whose last run failed or was missed, or when no destination is configured, and exits nonzero, so cron or a monitor can alert without parsing output. Needs the `read` role.
- `tug restore <target> [--from <id|latest>] [--scratch] [--no-safety-backup] [--writers <service>...] [--no-writers] [--confirm]` restores a service or volume. Without `--confirm` it prints the plan and changes nothing. `--from` takes a backup run id, a restic snapshot id or `latest`. See [Restore](backups.md#restore). It waits until the services it stopped report serving again (up to five minutes, then it finishes with a warning). Needs an admin token.
- `tug restore-list` shows recent restores; `tug restore-resume <id>` runs an interrupted one again; `tug restore-release <id>` starts the services it stopped and unlocks the project.
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

Scoped credentials for CI and teammates; see [Access control](access-control.md) for roles, scoping and a GitHub Actions example. All three commands need an admin credential.

- `tug token-create <name> --role read|deploy|admin [--project <name> ...] [--expires-in-days <n>]` creates a token and prints it once on stdout. Repeat `--project` to allow several projects; without it the token covers all projects (admin tokens cannot be limited). Here `--project` selects the token's scope rather than the connection project. Names are 1 to 64 letters, numbers, dots, underscores or hyphens, and cannot be reused after revocation. Expiry is at most `3650` days and defaults to never.
- `tug token-list` lists tokens with role, projects, creator, last use, expiry and revocation, never secrets.
- `tug token-revoke <name>` revokes a token immediately.

Use a created credential anywhere a credential works, for example `TUG_CREDENTIAL=<credential> tug deploy`.

## Services and volumes

- `tug restart <service> [--timeout <seconds>]` restarts a service and waits for the result; timeout defaults to `60` seconds.
- `tug scale <service> <replicas>` changes how many matching nodes run a service, spreading by count over nodes that carry the service's `placement.labels` (all nodes without labels), and updates the current desired state without a new deployment. `global` services run on every matching node and are scaled to that set. The next `deploy` re-resolves placement from the Compose file.
- `tug exec <service> [-i, --interactive] [-t, --tty] [--node <name>] [-- <command> ...]` executes a command in the current service container, defaulting to `sh`. Arguments are passed directly without a shell. `-i` forwards stdin. `-t` allocates a terminal (with resize) and requires a local terminal. Use `--node` when a service has more than one placement.
- `tug run <service> [--node <name>] -- <command> ...` runs a one-off command in a new container instead of the running one: the service's image, environment (secrets included), user, working directory, network and volume mounts, no published ports, removed when it ends. It is for jobs that should not run inside the live container, such as `tug run web -- wp core update-db`. It is non-interactive, exits with the command's exit code, needs the `deploy` role and is recorded as a `job.run` event with its command line. Mounts are shared with the service, so a destructive command is the operator's responsibility; the one-off container does not take the project lock.
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
