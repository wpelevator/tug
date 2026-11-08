# @wpelevator/tug

## 1.2.0

### Minor Changes

- 003e730: `x-tug.ingress.host` accepts a list of hostnames as well as one: every name shares the route's upstreams and TLS mode (with `tls: custom` one certificate must cover them all), the first is the primary, and each name is checked for uniqueness and cross-project ownership like a single host. A single string behaves exactly as before, and domains added with `tug domain add` still join the route beside the declared names, always with automatic HTTPS.
- 003e730: Map extra hostnames onto a service's ingress route without a deployment, for WordPress multisite domain mapping: `tug domain add <host> --service <service>`, `tug domain list` and `tug domain remove <host>`, backed by `GET`/`POST /api/v1/domains` and `DELETE /api/v1/domains/:host` (the `deploy` role, scoped to the project). Mapped domains share the route's upstreams and TLS handling, survive redeploys and rollbacks, and obey the same cross-project ownership rule as declared hosts, which `deploy` and `rollback` now also enforce against mapped domains. Domains are stored in a new control database table (schema version 2); the previous schema is upgraded in place, and the pre-upgrade copy is kept as `<file>.pre-v2.bak`. A control at 1.1.0 or older refuses the upgraded database, so rolling back means restoring that copy or an earlier control backup, which discards deployments and domains made since. Control also rejects a deployment that publishes host port 2019 or 2021 on an ingress node (the managed Caddy's loopback ports), and the on-demand wildcard approval now accepts only valid DNS labels.
- 003e730: A wildcard `x-tug.ingress.host` with `tls: auto` now works: Caddy issues a certificate for each name under the zone on the first connection (on-demand TLS), approved by a loopback-only endpoint that control renders from the wildcard hosts it routes and that accepts exactly one label under the zone. Before, such a host could never obtain a certificate. Let's Encrypt limits certificates per registered domain, so a network with many subdomains should use `tls: custom` with a wildcard certificate.

## 1.1.0

### Minor Changes

- 1ec548f: The managed ingress keeps requests and WebSockets alive across upstream churn and tells clients what is happening. A request retries for up to five seconds when no upstream is available instead of returning a 502 at once, and open WebSockets keep running for up to five minutes after a config reload instead of being cut on every site whenever any site deploys. A host with no serving upstream now answers `503` with `Retry-After` instead of failing the TLS handshake, and the new `x-tug.ingress.maintenance: true` does the same on purpose without restarting the service. Because the 503 host keeps its site block, Caddy now also requests a certificate for it; use `tls: off` while DNS is not ready. Caddy's per-host Prometheus metrics are available on the ingress node's loopback admin endpoint, and `TUG_INGRESS_ACCESS_LOG=true` turns on a JSON access log per site (off by default, since URLs and client IPs are logged). The new directives need a current Caddy 2 image: an ingress node that cached an older `caddy:2-alpine` must pull a newer one or set `TUG_CADDY_IMAGE`. The ingress docs also list the proxy's remaining limits and compare it with kamal-proxy, Uncloud, Traefik and Dokku.
- 92d85eb: Quieter, keyboard-driven terminal output. Remote install steps (Docker, preflight, image transfer, control and agent install) no longer stream Docker's per-layer pull lines; they show named stages, a live status line in a terminal and the last output lines only on failure, and the new `--verbose` flag (or `TUG_VERBOSE=1`) streams everything. Selection menus use arrow keys and space to toggle instead of numbers. Errors from a command that already ran no longer end with the usage hint, and a missing credential names a parent directory's config file.

### Patch Changes

- dfd926b: Document the editor schema header in every Compose YAML example in the README and docs.
- ba72019: Retry network steps in the Docker bootstrap and name the stage that failed, so an unattended cloud-init install survives a briefly unreachable mirror or a first-boot package lock and a failed one shows where it stopped.
- 136d352: Move the integration-test Compose files out of the repository root into `tests/integration/compose/` and write their lists in block style.

## 1.0.0

### Major Changes

- b923c62: Tug 1.0.0. The CLI, the `x-tug` Compose extension (with its published schema), the wire protocol under `/api/v1` and `/agent/v1`, the credential and backup formats and the image and package names are now public contracts that change compatibly within a major version (see Releases in the docs). Control and agent databases carry a schema version and upgrade in place through migrations: a database that holds data is copied to `<file>.pre-v<N>.bak` before the first migration, a database from a newer Tug is refused untouched (including as a restore snapshot), and databases from every release since 0.2 upgrade. Control, CLI and agents now follow semver for version skew: a client is refused only when it is on a newer major, so from 1.0 a newer minor works with an older control, and a command that needs a newer control reports the missing route with the control's version.

### Minor Changes

- c44eb59: Flags that take several values now also accept a comma-separated list, alongside repeating the flag, and the two mix: `tug deploy --move db,web`, `tug restore run db --writers web,worker`, `tug credential create ci --role deploy --project site,blog`, `--label gpu,eu` on the node commands, `--extra-san` on `control setup` and `--env` on `backup destination set`. Spaces around items are ignored. The values are names, so a node label can no longer contain a comma on the command line. The config file keeps taking YAML lists.

### Patch Changes

- 9a5daef: The `x-tug-client-version` header is now sent only to the control, no longer to the application containers the agent health-checks. A control that refused a newer CLI is judged again on the next request instead of being remembered as agreed. An agent that is newer than its control now logs the control's refusal with the remedy and keeps its containers running, and the docs say to roll agents back together with the control. Version skew now follows semver: the control refuses a client only when it is on a newer compatibility key (the major, or `0.minor` before 1.0), so from 1.0 a client with a newer minor of the same major is served, and a CLI ahead of its control gets a 404 explained by the version stamp. `tug init` no longer fails when the credential it replaces has an unreadable CA, and CA trust errors are recognised only by their exact OpenSSL wording.
- b923c62: `tug node replace` and `tug node repair` accept `-y` like `tug node add`. A control or agent that finds a database from a newer Tug prints one `error:` line with the remedy instead of a stack trace. `--build-local-image` runs the image under `<tag>-<image id>` on the host, so rebuilding `tug:local` no longer leaves the running control or agent container showing an image ID.
- b923c62: `tug node add` no longer offers the addresses of Docker and CNI bridge interfaces (`docker0`, `br-<id>`, `veth*`, `cni0`) when asking which address other nodes should use. They only reach containers on the host, and on a host that already runs Tug they crowded out the real choices.
- a7e038a: Deployment, command, backup run, restore and build lifecycles are now declared as transition tables and every state change goes through one guarded writer, so an undeclared transition is refused instead of silently applied, and the database rejects any state a lifecycle does not declare. Builds left in `building` by a failed or interrupted deploy are now marked `failed`. A node's `stale` status is derived from its last heartbeat on every read instead of being written by `GET /api/v1/status`, so `tug node list` no longer shows a stale node as `online` until someone runs `tug status`. The deployment states `uploading` and `pending_dependencies`, which nothing ever set, are gone from the docs and the metric label list.
- 122bcb1: `tug deploy --move` now holds a writer that moved together with its database. A project such as WordPress with its own volume has to acknowledge both services, and that used to exempt the writer from the hold, so it started against the empty database and served a fresh installer until the restore. The hold is placed on every writer of a moved service, and the replacement-node procedure says to deploy with `--move`.
- b923c62: Re-running `tug node add` on a host that is already enrolled now upgrades its agent in place, as the documentation says: the agent's installed key is reused, so control treats the request as an idempotent retry instead of refusing it with `409 node already exists`. A host enrolled under a different node name is refused with a hint, and `tug node replace` and `tug node repair` still rotate the key.
- 84fa115: Control no longer stores a new full image archive for every deploy. A rebuild that produces the image the project already has an archive for reuses that archive, so nodes download nothing and the container is not recreated. After each successful deploy control also prunes archives beyond the newest `TUG_IMAGE_KEEP` (default 5, `0` turns it off) distinct builds per project and caps the Docker build cache at `TUG_BUILD_CACHE_KEEP` (default `10GB`, `0` turns it off), so disk use no longer grows until someone runs `tug image prune`. Nodes now drop the images of pruned archives too, once no container uses them.

## 0.14.0

### Minor Changes

- ec2342a: Ship the `x-tug` schema as JSON Schema for editors: `x-tug.schema.json` is published with the package and at `https://unpkg.com/@wpelevator/tug/x-tug.schema.json`, and linking it from a Compose file (`# yaml-language-server: $schema=...` or a JetBrains JSON Schema mapping) gives autocomplete, hover documentation and inline findings for every `x-tug` field in VS Code, JetBrains and any schema-aware YAML language server. The schema is generated (`npm run schema`) from the validator's rule set — `x-tug`, volume `x-tug`, backup keys, retention keys, service and volume key allowlists are tested against the constants `tug lint` and deploy enforce, and a drift test fails when the committed file no longer matches — so an editor squiggle and a `tug lint` line never disagree. `ajv` was added as a development dependency to stand in for the editors the schema targets; it is not bundled.
- cbf7661: Fail loudly on control version and credential/CA mismatches: every CLI command now does a one-request version preflight (`GET /api/v1/version`) per control per process and refuses — instead of surfacing a `404 Cannot GET /api/v1/services` on an older control — with `tug control setup <control host> --yes` as the remediation when the control is older than the CLI, and a pin hint (`npm i -g @wpelevator/tug@<version>`) when it is newer. TLS trust failures ("self-signed certificate in certificate chain") now name the credential's CA fingerprint and both fixes instead of a bare openssl string, on the HTTP and live channels alike, and `tug doctor` reports both fingerprints (credential CA vs presented server leaf) under a `control_server_cert` check. `tug init` and `tug control setup` name credential files by CA fingerprint (`<host>_<port>.<ca>.json`), so importing a credential from a different control CA is additive and never overwrites the credential the CLI was working with; `tug init` prints a notice naming both CAs when it re-points the CLI, and `control setup` refuses to import a root credential signed by a CA the control did not persist.
- ec2342a: New `tug lint [-f --file <file>] [--json]` checks your Compose file against the `x-tug` schema in milliseconds, without deploying, Docker or a control connection: one finding per line on stderr naming the file, service or volume and the rule, exit 1 on any finding, and `--json` prints `{ ok, file, errors }` for scripts and editors. Lint reuses the same checks as deploy, so the schema became stricter for everyone: unknown keys in any `x-tug` block (a typo such as `ingresss` used to deploy silently ignored), unknown keys and malformed values in `x-tug.placement`, type checks for `x-tug.replicas` and `x-tug.global`, full validation of `x-tug.health` (type must be `docker`, `tcp` or `http`, a `tcp` probe requires a port, `interval`/`timeout` must be durations, `retries` a whole number) and the previously unchecked volume `x-tug` block (`type`/`driver`/`persistent`/`placement`/`backup`). An unrecognized health type fell through every check on the agent and silently passed the service as healthy; the same file is now rejected at deploy.
- 9cc100a: Version skew now travels with ordinary traffic instead of a paid preflight: the control stamps every HTTP response with its version (`x-tug-version`) and refuses any request declaring a newer client version (`x-tug-client-version`, sent by the CLI and the agents on every HTTP request) before running the handler — so a CLI ahead of the control is stopped by the surviving side itself, and read commands (`status`, service listings) get the version check for free on their own response without the dedicated `GET /api/v1/version` request every command used to make per process. Only commands whose first control request is a mutation (`deploy`, `rollback`, `restart`, `backup`, restore), live commands that open the live channel without a read first (`exec`, `run`, `logs`, `ps`, `inspect`) and `node add` still take the one-request explicit probe, because a mutating request must never already have been received by an old control when the refusal arrives. The version route stays, and a control older than the stamping feature is refused from its missing stamp with the same `tug control setup <control host> --yes` remediation as before; a CLI behind the control still proceeds with the one-time `npm i -g @wpelevator/tug@<version>` pin warning.

## 0.13.0

### Minor Changes

- 6c6e88d: Choose services, nodes, deployments, restore snapshots and other existing resources directly in the terminal. Add opt-in multi-selection for backups, move holds, node repair/replacement, restore writers and credential project scopes, with scoped control-plane discovery and unchanged explicit-target scripting.

### Patch Changes

- fe10226: Report elapsed-time progress during rollback, setup and image transfers, node reporting, backups, restores and agent command waits.
- b58b9a3: CLI failures say more: a network error names its cause instead of only `fetch failed`, a deploy whose wait is interrupted names the deployment and `tug deploy cancel <id>` (as does the refusal when another deploy is still rolling out), and `tug setup` and `tug node add` stop before touching the host when the release image for this CLI version is not published yet.
- e774226: Add reproducible local benchmarks for the WordPress, Node.js, Django, and Laravel examples.
- 871b326: Remove backup destinations and their stored credentials atomically, preserving both if a database operation fails.
- c9d542b: Include the docs directory in the npm package so the documentation is available with installed releases.
- 872bbc2: Fix tug secret set hanging after printing its result when stdin remains open.
- 872bbc2: Preserve readline cleanup between CLI prompts so stale input listeners cannot echo later hidden answers.
- fe10226: Show deployment stages and elapsed-time progress on stderr, including per-service local builds and rollout state changes.

## 0.12.0

### Minor Changes

- a9d446d: Add `tug image prune [--keep N] [--dry-run]` to delete the build archives kept on control for old deployments, and `tug control backup --no-images` to leave the archives out of a control backup. Rolling back to a deployment whose archive was pruned is refused with a clear message.
- c5b637d: Add `tug node remove <node> --teardown` to clean a retired host over SSH (volumes are kept unless `--delete-data`), make `tug restore` find writers on other nodes from host names in environment variables, and make `tug deploy` refuse to start a service with data empty on another node unless you pass `--move <service>`, which holds the services that write to it until the restore or `tug hold release`.
- f8df155: `tug deploy`, `tug rollback` and `tug scale` print a one-line summary by default; `--json` restores the full result for scripts. `tug deploy` warns when the Compose file's `name:` differs from the Tug project. A restore that times out waiting for the writers to stop now names the node, the writer's state and the apply error the node reported, and the backup docs explain why a sibling health check that depends on a held writer fails during a restore.

### Patch Changes

- c736d1e: The published `ghcr.io/wpelevator/tug` image is now based on Alpine instead of Debian, roughly halving its size (about 87 MB compressed instead of 159 MB). It ships only the Docker CLI rather than the full Docker Engine package.
- 864c877: Fixes from a real-host evaluation: `tug setup` writes the credential's control URL into a new `tug.yml` instead of `https://localhost:8443`; a restore no longer times out with "the writers did not stop in time" when a sibling service's health check fails during the hold; a health check on a crashed container reports its exit code and last log lines instead of a refused connection; `tug scale` stays within a service's explicit `placement.nodes`; `tug run` containers inherit the service's cross-node `extra_hosts`; `tug deploy` finds `compose.yaml`/`compose.yml` by default; and the missing-backup-schedule message is clearer.
- 82a57cd: Clarify VPS deployment, application scope, node topology and volume placement, registry-free image delivery, and where to find examples.

## 0.11.0

### Minor Changes

- 98c2041: Commands are now grouped as `tug <subject> <verb>` (`node add`, `secret set`, `backup run`, `credential create`, and so on); the dash-joined names such as `node-install` are removed, and `deploy-cancel` is `deploy cancel`. `tug setup` (short for `tug control setup`) installs control and imports the root credential in one step, so `tug init` is only needed for credentials from elsewhere. `tug node add` infers the node name from the SSH host and, in a terminal, offers to install Docker, choose the inter-node address and enable ingress (`--ingress`), then confirms a plan (`-y` skips it). `tug node list` is new, and `node replace` and `node repair` take the node name as an argument.
- a56bd80: `tug status` now prints a readable summary by default and `--json` prints the raw JSON (`--human` is removed). `tug deploy` prompts to generate or enter Compose variables that no secret, environment or `.env` provides, and fails with a clear error in CI or without a terminal.

### Patch Changes

- 52bb79b: `tug node add` checks for a control credential before it probes the host or asks questions, and its plan says when Docker was not checked. When the new node has not reported after the wait, the result says `reporting: false` and the command exits non-zero instead of looking like a success.
- 98c2041: `tug node add` asks for the node name in a terminal when the SSH host is an IP address, suggesting the host's own hostname; `tug node enroll` asks for `--name` too. Without a terminal `--name` is still required.

## 0.10.0

### Minor Changes

- 355bf61: Use collision-free managed and scratch volume names. When an owned volume exists under the earlier naming scheme, Tug refuses to create an empty replacement so its data can be recovered.
- 68e4ef6: Remove the Tug-managed WireGuard mesh and its CLI, API, configuration and runtime surfaces. Cross-node service names, ingress upstreams and private published ports now always use the node's operator-provided `address`; set it to an address on your existing private network. Service names are enabled by default and can be disabled with `TUG_SERVICE_NAMES=false`. Agents no longer need `NET_ADMIN` or WireGuard tools, but retain host networking for container health checks.
- 355bf61: Add a human-readable status summary with deployment and node errors.
- fb3f597: `controlUrl` is the one name for where the control plane is. `--advertise-url` and `TUG_ADVERTISE_URL` are removed: `tug control-install` advertises `--control-url`, `TUG_CONTROL_URL`, then the config file's `controlUrl` (else the SSH target's host and `--port`) and prints which it used, and the control container reads its own address from `TUG_CONTROL_URL`. Other commands still treat the same setting as the connect target, falling back to the URL in the credential. Clients verify a name generated from the CA, so the value is only an address.
- 355bf61: Wait for managed ingress to apply routes before reporting deployment success.
- 355bf61: Exclude known Tug credentials from local build snapshots.

