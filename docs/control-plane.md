# Control plane

## Install over SSH

```bash
tug control setup root@control.example.com
```

The address clients use by default comes from `controlUrl` in the CLI config file (`--config <file>` selects one), including any overlay override. Without it, the address is the SSH target's host plus the published port (`https://control.example.com:8443`), which `control setup` prints. Pass `--control-url` (or set `TUG_CONTROL_URL`) to override either default, for example when you install through an SSH alias or a private address but clients reach control elsewhere. The credential URL is never used as an installation address. A configured URL keeps its public port even when `--port` publishes a different Docker host port. It is only an address: clients verify the generated control name, not this URL. `control setup` runs SSH preflight checks on the host (Docker, Docker Compose, writable Tug paths, at least 2048 MB free under `/var/lib`, the mTLS port free), then starts the `control` container from `src/templates/control-compose.yml`, publishing one port (default `8443`). Add `--install-docker` to install Docker Engine and Compose first on a supported Debian, Ubuntu, Fedora and RHEL-compatible host.

On a fresh install it then issues the **root** credential on the host (`docker exec ... control issue-credential --name root --role admin` over SSH) and imports it straight into the local config as a `0600` file (`--credential-out <file>` optionally writes an extra copy; there is no default file); it never lands in container logs or a permanent file on control. Upgrading by running `control setup` again preserves credentials and never reissues root. If the root credential is lost, `tug control setup <ssh-target> --control-url https://control.example.com:8443 --recover-root` replaces only root's key without the API, closes its sessions within a second and audits the recovery; other admins are unaffected.

