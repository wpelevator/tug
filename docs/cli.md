# CLI reference

Every `tug` command and flag, grouped by task. Run `tug --help` for the command list and `tug <command> --help` for options, units and defaults.

```sh
tug node add --help
```

Commands read `tug <subject> <verb> [params]`, such as `tug node add` and `tug secret set`. Everyday project commands (`deploy`, `status`, `logs`, `exec`) stay at the top level, and `tug setup` is a shortcut for `tug control setup`. Commands reject unknown flags and extra arguments, and fail on contradictory or out-of-range values before any API request, Docker call or SSH operation.

## Commands at a glance

| I want to | Command | Section |
| --- | --- | --- |
| Install control, import a credential | `setup`, `init`, `control setup`, `control migrate` | [Setup](#setup) |
| Upgrade control and nodes | `upgrade`, `control upgrade`, `node upgrade` | [Setup](#setup), [Upgrade](upgrades.md) |
| Add, change or remove a server | `node add`, `list`, `replace`, `repair`, `remove`, `disable`, `ingress`, `address`, `register`, `enroll`, `migrate` | [Nodes](#nodes) |
| Check a Compose file offline | `lint` | [Deployments](#deployments) |
| Deploy, undo, cancel | `deploy`, `rollback`, `deploy cancel` | [Deployments](#deployments) |
| See what is running | `status`, `ps`, `events`, `tui`, `doctor` | [Deployments](#deployments), [Operations](#operations) |
| Read logs, open a shell, run a job | `logs`, `exec`, `run`, `inspect` | [Services and volumes](#services-and-volumes) |
| Restart, scale, free held services, prune builds | `restart`, `scale`, `hold release`, `image prune` | [Services and volumes](#services-and-volumes) |
| Manage volumes | `volume list`, `volume remove` | [Services and volumes](#services-and-volumes) |
| Manage values, and see which ones a file needs | `secret`, `var`, `values`, `registry login` | [Secrets and variables](#secrets-and-variables) |
| Map extra hostnames | `domain add`, `list`, `remove` | [Secrets and variables](#secrets-and-variables) |
| Read the edge's logs, see which hosts have a certificate | `ingress logs`, `ingress tls` | [Ingress](#ingress) |
| Back up and restore | `backup`, `restore` | [Backups](#backups) |
| Back up and restore control | `control backup`, `control restore` | [Operations](#operations) |
| Give CI or a teammate access | `credential create`, `list`, `revoke` | [Operator credentials](#operator-credentials) |

## Arguments, options and configuration

A positional argument names the primary target: the SSH host for `node add`, the service for `logs`, the secret for `secret set`. Named options qualify the operation, so `node add root@app1.example.com --name app1` separates the SSH destination from the node name.

| Global option | Environment | Config key | Default |
| --- | --- | --- | --- |
| `--config <file>` | `TUG_CONFIG` | none | `tug.yml`, `tug.yaml`, `tug.json` or `.tug.json` in the current directory |
| `--control-url <url>` | `TUG_CONTROL_URL` | `controlUrl` | The credential's address. An override is a connect target only |
| `--project <name>` | `TUG_PROJECT` | `project` | The Compose file's `name:`, else its directory name, see [Which project](configuration.md#which-project) |
| `--credential <file>` | `TUG_CREDENTIAL` (inline), `TUG_CREDENTIAL_FILE` | `credential`, only in the untracked overlay | none |
| `--verbose` | `TUG_VERBOSE=1` | none | off, see [Progress](#progress-and-quiet-steps) |

- **Precedence.** Flags, then environment variables, then the overlay, then the tracked config, then defaults. Global options go before or after the command.
- **Project scope.** `--project` applies to project-scoped commands. `status` and node commands are control-wide.
- **Control URLs** must be `https://`.
- **Credentials are never arguments**, because arguments show up in process listings and shell history. Use `TUG_CREDENTIAL`, `TUG_CREDENTIAL_FILE` or `tug init`. `secret set --value` has the same exposure, so omit it to read the value from stdin.
- **List flags.** `deploy --move`, `restore run --writers`, `credential create --project`, `node add|replace|repair|register|enroll --label`, `control setup --extra-san` and `backup destination set --env` take a comma-separated list, a repeated flag, or both: `--move db,web` equals `--move db --move web`. Values are names and cannot contain a comma.

### Output and exit codes

Errors go to stderr and exit nonzero. Progress goes to stderr, so stdout stays usable for JSON and for runnable output.

| Command | Default output | With `--json` |
| --- | --- | --- |
| `status`, `node list`, `deploy`, `rollback`, `scale`, `lint` | A readable summary | One JSON document |
| `init` | A summary | `{ ok, files, credentialFile }` |
| `backup run` | A summary | `{ ok, queued, errors, finished }` |
| `backup list` | Targets and runs | The catalog. `--check` still sets the exit code |
| `restore run`, `restore list` | The plan or list | The plan, plus the restore record when it ran |
| `events` | A table | `{ events }` |
| `doctor` | One line per check | The full diagnostics document |
| `ps` | A table | Docker's container list |
| `node enroll` | A runnable command or cloud-init document | JSON with `command`, plus `cloudInit` with `--install-docker`. Stdout has no explanatory prose |
| `exec`, `run`, `logs` | Container output unchanged | No `--json` |
| `inspect` | Live Docker data as JSON | Same |

Every command that produces a result takes `--json`, except `exec`, `run` and `logs`, which write container output unchanged. Commands not in the table print the API result as JSON already and accept the flag for consistency. There is no global `--json` flag, so put it after the command. `-y` is the short form of `--yes`.

## Config file

The CLI reads a YAML or JSON file, `tug.yml` by convention, so a repository can record how to reach its control plane and which servers it uses. [`examples/tug.yml`](https://github.com/wpelevator/tug/blob/main/examples/tug.yml) is a complete sample.

| Rule | Behavior |
| --- | --- |
| Lookup | `--config` or `TUG_CONFIG` select a file, which must exist. Otherwise only the working directory is searched, not its parents, for `tug.yml`, `tug.yaml`, `tug.json` and `.tug.json`. More than one is an error and none is fine. When a command needs a credential and finds no config, the error names the nearest parent directory that has one |
| Format | `.json` is JSON. Anything else is YAML, which also reads JSON |
| Overlay | `tug.local.yml` next to `tug.yml` (`.tug.local.json` next to `.tug.json`, `<name>.local<ext>` in general) holds what must not be committed. It has the same keys plus `credential` (a path to a credential file), and its values win key by key, including inside `nodeDefaults` and each node. `credential` in the tracked file is an error |
| `tug init` | Writes the tracked file only when it is missing, so an existing one keeps its comments (it appends `project:` when the file has none and the project came from the Compose file). The new file always has `project:`. It saves the credential with mode `0600` under `~/.config/tug/credentials/`, points the overlay at it and adds the overlay to `.gitignore` in a git checkout |
| Strict keys | Unknown keys, wrong types and out-of-range values fail with the file and key. Paths in the file (`file`, `ca`) resolve relative to the file |
| Not desired state | tug never reconciles against the file. Only the node commands that install or register read `nodes`, as flag defaults. See [Nodes](nodes.md#declaring-nodes-in-the-config-file) |

Each key is the camelCase of the long flag it supplies a default for, with the same value type. A flag on the command line wins. A list from the file is replaced by flags, not appended to. A repeatable flag takes a list (`label: [web, db]`), and a negated flag maps to the positive key set to `false` (`--no-wait` is `wait: false`).

| Key | Flag | Commands |
| --- | --- | --- |
| `controlUrl` | `--control-url` | All. `control setup` also advertises it and writes it into control's environment |
| `controlSsh` | `<ssh-target>` of the control host | `control upgrade`, `control stop`, `control restart`, `upgrade` |
| `project` | `--project` | Project-scoped commands |
| `credential` (overlay only) | `--credential` | All |
| `file` | `-f, --file` | `deploy`, `lint`, `values` |
| `buildLocal` | `--build-local` | `deploy` |
| `profile` | `--profile` | `deploy` |
| `wait` | `--no-wait` | `deploy`, `rollback`, `backup run`, `node add`, `replace`, `repair`, `migrate`, `upgrade` |
| `nodes.<name>.ssh` | `<ssh-target>` | `node add`, `replace`, `repair`, `migrate`, `upgrade` |
| `nodes.<name>.address` | `--address` | `node add`, `replace`, `repair`, `register`, `enroll` |
| `label` | `--label` | `node add`, `replace`, `repair`, `register`, `enroll` |
| `installDocker` | `--install-docker` | `node add`, `replace`, `repair`, `enroll`, `control setup` |
| `image` | `--image` | `node add`, `replace`, `repair`, `migrate`, `upgrade`, `enroll`, `control setup`, `control upgrade` |
| `agentControlUrl` | `--agent-control-url` | `node add`, `replace`, `repair`, `migrate`, `upgrade`, `enroll` |

The rows from `label` down are node keys. Set them under `nodes.<name>`, or once for every node under `nodeDefaults` (everything except `ssh` and `address`). Secrets and per-invocation choices have no key: `--value`, `--force`, `--confirm`, `--version`, `--to`, `--ttl`, `--timeout`, `--build-local-image`.

### Where control is

`controlUrl` is the one name for where control is.

- **`control setup`** advertises, in order: `--control-url`, `TUG_CONTROL_URL`, the config file's `controlUrl`, then the SSH target's host and `--port`. The command prints which one it used. The credential's URL is never an installation address, so unset a stale exported `TUG_CONTROL_URL` when installing.
- **Every other command** connects to `--control-url`, falling back to the URL in your credential. A tunnel is `--control-url https://127.0.0.1:18082`.
- **`--agent-control-url`** is where the agent connects. Both are connect targets only, and the server is verified by the control name derived from the pinned CA, so the address can be a DNS name, an IP, a tunnel or a moved host. Use both when you connect through a local SSH tunnel while nodes use a private network:

```sh
tug --control-url https://127.0.0.1:18082 node add root@app1.example.com --name app1 --agent-control-url https://10.110.0.3:8443
```

A configured URL includes its own public port. `--port` sets only the host port Docker publishes and does not rewrite it.

## Interactive selection

In a terminal outside CI, leave out an existing target and the CLI fetches choices from control. This works for `logs`, `exec`, `inspect`, `restart`, `deploy cancel`, `restore run`, `restore resume`, `restore release`, `secret remove`, `volume remove`, `credential revoke`, and for `node replace`, `repair`, `disable`, `remove` and `ingress`. Supply the new value while choosing the target with `tug scale --replicas 3` or `tug node address --to 10.0.0.2`. `tug doctor --node` offers a node, and plain `doctor` is unchanged.

| Key | Action |
| --- | --- |
| Arrows, `Ctrl-N`/`Ctrl-P`, `j`/`k` | Move |
| `PageUp`, `PageDown` | Page |
| Digits | Jump to that entry (`12` is the twelfth) |
| `space`, `a` | Toggle one, toggle all (multi-choice) |
| `enter` | Confirm. A single choice still needs it, and an empty multi-choice is refused |
| `q`, `Esc`, `Ctrl-C`, `Ctrl-D` | Cancel with nothing changed |

With `TERM=dumb`, menus fall back to numbered choices: enter a number, comma-separated numbers, or `q`. Menus go to stderr. Without a terminal, or with `CI` set, a missing target fails with an explicit-target error and selection never reads stdin. An explicit target skips its menu and its discovery request.

For live `exec`, `run`, `inspect`, `logs --follow` and `ps`, a node is offered when placement is ambiguous and `--node` is omitted. Pass both the service and `--node` to skip discovery. To select a service while giving a remote command, use `tug exec --select -- sh -c 'echo hello'` or `tug run --select -- wp core update-db`, where every positional argument then belongs to the remote command.

Commands whose omitted target already means "all" keep that. Pick a subset with:

| Command | Choices |
| --- | --- |
| `backup run --select` | Enabled backup targets. Cannot combine with explicit targets |
| `hold release --select` | Services held for a deployment move, not restore-owned holds |
| `node replace --select`, `node repair --select` | Nodes with SSH targets in local config. Cannot combine with a node, SSH target or `--all`. Continues and reports per-node failures |
| `restore run --select-snapshot` | Successful catalog backups for the target, including labeled pre-restore safety backups. `--from` still takes an external restic snapshot id |
| `restore run --select-writers` | Services to stop instead of automatic discovery. Cannot combine with writer flags or scratch mode |
| `credential create ci --role deploy --select-projects` | Existing projects, or all projects including future ones |

A choice never bypasses control's validation or confirmation: `restore run` still previews without `--confirm`, and volume and node removal keep their guards. Volume removal offers only unreferenced volumes and marks persistent data that needs `--delete-data`.

## Progress and quiet steps

Long operations report progress on stderr. In a terminal that is one live line, `[12s] Pulling the agent image · latest output`, and each finished stage stays as `[12s] label`. Without a terminal, or with `CI` set, it is one line per stage plus an elapsed-time line every ten seconds. Progress covers `deploy`, `rollback`, `backup run`, `restore run`, control backup and restore, `control setup`, node add, replace and repair, node teardown, and the command wait behind `restart`, non-followed `logs` and `doctor` node diagnostics. Timeouts and exit codes are unchanged, and `--no-wait` skips the remote wait and its progress. `node enroll` only prepares instructions and does not wait.

Steps that run on a host over SSH (Docker installation, preflight, image transfer and load, installs) print nothing while they work, so a Docker pull is one stage, not one line per layer. A step that fails prints its last lines. `--verbose` or `TUG_VERBOSE=1` streams the output as it arrives. On `exec` and `run`, everything after the service belongs to the remote command, so put it before: `tug --verbose exec`. For the best display, SSH must authenticate without a prompt. When OpenSSH refuses a host with `Host key verification failed`, as it does for a stale `~/.ssh/known_hosts` entry left by a provider that reused the IP, the command says so and prints the `ssh-keygen -R <host>` remedy, in every command that runs SSH. tug never edits `known_hosts` or turns off host key checking. A password or passphrase prompt is shown, but the status line stays hidden until the step prints.

## Setup

| Command | What it does |
| --- | --- |
| `tug init [<credential-file>\|-]` | Creates the config file with the resolved control URL and project if missing, imports the credential (a file, or `-` for stdin) and points the git-ignored overlay at it. Select them with `--control-url`, `--project` or `--config` |
| `tug setup <ssh-target>` | Shortcut for `tug control setup`. Installs control over SSH, issues the root credential and imports it, so no `init` follows |
| `tug upgrade` | Runs `control upgrade` on `controlSsh`, then `node upgrade --all`. See [Upgrade control and nodes](upgrades.md) |
| `tug control upgrade [<ssh-target>]` | Replaces the control container with one on another image |
| `tug control stop [<ssh-target>]` | Stops the control container. See [`tug control stop` and `tug control restart`](#tug-control-stop-and-tug-control-restart) |
| `tug control restart [<ssh-target>]` | Restarts the control container, or starts it when it is stopped |
| `tug control migrate <ssh-target>` | Moves control data from a host directory into the `tug-control` volume. See [Control plane](control-plane.md#moving-control-data-into-the-volume-control-migrate) |

### `tug setup` and `tug control setup`

| Option | Meaning |
| --- | --- |
| `--extra-san <name>` | Extra certificate name for control. Repeatable |
| `--install-docker` | Install Docker when missing |
| `--port <port>` | Host port for mutual TLS. Default `8443` |
| `--image <tag>` | Control image. Default: this CLI's version |
| `--build-local-image` | Build the image from the checkout and copy it over SSH |
| `--credential-out <file>` | Also save the credential to a `0600` file |
| `--no-import` | Skip the import. Requires `--credential-out` |
| `--recover-root` | Replace only root's key, from the control host |
| `-y, --yes` | Skip the confirmation |

In a terminal, setup offers to install Docker, prints the plan and asks to confirm. Without a terminal it never prompts. The advertised address follows [Where control is](#where-control-is). See [Control plane](control-plane.md).

### `tug control upgrade`

| Option | Meaning |
| --- | --- |
| `--to <version>` | A published version. Default: this CLI's version |
| `--image <tag>` | Any image tag |
| `--build-local-image` | Build from the checkout |
| `--rollback` | Redeploy `tug:rollback`. Warns that a database already migrated by the newer control may not open |
| `--force` | Reinstall even when control already runs the image |
| `-y, --yes` | Skip the confirmation |

The SSH target defaults to `controlSsh`. The command carries over the published mTLS bindings, advertised URL and extra names, reuses the data volume, compares the CA before and after, tags the previous image `tug:rollback`, shows the plan, then waits for control to answer and prints its version. Run `tug control backup` first for a backup beyond the `tug.db.pre-v<N>.bak` copy the new control makes.

### `tug control stop` and `tug control restart`

```sh
tug control stop root@control.example.com
tug control restart root@control.example.com
```

Both run `docker stop` or `docker restart` on the control container that `control setup` created, over SSH. The SSH target defaults to `controlSsh`. Nothing else changes: the `tug-control` volume, the image and the published ports stay as they are, unlike `control upgrade --force`, which recreates the container. In a terminal each prints its plan and asks to confirm, and `-y, --yes` skips that. Each prints a JSON result on stdout, and fails with a pointer to `control setup` when the host has no control container.

| Command | Use it to |
| --- | --- |
| `control stop` | Isolate an old control while its replacement takes over. Nodes keep serving their workloads and cannot get new work or report until a control runs. The container stays stopped, also after the host reboots |
| `control restart` | Apply a `control restore`, which prints `restartRequired: true` and names this command, or start a stopped control. It waits for control to answer when a credential is configured |

### `tug upgrade`

Takes `--to`, `--build-local-image`, `--force` and `-y`. It uses this CLI's version or `--to` for everything and ignores per-node `image` settings, so pin a single node with the two separate commands. It stops without touching a node when control fails.

## Nodes

Details and recipes are in [Nodes](nodes.md). Options below are the ones that change behavior.

| Command | What it does |
| --- | --- |
| `node add [<ssh-target>]` | Creates a node and installs its agent over SSH |
| `node list [--json]` (alias `ls`) | Lists nodes with status, address, ingress role, labels and last contact |
| `node replace\|repair [<node>] [<ssh-target>]` | The same SSH flow for an existing node. `replace` issues a new identity and brings back a disabled node. `repair` first moves corrupt agent credential documents aside |
| `node upgrade [<node>] [<ssh-target>]` | Replaces an enrolled node's agent with one on another image, keeping its key, address, labels and connect-only control URL |
| `node migrate [<node>] [<ssh-target>]` | Moves agent state from `/var/lib/tug` into the `tug-agent` volume. See [Nodes](nodes.md#moving-agent-state-into-the-volume-node-migrate) |
| `node remove [node] [sshTarget]` | Retires a node's identity, statuses, queued commands and unconsumed join key |
| `node disable [node]` | Blocks the node's key at once without SSH. Does not drain workloads, change placement or stop containers. `node replace` brings it back |
| `node ingress [node] [--disable]` | Enables the managed Caddy ingress role, or removes it |
| `node address [node] [address] [--to <address>]` | Updates the private address used for published-port binding and cross-node routing |
| `node register <node> --csr <file> [--mode create\|replace]` | Signs a node-generated CSR and prints the identity. Takes `--address` and `--label` like `node add`. Installs nothing. Use `agent install-cert` on the host |
| `node enroll --name <node>` | Prints the command that enrolls a host that runs it. See [Nodes](nodes.md#self-service-enrollment-node-enroll) |

### `node add`, `replace`, `repair`

| Option | Meaning |
| --- | --- |
| `--name <node>` | `node add` only. Node name. Defaults to the first DNS label of the SSH host (`app1` for `root@app1.example.com`). With an IP, a terminal asks (default: the host's `hostname -s`) and a script must pass it |
| `--address <ip>` | Private address for inter-node traffic. A terminal lists the host's global IPv4 addresses, private first, and never defaults to a public one |
| `--ingress` | `node add` only. Give the node the ingress role. A terminal asks otherwise |
| `--install-docker` | Install Docker when missing |
| `--label <label>` | Node label. Repeatable |
| `--image <tag>` | Agent image |
| `--build-local-image` | Build from the checkout |
| `--agent-control-url <url>` | Where the agent connects |
| `--all` | Walk every node with an `ssh` entry, continue after failures, print per-node results |
| `--no-wait` | Do not wait for the agent's first report |
| `-y, --yes` | Skip the confirmation |

The SSH target defaults to `nodes.<node>.ssh`. The command checks for a control credential, then always prints the plan (node, SSH target, Docker, address, image, ingress) before changing anything. Without a terminal it never prompts, so scripts pass `--address`, `--ingress` and `--install-docker`, and the plan says Docker was not checked. Unless `--no-wait` is set, the result carries `reporting`. A node that has not reported after about a minute prints `reporting: false` and the command exits nonzero. Agents use host networking for TCP and HTTP health checks, without added capabilities.

### `node upgrade` and `node migrate`

Both take `--all|--select`, `--image`, `--build-local-image`, `--agent-control-url` and `--no-wait`. `upgrade` also takes `--force`, and `migrate` also takes `-y, --yes`. `upgrade` also takes `--to <version>`, which is refused when newer than control. A node already on the image is skipped unless `--force`. A node control does not know, or a host with no agent, is refused (use `node add`). `--all` walks every node with an `ssh` entry, continues after failures and exits nonzero if one fails.

### `node enroll`

| Option | Meaning |
| --- | --- |
| `--name <node>` | Required. A terminal asks for it |
| `--address <addr>`, `--label`, `--image`, `--agent-control-url` | As for `node add` |
| `--install-docker` | Print a cloud-init document instead of a `docker run` command |
| `--ttl <seconds>` | Join key lifetime. Default `3600` |
| `--json` | JSON with `command` (and `cloudInit`) |

It mints a single-use, name-bound join key. A saved cloud-init document contains a credential. The printed image must be pullable by the new host, and a development `tug:local` override must already be loaded there.

### `node remove`

| Option | Meaning |
| --- | --- |
| `--force` | Remove while the agent still reports |
| `--teardown` | Clean the host over SSH after the record is gone: stop the agent and ingress, remove tug containers and networks, delete the agent identity |
| `--delete-data` | With `--teardown`, also delete project volumes and ingress certificates |
| `-y, --yes` | Skip the confirmation. Required without a terminal |

It is refused while a current deployment places a service or volume on the node (deploy without it first), and refused for a host that runs the control plane. The node ID is retired and never reused. Without `--teardown`, stop the agent and remove its containers yourself. `--teardown` can be repeated if the cleanup failed after the record was removed. The SSH target defaults to `nodes.<name>.ssh`.

## Deployments

### `tug lint`

Checks a Compose file against the `x-tug` schema with no control connection, credential or Docker. See [Checking the file](compose.md#checking-the-file-with-tug-lint).

| Option | Meaning |
| --- | --- |
| `-f, --file <file>` | Compose file. Default: the first of `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` in the working directory (or `file:` in `tug.yml`) |
| `--json` | `{ ok, file, errors }` for scripts and editors |

Findings go to stderr, one per line as `$FILE: $RULE`. The command exits nonzero when anything is wrong.

### `tug deploy`

By default it deploys the first of `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` in the working directory.

| Option | Meaning | Default |
| --- | --- | --- |
| `-f, --file <file>` | Compose file | First match above |
| `--version <version>` | Display version. Image identities stay immutable even when reused. The default label hashes only the Compose file, so a change to a `build:` context, a secret or a variable keeps it; the summary and `tug status` then add the deployment id | `git-<Compose hash>` |
| `--build` | Build the services that have both `build:` and `image:` for this deploy. By default their `image:` is deployed and nothing is built, see [Build or pull](compose.md#build-or-pull). `--build-local` on its own builds only services with no `image:` | off |
| `--build-local` | Build on your Docker daemon and upload saved images without source. Single-platform, must match the node architecture. Refused for a service whose `build.secrets` are set | Build on control |
| `--retry` | Run the project's failed deployment again, with new pulls and health checks, after you fixed the cause (a registry login, a missing image, a port). It reads no Compose file and conflicts with `--build`, `--build-local`, `--dry-run`, `--version`, `--var` and `--move`. It fails when the project's current deployment has not failed | off |
| `--compose-cli` | Render with `docker compose config` (needs Docker Compose v2 locally), for files that use `include`, `!reset` or `!override` | tug's [native reader](compose.md#native-compose-reader) |
| `--var <NAME=value>` | Value for this deploy only. Repeatable. A value may contain commas | none |
| `--profile <name>` | Enable a Compose profile. Repeatable or comma-separated | none |
| `--move <service>` | Acknowledge that a service with data placed on another node starts empty there. Repeatable or comma-separated | Such a deploy is refused |
| `--dry-run` | Resolve every value, print each name with its source (secrets as `•••`), ask control to check the file against other projects (a host port another project already publishes on the node, see [Checks against other projects](compose.md#checks-against-other-projects)) and stop before building or uploading. Never prompts or stores | off |
| `--no-wait` | Return once desired state exists | wait |
| `--timeout <seconds>` | Wait limit | `300` |

- **Build input.** Services with `build:` upload the current directory for a remote build. Published-image-only apps upload no context. Control rejects a built service with no build input.
- **Summary.** One line, `site git-ab12: deployment dep_1 succeeded, 3 services`. The default label `git-<Compose hash>` covers the Compose file and not the build context, secrets or variables, so two deployments can carry one label. When control's recent deployments of the project include another with the same label, the line ends with `(same label as dep_0; tell them apart by deployment id)`. A rollback deployment, whose label `rollback-git-ab12-<ms>` embeds the one it replaced, counts as the same label. `tug status` shows `[dep_1]` after the label in the same case. `--json` prints the full result with the desired state and the `values` record of where each `${NAME}` came from.
- **Moved data.** After `--move`, the services that write to the moved one are held until you run `tug restore run` or `tug hold release`.
- **Interruption.** If the wait is interrupted (control unreachable, timeout), the error names the deployment and `tug deploy cancel [id]`. A deploy refused because another is still rolling out names that one the same way.
- **Project name.** With no `--project`, `TUG_PROJECT` or `project:` in `tug.yml`, the project is the file's `name:`, or the name of its directory. `deploy` warns when the file's `name:` differs from the project that was chosen another way, because secrets, backups and restores are scoped to the project.
- **Retry and restart.** `tug restart` restarts a running container and does not clear a failed rollout, so a deployment that failed on a pull stays failed. `tug deploy --retry` gives the same deployment a new revision, which the agents apply again.
- **Missing values.** It scans the file for `${NAME}` or `$NAME` with no default that control and `--var` do not supply. In a terminal it asks, per variable, whether to generate a random 192-bit secret, enter a secret (hidden) or enter a variable (visible), and stores it before deploying. It never overwrites an existing value and never prints a generated one. Without a terminal, or with `CI` set, it fails naming the variables and the commands that set them.

To deploy CI-built images, push them to a registry and declare `image:`. Control pins tags to digests before publishing. See [Private registries](control-plane.md#published-images-and-private-registries).

**Source snapshot.** Remote uploads and `--build-local` use a temporary snapshot of the working directory. tug applies the root `.dockerignore` with its own matcher and always excludes `.git`, `node_modules`, `data`, `*.credential.json`, the tug overlays and `.tug.json` at any depth, root tug config names, and the resolved config, overlay and credential paths. Ignore rules cannot re-include those. Unsafe links are rejected. Docker then applies its own ignore rules to a local build. tug does not detect arbitrary secret names, so review nested or multiple build contexts. A broad `COPY .` can include secrets tug cannot identify. Local builds use temporary image tags that are removed after each archive is saved, including after a failure. They never remove your published tags or the tug runtime image.

### Other deployment commands

| Command | Options | What it does |
| --- | --- | --- |
| `tug rollback` | `--force`, `--no-wait`, `--timeout <seconds>` (default `300`) | Rolls the project back. `--force` permits it while a deployment is active. With `x-tug: { rollback: auto }` tug rolls back failed deployments itself, see [Automatic rollback](compose.md#automatic-rollback) |
| `tug deploy cancel [deployment-id]` | | Cancels an active deployment. In a terminal, omit the id to choose from active ones |
| `tug status` | `--json` | Each project's current deployment (with its id in brackets when another recent deployment of the project has the same label), node reports and errors, plus node status and last contact. A service whose container keeps restarting, or exited with an error and stays down, shows as `unstable` with the exit code, although its deployment reads as succeeded. Stale node health is the last report. Control-wide, credential-scoped |
| `tug events` | `--limit <n>` (default `100`, values outside `1`-`500` are an error), `--all`, `--json` | Events newest first as time, level, type, actor and message, for the project, or every project with `--all` (including control events with no project). Terminal escapes are stripped. Control deletes events older than 30 days and keeps at most 100,000, see [Configuration](configuration.md#control-plane) |
| `tug tui [view]` | `--once`, `--readonly`, `--json` | A live full-screen view. See [Watch your servers in a terminal](tui.md) |

Agents add a `service.*` event when a service changes, not on every poll: `pulling`, `starting`, `health_checking` and `serving` when a new revision, changed secrets or a changed rendered configuration are applied, one `failed` event when an apply fails, and one `serving` event when it recovers.

## Services and volumes

These use the resolved project. Live operations (`exec`, `run`, `inspect`, `logs --follow`, `ps`) go over an authenticated WebSocket from the CLI through control to the agent's existing outbound connection. They are ephemeral: control does not queue or replay them, and disconnecting any hop closes the session. Cancelling `exec` kills the agent's Docker client, but a process already started in the container can continue, because the Docker exec stream exposes no remote process id.

| Command | Options | What it does |
| --- | --- | --- |
| `tug logs [service]` | `--tail <n>` (default `200`), `-f, --follow`, `--node <name>`, `--ingress` | Fetches recent logs through the durable command queue, or follows live. `--node` applies to followed logs and is required when the service has more than one eligible node. `--ingress` reads an ingress node's Caddy container instead and is the same as [`tug ingress logs`](#ingress): it takes no service or project, and `--node` names the ingress node |
| `tug exec [service] [-- <command>...]` | `-i, --interactive`, `-t, --tty`, `--node <name>` | Runs a command in the current service container, default `sh`. Arguments are passed without a shell. `-i` forwards stdin. `-t` allocates a terminal with resize and needs a local terminal |
| `tug run [service] -- <command>...` | `--node <name>` | Runs a one-off command in a new container with the service's image, environment (secrets included), user, working directory, network and mounts, no published ports, removed when it ends. Non-interactive, exits with the command's exit code, needs `deploy`, and is recorded as a `job.run` event with its command line, hidden from `read` credentials. It shares mounts with the service and does not take the project lock |
| `tug inspect [service]` | `--node <name>` | Prints the live Docker inspection as JSON with environment values redacted (names kept). Needs `deploy`, which grants access to the workload's secrets anyway |
| `tug ps` | `--node <name>`, `--json` | Lists the project's containers on one node: service (or `job:<name>`), state, status, image with a shortened digest, ports, container name. Without `--node` the project must resolve to one eligible connected node |
| `tug restart [service]` | `--timeout <seconds>` (default `60`) | Restarts a service on every node that runs it and waits |
| `tug scale [service] [replicas]` | `--replicas <n>` | Changes how many matching nodes run a service, without a new deployment. Spreads by count over nodes with the service's `placement.labels` (all nodes without labels), staying within `placement.nodes` when there are no labels. `global` services run on every matching node. The next `deploy` re-resolves placement from the Compose file |
| `tug hold release [service...]` | `--select` | Starts services that `deploy --move` held, without restoring them. All when none is named. A restore releases its own holds |
| `tug image prune` | `--keep <n>` (default `5`), `--dry-run` | Admin. Deletes build archives on control that rollback no longer needs: all but the newest `n` distinct builds per project, the current deployment and any version a node reports. Rolling back to a pruned deployment is refused. Control prunes after every successful deploy (`TUG_IMAGE_KEEP`, default 5) |
| `tug volume list` | | Lists recorded volumes |
| `tug volume remove [name]` | `--delete-data` | Removes a volume record. `--delete-data` also removes the Docker volume on its node. See [Volumes](compose.md#volumes) |

Large input and output work because `exec` and `run` are flow-controlled end to end with a 512 KiB window per direction. Load a database dump with `tug exec -i db -- sh -c 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" wordpress' < dump.sql`, or stream a directory out with `tug exec wordpress -- tar -C /var/www/html/wp-content -cf - uploads > uploads.tar`. An agent older than 2.0 keeps a bounded buffer until upgraded, see [Live channel flow control](architecture.md#agent-wake-channel).

## Secrets and variables

Every `${NAME}` in the Compose file comes from control: a project secret, a project variable, `deploy --var`, or the default in the file. Neither the shell environment of the machine running `tug` nor the `.env` next to the Compose file is read. See [Where values come from](compose.md#where-values-come-from).

| Command | Options | What it does |
| --- | --- | --- |
| `tug secret set <name>` | `--value <value>` or `--from-file <path>` | Sets a secret. With neither, reads one line from stdin and exits after Enter, with no EOF needed. `--from-file` stores the exact contents, newlines included (for a PEM key). `--from-file -` reads all of stdin. Needs admin |
| `tug secret list` | | Names and versions, never values |
| `tug secret remove [name]` | | Deletes a secret |
| `tug secret import [file]` | `--vars <names>`, `--secrets <names>`, `--select`, `--overwrite`, `-y` | Stores the entries of a dotenv file (default `./.env`). Every entry is a secret unless `--vars` names it. A terminal lists the result and confirms. `--select` picks secret, variable or exclude per entry. Existing names are skipped unless `--overwrite` (a name of the other kind is always skipped), a bare `KEY` is skipped, and values are never printed |
| `tug values` | `-f, --file <file>`, `--json` | Lists every `${NAME}` and bare `environment` key the file references with its status: `secret` or `var` (set on control), `default` (the file supplies one) or `missing`. Exits 1 while one is missing. Secret values are never shown |
| `tug registry login <host>` | `-u, --username <name>` (required) | Adds a registry host to the project secret `TUG_REGISTRY_AUTH` and keeps its other hosts. In a terminal it asks for the token without echoing it; otherwise it reads the token from stdin, as in CI: `printf %s "$TOKEN" \| tug registry login ghcr.io --username octo`. The token is never printed. Needs admin. GHCR accepts a classic personal access token with `read:packages`, not a fine-grained one |
| `tug var set <name>` | `--value`, `--from-file` | Sets a project variable: a visible value such as an image tag, host or port |
| `tug var list` | `--values` | Lists variables. Without `--values` it needs only `read` |
| `tug var remove [name]` | | Deletes a variable |
| `tug var import [file]` | `--secrets <names>`, `--select`, `--overwrite`, `-y` | Stores every entry as a variable unless `--secrets` names it |
| `tug domain add <host> --service <service>` | | Serves an extra hostname (or `*.zone` wildcard) on a service's ingress route without a deployment. The service must already have a route, and a name belongs to one project. Needs `deploy` |
| `tug domain list` (alias `ls`), `tug domain remove <host>` | | Lists or stops serving mapped domains, with the certificate state of each on every ingress node (`issued`, `pending`, `failed` or `unknown`). See [Mapped domains](ingress.md#mapped-domains-and-wildcard-zones) |

Variables are read and written with `deploy`, and a change takes effect on the next deploy. A name cannot be both a secret and a variable.

## Ingress

Ingress nodes run one managed Caddy for every project (see [Ingress and HTTPS](ingress.md)). These commands read it, and both need an `admin` credential that is not limited to projects, because the container's output and the hosts it serves span every project. Enable the role with `node ingress`.

| Command | Options | What it does |
| --- | --- | --- |
| `tug ingress logs [node]` | `--tail <n>` (default `200`), `-f, --follow` | Prints the `tug-caddy` container's logs on an ingress node: ACME attempts and failures, config reloads and, with `TUG_INGRESS_ACCESS_LOG`, access lines. Without `--follow` it goes through the durable command queue, like `tug logs`. `tug logs --ingress --node <node>` is the same command, and unlike plain `tug logs` it accepts `--node` without `--follow`. Each read is recorded as an `ingress.logs` event naming the credential |
| `tug ingress tls [node]` | `--json` | Lists every named host with automatic HTTPS on each ingress node, with its state, since when, and the reason when it has no certificate. See [Certificate status](ingress.md#certificate-status) |

With no node, both commands offer the enabled ingress nodes in a terminal and need one outside it.

## Backups

`tug backup` and `tug restore` handle workload backups of service commands and volumes. [`control backup`](#operations) is separate. Destination and restore commands need admin.

| Command | Options | What it does |
| --- | --- | --- |
| `tug backup destination set <url>` | `--env NAME` (repeatable) | Sets where backups go, for example `s3:https://s3.example.com/bucket/tug-backups` with `--env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY`. Each value is read from the environment variable of that name, else from a stdin line, never an argument. S3 needs both AWS variables. Values are stored encrypted and released only to a node running a backup. An absolute path works for development but is read per node and not shared. Replaces the previous destination |
| `tug backup destination show` | | The URL and variable names, never values |
| `tug backup destination remove` | | Removes the destination and its credentials. Existing backups stay in the repository |
| `tug backup run [targets...]` | `--no-wait`, `--timeout <seconds>` (default `3600`), `--select` | Backs up the named services or volumes now, or every target, and waits. Exits nonzero if any backup fails or is missed. Needs `deploy` |
| `tug backup list` | `--limit <n>` (recent runs, default `20`), `--check`, `--allow-empty` | Shows each target with node, schedule, last success and next run, then recent runs. Needs `read` |
| `tug backup cancel <run>` | | Stops a queued or running backup. The run id is the last column of `backup list`. It is reported as cancelled and not retried |
| `tug backup password` | `--control` | Prints the project's repository and password, or with `--control` the control repository and password, the one value to keep off the server for recovering control |
| `tug restore run [target]` | `--from <id\|latest>`, `--scratch`, `--no-safety-backup`, `--writers <service,...>`, `--no-writers`, `--confirm`, `--timeout <seconds>` (default `3600`), `--select-snapshot`, `--select-writers` | Restores a service or volume. Without `--confirm` it prints the plan and changes nothing. `--from` takes a backup run id, a restic snapshot id or `latest`. It waits up to five minutes for stopped services to serve again, then finishes with a warning. See [Restore](backups.md#restore) |
| `tug restore list` | | Recent restores |
| `tug restore cancel <id>` | | Stops a restore that is waiting on its safety backup (nothing has changed) or restoring (it is interrupted and its services stay stopped until `resume` or `release`) |
| `tug restore resume [id]` | | Runs an interrupted restore again |
| `tug restore release [id]` | | Starts the services it stopped and unlocks the project, even if data is incomplete |

**`backup list --check`** prints a `PROBLEM` line for each target that is stale (no success for two periods), whose last run failed or was missed, and when nothing is protected (no destination, or no enabled target). It then exits nonzero, so cron or a monitor alerts without parsing output. `--allow-empty` accepts a project with no enabled target, for a project that holds no data. A destination is still required, since control backs itself up there.

**Passwords.** Each project has its own restic repository at `<destination>/<project>`, with a password derived from control's master key. Keep the printed password with the destination credentials, because losing the master key loses every repository.

## Operator credentials

Scoped credentials for CI and teammates. See [Access control](access-control.md) for roles, scoping and a GitHub Actions example. All three commands need admin.

| Command | Options | What it does |
| --- | --- | --- |
| `tug credential create <name>` | `--role read\|deploy\|admin`, `--project <name>` (repeatable), `--select-projects`, `--expires-in-days <n>` (default and maximum `365`), `--raw` | Creates a credential and prints it once on stdout. Control keeps no copy of its private key. Without `--project` it covers all projects, and admin credentials cannot be limited. Here `--project` is the credential's scope, not the connection project. Names are 1 to 64 letters, numbers, dots, underscores or hyphens and cannot be reused after revocation. `--raw` prints only the token, for `tug credential create ci --role deploy --raw \| gh secret set TUG_CREDENTIAL`. `TUG_CREDENTIAL` accepts that token or the whole JSON output |
| `tug credential list` | | Role, projects, creator, last use, expiry and revocation, never secrets |
| `tug credential revoke [name]` | | Revokes at once and closes live sessions |

Use a credential anywhere one works: `TUG_CREDENTIAL=<credential> tug deploy`.

## Operations

### `tug doctor`

| Option | Meaning | Default |
| --- | --- | --- |
| `--nodes` | Also run host diagnostics through the agent on every node and wait for the result | off |
| `--node [name]` | The same for one node. An unknown name is an error | off |
| `--timeout <seconds>` | Wait for node diagnostics | `60` |
| `--json` | The full document, including output the summary leaves out such as `docker info` | off |

It checks this machine (Node.js and Docker) and the control plane: SQLite, the CA and server certificate expiry, each node's certificate expiry and connectivity, each online node's observed clock skew (unknown when offline, see [Nodes](nodes.md#doctor-certificate-expiry-and-clock-skew)) and ingress status. The local Docker check matters only for `deploy --build-local`. When no daemon answers on this machine it prints `skip` with `needed only for --build-local` and does not count toward `Problems found`; a reachable daemon prints `ok`. In `--json` the check is `{"name":"docker","ok":true,"skipped":"needed only for --build-local"}`.

On ingress nodes, control opens a TCP connection to ports 80 and 443 on each node's address and fails `ingress_ports` for a port that does not answer, with the likely firewall cause and fix ([Port reachability](ingress.md#port-reachability)). tug does not change firewalls.

Host resources are read-only values, shown under a `resources` check on control and a `host.resources` check on each node (they never fail the run, and tug sets no thresholds on them):

| Field | Source | Meaning |
| --- | --- | --- |
| `load` | `/proc/loadavg` | One, five and fifteen minute load averages and the CPU count of the host |
| `memory` | `/proc/meminfo` | `MemAvailable` and `MemTotal`, so reclaimable cache counts as available |
| `disk` | `statfs` of the agent's state volume, or of control's data directory | Free and total space of the filesystem that holds it. Docker keeps volumes under its data root, so on a default install this is the disk Docker fills; `dockerRoot` names the data root the daemon reports |
| `containers` | Docker stats, one sample | CPU as a percentage of one core and memory in use without page cache, for the `tug-agent` and managed `tug-caddy` containers on a node and for control's container on control. A container that is not running is listed with its error |

Node diagnostics include `ports.public`, a warning that lists containers of tug projects listening on all interfaces or a public IP ([Networking](networking.md#published-ports-private-by-default)). It prints one `ok`, `warn` or `FAIL` line per check, grouped under this machine, control and each node, and exits nonzero when any check fails, so it works as a readiness probe.

### Control backup and restore

| Command | Options | What it does |
| --- | --- | --- |
| `tug control backup` | `--local`, `--no-images`, `--download`, `-o, --output <file>` | Stores a control-plane backup in the backup destination and prints the repository, snapshot id and `stored: destination`. It holds state, PKI and the master key, never build images or workload volumes. With no destination it fails and says how to make an archive. `--local` writes an archive on the control host (including retained build archives unless `--no-images`) and prints `stored: control-host`. `-o <file>` also saves it here (implies `--local` and `--download`), creates it `0600`, refuses to overwrite and prints the path. `--download` alone uses `./tug-control-backup-<id>.tar.gz`. Control also backs itself up every night. See [Control plane backup](backups.md#control-plane-backup) |
| `tug control backup list` | `--json` | The control backups on the control host and the snapshots stored in the destination, read from the destination, with the ids that `--snapshot` takes |
| `tug control restore <artifact-path>` | `--confirm` | Restores a control backup that is a path on the control host. Needs a control restart with [`tug control restart`](#tug-control-stop-and-tug-control-restart) |
| `tug control restore` | `--from-file <file>` | Uploads an archive from this machine and restores it |
| `tug control restore` | `--from-destination <url>`, `--env <name>`, `--snapshot <id>`, `--password-stdin` | Restores the newest control backup in a destination, or the named snapshot. Credential variables are read like `backup destination set` reads them, then the control password from `tug backup password --control` (`TUG_CONTROL_BACKUP_PASSWORD`, or the first stdin line with `--password-stdin`, in which case the credential variables must be in the environment). Used for this restore only |

Without `--confirm`, a control restore is a preview: it checks the archive, database integrity, CA and secrets, prints what the backup holds and changes nothing. See [Control plane](control-plane.md#backup-and-restore).