### Patch Changes

- fb3f597: Config file keys now apply as defaults to every command that has the matching flag, and a flag on the command line always wins: `wait` also covers `backup-run` and the node install commands, `address`, `publicAddress` and `label` reach `node-replace-identity` and `node-repair-identity`, and `mesh`, `installDocker` and `image` from `nodeDefaults` reach `control-install`. A test checks that each key's command list matches the options the commands really have. In batch mode (`--all`) the node commands print only the final per-node results.
- 236250a: `tug control-install` no longer requires `--advertise-url`: it defaults to the SSH target's host and the published port (`https://<host>:8443`) and prints the choice. Pass the flag to advertise a different address.
- 355bf61: Bind scratch volumes to the restore that created them.
- 355bf61: Fix restore targeting after moving a project to another node.
- 68e4ef6: Allow node addresses in enrollment and address updates, and keep endpoint DNS failures from blocking unrelated services.
- fb3f597: Use `controlUrl` from the YAML or JSON config as the default advertised address for `control-install`, with `--advertise-url` taking precedence. Apply all per-node settings consistently in batch identity commands and preserve explicit flag overrides.
- 355bf61: Check volume ownership before deletion, backup, and restore.
- 355bf61: Reject conflicting or unsafe existing project networks and volumes before starting workloads.