The control container runs the published image `ghcr.io/wpelevator/tug:<CLI version>` (the installed CLI's own package version, so control and the CLI match). Pass `--image <tag>` to use another tag, or `--build-local-image` to build the image from the current checkout and copy it to the host over SSH with `docker save` / `scp` / `docker load` (tagged `tug:local` unless `--image` is given); the latter is for development and needs the repository's Dockerfile in the working directory. See [Releases](releases.md). Running `control setup` again over an existing control upgrades it in place: the port preflight accepts the port when the existing `tug-control-control-1` container holds it, and still fails when anything else does.

Built images always travel as compressed archives over the authenticated control connection. Published `image:` services pull directly from their upstream registry by the digest resolved on control before deployment publication.

`control setup` (also available as `tug setup <ssh-target>`) imports the root credential into the local config automatically, the same way `tug init` does, so no separate step is needed. In a terminal it shows a plan and asks for confirmation (`-y, --yes` skips it) and offers to install Docker when it is missing. `--no-import` skips the import. To import a credential from elsewhere (for example one issued on another machine), run:

```bash
tug init root.credential.json
```

`tug init` copies the credential (a file, or `-` for stdin) into a `0600` file under `~/.config/tug/credentials/`, named `<control host>_<port>.<ca12>.json` where `<ca12>` is the first 12 hex characters of the CA's SHA-256 fingerprint with colons removed, and points the git-ignored `tug.local.yml` at it. The CA fingerprint in the name makes importing a credential from a different control CA additive: it writes a new file and cannot overwrite the credential the CLI was working with, while a same-CA re-issue (for example a root recovery) keeps the same file. Importing across CAs prints a notice that names both fingerprints. CI passes `TUG_CREDENTIAL` (the encoded credential) or `TUG_CREDENTIAL_FILE`; precedence is `--credential <file>`, then the environment (setting both is an error), then the overlay's `credential` path. Tracked configuration may not name a credential.

A release publishes the npm package a few minutes before its container image. A freshly updated CLI therefore fails `tug setup` and `tug node add` before touching the host, with a message that the image is not published yet; retry shortly, or pass `--image ghcr.io/wpelevator/tug:latest`.

## Authentication and PKI

Control listens on **one** TLS 1.3 port that requires a client certificate from every peer. There is no plain HTTP listener, no unauthenticated route (not even a health check: monitor TCP reachability separately from authenticated readiness) and no bearer token. Operators, CI and nodes all use certificates signed by control's private CA; see [Access control](access-control.md) for identity classes, roles and key-based authorization.

- **CA.** A self-signed P-256 CA (10-year lifetime) is created only for a fresh installation and kept at `<data dir>/pki/ca.key` (`0600`) and `ca.crt`. Missing, corrupt or mismatched CA material alongside existing state is a startup error. CA rotation is out of scope; replacing the CA means redistributing trust and credentials.
- **Control name.** Control has a generated name, `control-<first 12 hex of the CA key hash>.tug`, derived from its CA. It is stable for the life of the CA, needs no configuration and survives backup and restore with `pki/`. Clients recompute it from the CA they pin and verify the server against it, so verification never depends on the address they dial.
- **Server certificate.** SANs are the control name, the host of `TUG_CONTROL_URL` (required, a credential-free `https://` origin including the published port; the default address written into credentials) and optional `TUG_EXTRA_SANS` (comma-separated DNS names and IPs). The server certificate lasts 90 days, is renewed at two thirds of its lifetime while running, and the TLS context reloads without a restart. Control warns when the CA nears expiry.
- **Profiles.** Control assigns every certificate: it verifies CSR signatures and P-256 keys and never copies requester-supplied subjects, SANs, validity or extensions. Leaves are `CA=false` with one assigned identity URI, back-dated five minutes and capped by the CA's validity.
- **Connections.** Chain validation rejects missing or foreign certificates during the handshake, before any HTTP is parsed. TLS session resumption is disabled and any reused session is closed, so every connection presents its certificate. A post-handshake gate then checks the database, and every request and WebSocket upgrade checks it again. Disable, replace, remove, revoke, root recovery and certificate expiry close the affected sockets (API-originated changes immediately, host-side changes within a second).
- **Clients.** The CLI and agent pin the credential's CA and verify the control name derived from the CA. `--control-url` / `--agent-control-url` change only the TCP connect target (for example `127.0.0.1:18082` through an SSH tunnel), and the credential's stored URL is just the default target. Moving control to a new IP or DNS name therefore invalidates no credential; see [Moving the control plane](#moving-the-control-plane).

Deployment boundaries: TCP passthrough works. TLS termination ahead of control does not (it breaks the client certificate), and TLS interception fails certificate validation. Browsers need explicit CA trust and an imported client credential; browser setup is out of scope. Control's mutual TLS does not encrypt workload traffic between nodes; that traffic uses the operator's network ([Networking](networking.md#bring-your-own-network)).

### Backups and authorization history

`control backup` includes `pki/` (except the regenerable server certificate) and the key bindings. Restore validates the CA before changing live state, closes live sessions and requires a restart. Because authorization follows keys, a snapshot older than a certificate renewal does not lock a node out. An older snapshot still forgets nodes and operators created after it, restores keys that were replaced afterwards, and revives principals disabled or revoked afterwards. After an older restore: recover root on the host if needed (`--recover-root`), reapply revocations and disables, run `tug node replace` for nodes whose key changed and `tug node add` for nodes created after the snapshot (`tug node replace --all` after a CA loss).

## Image delivery without a registry

Remote builds save immutable images under `<data dir>/images/<build ID>.tar.gz`. Agents download only the images assigned to them through `GET /agent/v1/images/:buildId`, verify the compressed SHA-256 and byte count, validate the saved image metadata and load the archive. The agent loads those artifacts without a registry pull. No registry certificate, daemon trust change or inbound connection to a node is needed; downloads use the same mTLS connection as every other agent request.

`tug deploy --build-local` builds application images on the operator machine and uploads archives instead of source. Control validates and imports them, gives them immutable tags and serves them to assigned agents. Builds are single-platform Linux images (amd64 or arm64); use a Docker builder matching target nodes. Agents reject an incompatible image platform before starting it. This flag is distinct from the installers' development-only `--build-local-image`, which builds the Tug runtime itself.

All published desired-state history is retained, including rollback and lagging-node references. Its image archives remain available until you run `tug image prune`, which deletes the archives of everything except the newest `--keep N` (default 5) deployments of each project, the current deployment and any version a node still reports; `--dry-run` lists what would go. The desired states stay in history, but rolling back to one whose archive was pruned is refused and the service must be deployed again. Run it to reclaim disk, since each source build adds a full compressed image under `images/`. Cleanup removes failed unpublished builds and orphan archives. Agents prune only their recorded, unused Tug images absent from their authorized retained set and never run global Docker prune. Disk usage therefore grows with retained successful builds. Each transfer sends a complete compressed image, with no layer reuse.

## Published images and private registries

Control resolves each distinct published image tag once per deployment through the registry HTTPS manifest API and stores its SHA-256 digest in both desired service state and canonical Compose. Multi-platform images retain their complete index digest, allowing each node to select its architecture from that same immutable index. An explicit SHA-256 pin is validated and kept without a network lookup. If resolution fails, the deployment fails before replacing current desired state. Rollback and scaling reuse the stored pins without resolving tags again. Registries must retain pinned manifests and layers for rollback and fresh-node pulls; Tug does not mirror published images.

Private registry credentials live in the encrypted project secret `TUG_REGISTRY_AUTH`, a JSON object keyed by registry host (including a port when applicable):

```json
{"ghcr.io":{"username":"ci-user","password":"pull-token"},"docker.io":{"username":"hub-user","password":"hub-token"}}
```

Store it using `tug secret set TUG_REGISTRY_AUTH --project site` with the value on stdin. Use `docker.io` for Docker Hub, including short image names. HTTPS registries with Basic or Bearer authentication are supported; credential helpers and plaintext registries are not. Use credentials with pull access only. Control decrypts the secret for resolution; assigned agents receive only credentials for their published image hosts through the authenticated secrets endpoint and pass them directly as Engine API `X-Registry-Auth`. Credentials stay out of desired state, container environments and Docker login files; referencing the reserved secret in a service definition is rejected. Secret updates apply to future pull requests, including retries and rollback; keep access to retained image digests when rotating credentials.

Tug issues one node identity (key and certificate) per node. It does not push built images, manage registry users or log agents into registries. Teams building images in CI can push them themselves and deploy with `image:`.

## Backup and restore

`tug control backup` takes a consistent SQLite snapshot (including operator credential records) and writes a `0600` `.tar.gz` (in a `0700` directory) with `tug.db`, `master.key`, `pki/` (the private CA), retained `images/` archives (leave them out with `tug control backup --no-images`; deploy again to rebuild them after a restore) and metadata to `TUG_CONTROL_BACKUP_DIR` (default `<data dir>/control backups`). `tug control restore <artifactRef> --confirm` overwrites the database, master key and image store from such an archive; restart control afterwards. SQLite snapshot creation and restore integrity checking run synchronously and pause control API traffic, WebSocket handling and timers. Duration grows with data size and storage speed; the synthetic benchmark and reference measurements are in [Testing](testing.md#sqlite-contract-and-blocking-measurements). Take larger backups outside latency-sensitive rollout windows and keep project lease durations above expected blocking time. Restore validates through a read-only connection before replacing live data, then rejects database-dependent requests with HTTP 503 until restart. This is the control-plane backup: it covers disaster recovery of the control plane only and does not capture workload volume contents. Back up project data (volumes, databases) with `x-tug.backup` as described in [Backups](backups.md), which also shows a scheduled `control backup`.

Running containers keep serving while control is down; agents just cannot pick up new desired state until it is back.

### Recover control on another host

For a planned move of the whole installation, including workloads, see [Migrating to new servers](migration.md).

This procedure was exercised with the published 0.9.0 release on two VPSes; see [Real-host evaluation](real-host-evaluation.md#recovery-drill-with-the-published-090-release-2-november-2026) for the exact scope and limitations. Restore the workload data separately using its project backups. Keep the control backup encrypted off-host and keep the original operator credential and backup repository passwords separately; the control archive contains the master key and private CA.

1. Stop or isolate the old control plane before directing agents to the replacement. Two active control planes with divergent state are not a supported failover setup. Running workload containers continue serving while control is unavailable.
2. Install the matching Tug release on the replacement host with `tug control setup`, writing its temporary bootstrap credential to a private file. This initializes a new control and CA solely to authorize the restore.
3. Copy the decrypted control archive into the replacement control data directory with mode `0600`. The standard installer mounts host `/var/lib/tug-control` as `/data`: for example, a host file `/var/lib/tug-control/restore-input.tar.gz` is addressed to the API as `/data/restore-input.tar.gz`. The archive path is read on the control host; the CLI does not upload a local file.
4. Run `tug control restore /data/restore-input.tar.gz --confirm --credential <bootstrap-credential>`, then restart the control container. Restore replaces the bootstrap CA, credentials, state and image store; the temporary credential no longer authenticates after restart.
5. Connect with the original operator credential and use `--control-url https://<replacement-host>:8443` if the address changed. Verify the recovered projects, deployments and backup catalog. Agents that still point to the old address must be repointed; the tested 0.9.0 path was `tug node replace <node> <ssh-target> --control-url https://<replacement-host>:8443 --agent-control-url https://<replacement-host>:8443 --credential <original-credential>`. Verify that each node returns online and that the site serves the expected data.

A snapshot older than later node or operator changes does not contain those changes; follow the identity and revocation recovery notes in [Authentication and PKI](#authentication-and-pki). This sequence does not replace a separate, tested backup of workload volumes or databases.

## Upgrading the control plane

Control and the CLI must match closely enough that every route the CLI calls exists on the control. The check itself travels with ordinary traffic (the Docker `/_ping` bargain: version information rides headers, not dedicated round trips):

- The control stamps every HTTP response with its version (`x-tug-version`), so clients know what is answering them without a probe.
- Every CLI and agent HTTP request to the control declares the process's own version (`x-tug-client-version`; requests to anything else, such as agent health checks against your containers, never carry it); the WebSocket upgrades carry it too, but upgrade handling does not gate on it. The control refuses any request declaring a newer version than itself **before running the corresponding handler** — so a CLI ahead of the control is stopped by the surviving side itself, and an agent is refused rather than allowed to talk down what it assumes, matching the upgrade order below.
- A CLI grants itself the read-direction rule: read commands (`status`, service listings) judge the stamp on their own responses; since reads are safe to have run against an older control, they pay no extra request. Commands whose first control request is a mutation (`deploy`, `rollback`, `restart`, `backup`, restore), live commands that open the live channel without a read first (`exec`, `run`, `logs`, `ps`, `inspect` given an explicit node or running non-interactively), and `node add` take a one-request explicit probe (`GET /api/v1/version`) instead, so a mutating request is never already received by an old control when the refusal arrives.

Remediations:

- The control is older than the CLI (a missing stamp on a command's own read reports this too — the control predates both stamp and probe): the command is refused with `tug control setup <control host> --yes` as the fix. That redeploys the control container at the installed CLI's image tag and preserves the state and PKI in the `/data` volume.
- The CLI is older than the control: the command proceeds with one warning naming `npm i -g @wpelevator/tug@<version>` to pin the CLI to the control's version.

Rolling the control back below the agents' version is refused the same way: an agent newer than its control gets the control's refusal on every poll, logs it with the remedy, and keeps its containers running without reconciling until the versions agree. So roll the control back together with the agents (`tug node add --all` with the older CLI), or upgrade the control again, rather than leaving agents ahead of it.

Before an upgrade, keep the fallback lane: `ssh <host> docker tag ghcr.io/wpelevator/tug:<previous> tug:rollback`, then redeploy with `tug control setup <ssh-target> --image tug:rollback` if the new control misbehaves. Confirm the upgrade with `tug doctor` and `tug ps` right after, then match the agents with `tug node add --all` (see [Upgrading an agent](nodes.md#image)); see the [mismatch runbook](troubleshooting.md#cli-control-version-or-credentialca-mismatches) when `tug doctor` reports a CA fingerprint mismatch.

## Moving the control plane

Because clients verify the generated control name, the address is only a default:

1. Move or re-address the host and set the new `TUG_CONTROL_URL` on control (or rerun `control setup` with the new `--control-url`). Control adds the new address to its certificate on restart.
2. Until credentials are refreshed, point clients at the new address: `tug --control-url https://NEW:8443 ...` or `TUG_CONTROL_URL`, and for an agent set `TUG_CONTROL_URL` in `/etc/tug/agent.env`.
3. Optionally reissue credentials so they carry the new default: `control setup --recover-root` for root, `credential create` for others, `node replace` for nodes.

No credential becomes invalid because the address changed. The control name only changes if the CA itself is replaced, which requires redistributing every credential.

## Lost or compromised something

| Situation | What to do |
| --- | --- |
| Lost the root credential | `tug control setup <ssh-target> --recover-root` |
| A CI credential leaked | `tug credential revoke <name>`; live sessions close within a second |
| A node is suspect | `tug node disable <node>` now, then `tug node replace` |
| A node's identity is corrupt or expired | `tug node repair` or `tug node replace` |
| Restored an older control backup | Recover root if needed, reapply revocations, then `node replace --all` ([Control plane](control-plane.md#backups-and-authorization-history)) |

## Access control

Besides the `root` admin credential, control accepts named operator credentials with `read`, `deploy` or `admin` roles, optionally limited to projects, for CI and teammates. Every deployment and control event records the acting credential name. See [Access control](access-control.md) for the endpoint table, the audit trail and a GitHub Actions deploy example. Control stores each credential's name, role, scope and public-key hash (never a private key); these records travel with control backups.

## Configuration

See [Configuration](configuration.md#control-plane) for control environment variables.