## 0.9.0

### Minor Changes

- dd93b02: Verify the control plane by a generated name instead of its address. Control's server certificate now carries `control-<hash>.tug`, derived from its CA, and clients recompute it from the CA they pin, so credentials no longer depend on the IP or DNS name control is reached at: bare-IP installs work, and moving control needs no new credentials. `TUG_PUBLIC_URL` and `--public-url` are renamed `TUG_ADVERTISE_URL` and `--advertise-url`; the value is now only the default connect address written into credentials. Adds a Getting started guide.

### Patch Changes

- fa55912: Close security audit findings: node `address`/`publicAddress` are validated, backup credentials are released only while the project is placed on the node, deployments refuse disabled or unknown placement nodes, wildcard ingress hostnames conflict with other projects' hosts, source uploads exclude the resolved credential file and support `.dockerignore` character classes, `tug inspect` redacts environment values, and child processes have a deadline and bounded output.

## 0.8.0

### Minor Changes

- 1918525: Replace HTTP and bearer tokens with one mutual-TLS listener. Control now serves a single TLS 1.3 port (default `8443`) that requires a client certificate from every peer, signed by control's private CA. Nodes, operators and CI authenticate with certificates whose keys are authorized from the database, so revocation, key replacement and `tug node-disable` apply to the next request and close live sessions. `TUG_PUBLIC_URL` is now required; `TUG_OPERATOR_TOKEN`, `TUG_TOKEN`, `TUG_AGENT_TOKEN`, `TUG_TLS_CERT_FILE`, `TUG_TLS_KEY_FILE`, `--token`, `--uses`, `--ca`, `--http-only-dev`, `control-token`, `/healthz` and the plain HTTP listener are removed. New commands: `node-replace-identity`, `node-repair-identity`, `node-disable`, `control-install --recover-root`, `agent identity` and `agent install-cert`; `tug init` imports a credential file. `node-prepare-enrollment` mints single-use, name-bound bootstrap certificates.
- 1918525: Node IDs are now generated, immutable and never reused: a node has a random `node_...` ID beside its chosen name, certificates name the ID, and a name freed by `node-remove` gets a new ID, so certificates issued for the removed node can never authenticate a node created later with the same name (even with the same key). Enrollment credentials reserve their node ID when minted, and `status` includes each report's node name. `tug doctor` now reports the control CA, server and every node certificate's expiry (warning when renewal is overdue, failing when expired) and each online node's observed clock skew; offline nodes report an unknown skew instead of a stale value. Agents send their clock with status reports. The control-side Compose check is gone from `doctor`. `x-tug.placement.global` is removed in favor of `x-tug.global` and is rejected with a pointer to it. The runtime and fake-VPS images no longer ship the Compose plugin (nodes use the Docker Engine API), and the image smoke test now also verifies certificate issuance and the undici transport on Debian and Alpine. Help and error text, audit messages and the documentation now use operator credential, control plane, node and agent consistently, and no longer describe bearer tokens, plain HTTP, port 8080, `/healthz` or Compose on nodes.

### Patch Changes

- 1918525: Create control backup directories as `0700` and archives as `0600`, removing staging key material when a backup fails; `control-install` now creates the control data directory as `0700`. Refuse a deploy or rollback that claims an ingress hostname another project already routes. Update `multer`, `js-yaml`, `tar`, `express`'s `qs` and `proxy-addr` to patched versions.
- 1918525: Document security audit findings and clarify the host and secret access granted by deployment credentials.
- 1918525: Document Tug's core terminology and review naming consistency, confusing interfaces and alignment with established infrastructure tools.
- 1918525: Harden node reports and source uploads. Control validates every node status report against the protocol schema (rejecting non-numeric or out-of-range ports) and stores only services placed on the reporting node, so a node can no longer inject ingress configuration. Backup results and heartbeats apply only to a running command owned by the calling node. `node-disable` now removes the node from peers, endpoints, ingress and label scheduling immediately. Source uploads follow `.dockerignore` glob, recursive and negation rules and never include `*.credential.json` files.

## 0.7.0

### Minor Changes

- c52bb43: Add an `examples/wordpress` project (WordPress and MariaDB with scheduled backups, restore and one-off commands) and replace the sidecar backup recipe with it. Fix Compose escaping: literal dollars written `$$` in a Compose file now reach the container as `$`, as they do with `docker compose up`, which also lets backup and restore commands read passwords from the container's environment. Make `restore --from latest` skip the safety snapshot taken before a previous restore.
  
  Also: `tug restore` waits for the services it stopped to serve again, `backup-list --check` exits nonzero for stale, failed or missed targets, `x-tug.backup.memory` sets the restic helper's memory limit, a failed health check says when the agent runs outside a container, and the runtime image no longer defaults to the control role, so `TUG_ROLE=agent` works.

## 0.6.0

### Minor Changes

- 3015c4a: Validate `x-tug.backup` on services (a command whose output is stored) and volumes, with project defaults and single-placement rules, and add a UTC cron parser.
- 28c4156: Add the backup destination: `backup-destination-set|show|remove` store S3-compatible credentials encrypted on control, `backup-key` prints a project's derived restic repository password, and agents can fetch credentials only for their own running backup command. Backups themselves are not scheduled yet.
- 8ab3fb1: Add a committable CLI config file (`tug.yml`, YAML or JSON) that records the control URL, default project, `deploy` defaults and the servers to install, where each key is the camelCase of the flag it defaults and flags always win. `node-install --name app1` reads the SSH target and install flags from `nodes.app1`. The API token is no longer read from the tracked config: it lives in the git-ignored `tug.local.yml` overlay (or `TUG_TOKEN`), `tug init` writes it there, and the config key is renamed from `operatorToken` to `token`. Source uploads now also exclude the overlay and the root config file.
- eae358e: Remove the `x-tug.type: nfs` volume type and its `x-tug.address` and `x-tug.export` keys. Tug never ran the NFS server, so users prepared the exporter anyway; mount a file server you operate with plain Compose `driver: local` and `driver_opts` instead. Backup validation no longer has an NFS exporter rule.
- 28c4156: Run scheduled backups. `x-tug.backup` on a service names a command run in the service's container whose output is stored (so any database or tool works, with recipes in the docs), and on a volume archives its files. Control schedules them, agents run restic in a helper container, and runs are recorded in a catalog with `backup.completed`, `backup.failed`, `backup.missed`, `backup.stale` and `backup.no_destination` events. Add `backup-run`, `backup-list` and restores (`restore`, `restore-list`, `restore-resume`, `restore-release`): an in-place restore locks the project, stops the services that write to the target, takes a safety backup, restores through the service's own `restore` command or the volume's files, and starts them again; a scratch restore of a volume touches nothing live.
- 28c4156: Add `tug run SERVICE -- command`: a one-off container with the service's image, environment, secrets, network and mounts, removed afterwards, returning the command's exit code and recorded as a `job.run` event.

### Patch Changes

- a14fb06: Correct node documentation: nodes need only the Docker Engine, not the Compose plugin, and the rollout and ingress descriptions now match the Engine API agent.

## 0.5.0

### Minor Changes

- c715f8b: Pin published images to registry digests before deployment so rollback and new nodes reuse the same image. Always deliver Tug-built images as saved archives, remove build-registry configuration and node registry tokens, and support private published images through the encrypted TUG_REGISTRY_AUTH project secret.

### Patch Changes

- 72c112b: Preserve base64url padding in private registry pull credentials so Docker Engine accepts authentication for all username and password lengths.
  
  Use a direct PHP health endpoint in the WordPress backup example so installed sites do not depend on their public ingress route to pass local health checks.
- 6840b72: Add reproducible Docker Compose benchmarks comparing nginx, Caddy proxying to nginx, and direct Caddy for PHP-FPM and static files, including latency, throughput and CPU measurements.
- 69dcba9: Use Node's built-in SQLite for control and agent state, removing SQLite native-addon installation and its Docker build toolchain. Node >= 22.18 remains supported. Snapshot creation and restore integrity checks run synchronously; large databases can briefly pause control traffic.

## 0.4.0

### Minor Changes

- f58e2f8: The agent reconciles containers through the Docker Engine API instead of the `docker compose` CLI (M14). `tug deploy` normalizes the Compose file with `docker compose config` on the operator machine (control secrets travel as sentinels), control validates a supported-key allowlist, nodes no longer need the Compose plugin, secrets are no longer written to `.env`, and `exec -t` gets a real PTY with resize. Tug now names its own network, volumes and containers (`tug_<project>`), so volumes created by earlier versions are not reused.

## 0.3.0

### Minor Changes

- 2e93255: Implement M6 placement and scheduling (node labels, label-based placement, replica spread, global mode, `tug scale`) and M7 NFS shared volumes.
- 2e93255: Add `tug node-remove` to delete a retired node and `control-install --mesh` to enable the WireGuard mesh on control.
- 319b45f: Published ports are private by default (M10). Generated Compose binds `ports` entries that name no host IP to the node's overlay IP when the mesh is on, to `127.0.0.1` when only the managed Caddy on the same node dials the service, and otherwise to the node's `address`, with a `ports.public` warning event when that address is public. Entries with an explicit host IP, including `0.0.0.0`, are unchanged, so write `"0.0.0.0:80:80"` to publish something on purpose. `tug doctor --nodes` adds a `ports.public` check listing containers of Tug projects that listen on a public address. A node's `--address` must be an IP on one of its interfaces (or a hostname that resolves to one), because ports bind to it.
- e14afdd: Wake agents immediately for deployments and queued work through an authenticated outbound WebSocket, with cursor-based long-poll and periodic polling fallbacks.
- db98497: Add live non-TTY exec, followed service logs, ps, and inspect over the outbound agent stream.

### Patch Changes

- 28c50c2: The agent now always runs with `--network host` (`node-install`, `node-enroll` and its cloud-init). Its TCP and HTTP health checks dial container IPs, which an agent on the default Docker bridge cannot reach on current Docker (29.x), so every first deploy on a fresh node failed health. `--mesh` still adds `NET_ADMIN` and `TUG_MESH`.
- 72e2b67: `--build-local-image` now builds for the target host's architecture, read with `uname -m` over SSH, instead of the machine running the CLI. Before, installing an amd64 VPS from an arm64 Mac produced an image that failed with `exec format error`.
- 74e6345: `control-install` can be run again over a running control to upgrade it. Its port preflight no longer fails when the port is held by the existing `tug-control-control-1` container; any other listener still fails it.
- 446a291: Agents pull published `image:` services only when a deployment revision is new to the node, instead of on every poll. Before, a tag that moved upstream (for example `mariadb:11`) was pulled and the container recreated within seconds without a deploy.
- 2e93255: Skip stale nodes when resolving label and `global` placement and in `tug scale`, so a dead host cannot hold a rollout open. Fix NFS volumes so consumers mount the exporter's overlay or node address and the exporter bind-mounts the export path.
- 446a291: Add an interim WordPress backup recipe: an `examples/wordpress-backup` Compose project with a restic backup sidecar (database dump, uploads, retention, health), and `docs/backups.md` with multi-node and NFS variants, a control-plane backup cron and a restore drill, until `x-tug.backup` (M11) exists.

## 0.2.1

### Patch Changes

- ac04ba0: Failed deploys now include the node apply error and any rollout error in the message `tug deploy` prints, instead of only "failed health". `tug logs` and `tug restart` name the project when the service is missing. `tug doctor --node` and `--nodes` wait for the agent result.
- f429756: Agents now report a service's lifecycle events only when something changes (a new revision, changed secrets or configuration), plus one event when an apply fails and one when it recovers, instead of four events per service on every poll. Control deletes events older than 30 days and keeps at most 100,000 (`TUG_EVENT_RETENTION_DAYS`, `TUG_EVENT_MAX_ROWS`), so `tug events` shows deployments, rollbacks and failures again.

## 0.2.0

### Minor Changes

- a052d94: Extend `--install-docker` beyond Debian and Ubuntu to Fedora and RHEL-compatible hosts (RHEL, Rocky Linux, AlmaLinux and CentOS Stream 9/10) using Docker's official dnf repository. Unsupported distributions still stop with an instruction to install Docker manually.
- 367a340: Deploy built applications without provisioning a registry: control stores verified compressed image archives and agents download them with their existing credentials. Add local application builds with `deploy --build-local`, immutable deployment revisions, rollback-safe image retention and image-aware control backups.
  
  Add opt-in Docker Engine/Compose setup with `--install-docker`. Use flat command names such as `control-install`, `node-install` and `secret-set`, stricter argument validation, and shared CLI configuration precedence. Set `--agent-control-url` when agents need a different control address from the operator, such as with an SSH tunnel or private network.
  
  Ship the Docker Compose plugin inside the Tug runtime image so agents installed on real hosts can apply application Compose files without depending on host CLI plugins.
- 8c72d59: Add opt-in zero-downtime rolling rollouts: a service with `x-tug.rollout: { strategy: rolling, drain: 30s }`, an ingress and a health check starts each new revision next to the old one on its own host port (`TUG_ROLLOUT_PORTS` on the agent), switches the Caddy ingress once it is healthy and removes the old revision after the drain. A revision that fails its health check is removed and the old one keeps serving. `recreate` stays the default and behaves as before.
  
  Add `x-tug: { rollback: auto }` at the top level of a Compose file to roll a failed deployment back automatically to the previous succeeded one (recorded as a `deployment.auto_rollback` event, never applied to rollback deployments). Deployment versions starting with `rollback-` are now reserved.
- 3a87fef: Add named, scoped API tokens for CI and teammates: `token-create`, `token-list` and `token-revoke` manage `read`, `deploy` and `admin` tokens, optionally limited to projects and with an optional expiry. Tokens are stored hashed, shown once, revocable immediately and included in control backups; the operator token keeps full access. Deployments and control events (deploy, rollback, cancel, restart, secret and token changes) now record the acting token, shown by `tug events` (use `--all` for events outside the current project). Includes a documented GitHub Actions deploy workflow in the new access-control guide.

## 0.1.0

### Minor Changes

- c548ed5: First public release: the `tug` CLI and `tug-node` agent/control entrypoint are published to npm as `@wpelevator/tug`, and the matching Docker image to `ghcr.io/wpelevator/tug`. `control install`, `node install` and `node enroll` now default `--image` to the image for the CLI's own version; `--build-local-image` replaces the old build-and-copy default.
