# Control plane

Install control on one VPS, and know how it authenticates, delivers images, backs itself up and recovers.

```sh
tug control setup root@control.example.com
```

`tug setup <ssh-target>` is the same command. On a fresh install it issues the root credential on the host over SSH and imports it into your local config as a `0600` file, so no separate `tug init` follows. In a terminal it shows a plan, offers to install Docker if missing and asks to confirm (`-y` skips it). Options are in the [CLI reference](cli.md#setup).

| I want to | Go to |
| --- | --- |
| Install control | [Install over SSH](#install-over-ssh) |
| Import a credential from elsewhere | [Credentials](#credentials-and-tug-init) |
| Understand certificates and trust | [Authentication and PKI](#authentication-and-pki) |
| Free disk used by build archives | [Image delivery](#image-delivery-without-a-registry) |
| Use a private registry | [Published images](#published-images-and-private-registries) |
| Back up or restore control | [Backup and restore](#backup-and-restore) |
| Upgrade | [Upgrade control and nodes](upgrades.md) |
| Re-address or move control | [Moving the control plane](#moving-the-control-plane) |
| Recover from loss or compromise | [Lost or compromised something](#lost-or-compromised-something) |

## Install over SSH

`control setup` runs SSH preflight checks on the host: Docker, at least 2048 MB free under Docker's data root, and the mTLS port free. It then starts the `control` container with `docker run` from `src/templates/control-install.sh` (no Compose plugin is needed), publishing one port (default `8443`) and mounting the `tug-control` volume.

| Topic | Behavior |
| --- | --- |
| Address clients use | `controlUrl` in the CLI config file (including any overlay), else the SSH target's host plus the published port (`https://control.example.com:8443`), which `control setup` prints. Pass `--control-url` or set `TUG_CONTROL_URL` to override, for example when you install through an SSH alias or a private address but clients reach control elsewhere. The credential URL is never an installation address. A configured URL keeps its public port even when `--port` publishes a different Docker host port. It is only an address, because clients verify the generated control name, not this URL |
| Running it again | Recreates the container on the same volume with only the flags you pass, so a port or extra name you leave out resets to its default. Upgrade with [`tug control upgrade`](upgrades.md) instead. Setup prints a note when its flags would change the settings of a control already there. On an install made before control stopped using Compose, it also removes the Compose file and network. It accepts the port when the existing `tug-control-control-1` container holds it and fails when anything else does |
| Docker | `--install-docker` installs Docker Engine first on a supported Debian, Ubuntu, Fedora or RHEL-compatible host |
| Root credential | Issued with `docker exec ... control issue-credential --name root --role admin` over SSH. It never lands in container logs or a permanent file on control. `--credential-out <file>` writes an extra copy, and `--no-import` skips the import. Upgrading or running setup again preserves credentials and never reissues root |
| Lost root | `tug control setup <ssh-target> --control-url https://control.example.com:8443 --recover-root` replaces only root's key without the API, closes its sessions within a second and audits the recovery. Other admins are unaffected |
| Image | `ghcr.io/wpelevator/tug:<CLI version>`, so control and the CLI match. `--image <tag>` uses another tag. `--build-local-image` builds from the current checkout (it needs the repository's Dockerfile in the working directory) and copies it over SSH with `docker save`, `scp` and `docker load`, tagged `tug:local` unless `--image` is given. See [Releases](releases.md) |
| New release | A release publishes the npm package a few minutes before its container image. A freshly updated CLI fails `tug setup` and `tug node add` before touching the host, with a message that the image is not published yet. Retry shortly, or pass `--image ghcr.io/wpelevator/tug:latest` |

Built images travel as compressed archives over the authenticated control connection. Published `image:` services pull directly from their upstream registry by the digest control resolved before the deployment was published.

### Credentials and `tug init`

To import a credential from elsewhere, for example one issued on another machine:

```sh
tug init root.credential.json
```

`tug init` copies the credential (a file, or `-` for stdin) into a `0600` file under `~/.config/tug/credentials/`, named `<control host>_<port>.<ca12>.json`, and points the git-ignored `tug.local.yml` at it. `<ca12>` is the first 12 hex characters of the CA's SHA-256 fingerprint, colons removed. The name makes importing a credential from a different control CA additive: it writes a new file and cannot overwrite the credential the CLI was working with, while a same-CA re-issue (a root recovery) keeps the same file. Importing across CAs prints a notice naming both fingerprints.

CI passes `TUG_CREDENTIAL` (the encoded credential) or `TUG_CREDENTIAL_FILE`. Precedence is `--credential <file>`, then the environment (setting both is an error), then the overlay's `credential` path. Tracked configuration may not name a credential.

## Authentication and PKI

Control listens on one TLS 1.3 port that requires a client certificate from every peer. There is no plain HTTP listener, no unauthenticated route (not even a health check, so monitor TCP reachability separately from authenticated readiness) and no bearer token. Operators, CI and nodes all use certificates signed by control's private CA. See [Access control](access-control.md) for identity classes, roles and key-based authorization.

| Part | Behavior |
| --- | --- |
| CA | A self-signed P-256 CA with a 10-year lifetime, created only for a fresh installation and kept at `<data dir>/pki/ca.key` (`0600`) and `ca.crt`. Missing, corrupt or mismatched CA material alongside existing state is a startup error. CA rotation is out of scope: replacing the CA means redistributing trust and credentials |
| Control name | `control-<first 12 hex of the CA key hash>.tug`, derived from the CA. Stable for the life of the CA, needs no configuration and survives backup and restore with `pki/`. Clients recompute it from the CA they pin and verify the server against it, so verification never depends on the address they dial |
| Server certificate | SANs are the control name, the host of `TUG_CONTROL_URL` (required: a credential-free `https://` origin including the published port, which is the default address written into credentials) and optional `TUG_EXTRA_SANS` (comma-separated DNS names and IPs). It lasts 90 days, is renewed at two thirds of its lifetime while running, and the TLS context reloads without a restart. Control warns when the CA nears expiry |
| Profiles | Control assigns every certificate. It verifies CSR signatures and P-256 keys and never copies requester-supplied subjects, SANs, validity or extensions. Leaves are `CA=false` with one assigned identity URI, back-dated five minutes and capped by the CA's validity |
| Connections | Chain validation rejects missing or foreign certificates during the handshake, before any HTTP is parsed. TLS session resumption is disabled and any reused session is closed, so every connection presents its certificate. A post-handshake gate then checks the database, and every request and WebSocket upgrade checks it again. Disable, replace, remove, revoke, root recovery and certificate expiry close the affected sockets: API-originated changes immediately, host-side changes within a second |
| Clients | The CLI and agent pin the credential's CA and verify the derived control name. `--control-url` and `--agent-control-url` change only the TCP connect target (for example `127.0.0.1:18082` through an SSH tunnel), and the credential's stored URL is the default. Moving control to a new IP or DNS name invalidates no credential |

**Deployment boundaries.** TCP passthrough works. TLS termination ahead of control breaks the client certificate, and TLS interception fails certificate validation. Browsers need explicit CA trust and an imported client credential, and browser setup is out of scope. Control's mutual TLS does not encrypt workload traffic between nodes, which uses your network ([Networking](networking.md#bring-your-own-network)).

### Backups and authorization history

`control backup` includes `pki/` (except the regenerable server certificate) and the key bindings. Restore validates the CA before changing live state, closes live sessions and requires a restart. Because authorization follows keys, a snapshot older than a certificate renewal does not lock a node out. An older snapshot still forgets nodes and operators created after it, restores keys that were replaced afterwards, and revives principals disabled or revoked afterwards.

After an older restore:

1. Recover root on the host if needed (`--recover-root`).
2. Reapply revocations and disables.
3. Run `tug node replace` for nodes whose key changed and `tug node add` for nodes created after the snapshot. After a CA loss, run `tug node replace --all`.

## Image delivery without a registry

Remote builds save immutable images under `<data dir>/images/<build ID>.tar.gz`. Agents download only the images assigned to them through `GET /agent/v1/images/:buildId`, verify the compressed SHA-256 and byte count, validate the saved image metadata and load the archive, with no registry pull. No registry certificate, daemon trust change or inbound connection to a node is needed, and downloads use the same mTLS connection as every other agent request.

A service with both `build:` and `image:` is not built unless you ask (`tug deploy --build`, or `x-tug.build: true`), see [Build or pull](compose.md#build-or-pull). `build.secrets` reach the build through the control process environment and BuildKit secret mounts. Control decrypts them only for the build, and they appear in no image layer, command argument, error text or deployment record. `build.additional_contexts` need `docker buildx` on control, and the deploy fails saying so when it is missing.

`tug deploy --build-local` builds on your machine and uploads archives instead of source. Control validates and imports them, gives them immutable tags and serves them to assigned agents. Builds are single-platform Linux images (amd64 or arm64), so use a Docker builder matching the target nodes. Agents reject an incompatible platform before starting it. This flag is distinct from the installers' development-only `--build-local-image`, which builds the tug runtime itself.

### Pruning

All published desired-state history is retained, and its image archives remain until pruned.

| Mechanism | Behavior |
| --- | --- |
| `tug image prune [--keep N] [--dry-run]` | Deletes the archives of everything except the newest `N` (default 5) distinct builds of each project (deployments that reuse an archive count once), the current deployment and any version a node still reports. `--dry-run` lists what would go |
| After each deploy | Control runs the same prune, keeping the newest `TUG_IMAGE_KEEP` distinct builds per project (default `5`, `0` turns it off), and caps the Docker build cache with `docker builder prune --all --keep-storage $TUG_BUILD_CACHE_KEEP` (default `10GB`, `0` turns it off). Both run after the response and only log a failure. See [Configuration](configuration.md#control-plane) |
| Rollback to a pruned build | Refused. The desired states stay in history, but the service must be deployed again |
| Identical rebuilds | A rebuild whose image ID equals one the project already has reuses that archive. The new deployment points at the existing build, no second archive is saved and the new per-deployment tag is removed. Nodes already hold that image, so they download nothing and keep the running container |
| Cleanup | Removes failed unpublished builds and orphan archives |
| Agents | Prune only their recorded, unused tug images that are absent from their authorized retained set, and never run a global Docker prune. An image whose archive was pruned leaves that set, so pruning on control also frees node disk once no container uses the image |

Each changed image is stored and transferred as a complete compressed image, with no layer sharing between archives. Never delete files under `images/` in control's data volume by hand: the database would still list them and nodes would get a 404.

## Published images and private registries

Control resolves each distinct published image tag once per deployment through the registry HTTPS manifest API and stores its SHA-256 digest in both desired service state and canonical Compose. Multi-platform images keep their complete index digest, so each node selects its architecture from the same immutable index. An explicit SHA-256 pin is validated and kept without a network lookup. If resolution fails, the deployment fails before replacing current desired state. Rollback and scaling reuse the stored pins without resolving tags again. Registries must keep pinned manifests and layers for rollback and fresh-node pulls, because tug does not mirror published images.

Private registry credentials live in the encrypted project secret `TUG_REGISTRY_AUTH`, a JSON object keyed by registry host (with a port when applicable):

```json
{"ghcr.io":{"username":"ci-user","password":"pull-token"},"docker.io":{"username":"hub-user","password":"hub-token"}}
```

```sh
printf %s "$GHCR_TOKEN" | tug registry login ghcr.io --username ci-user --project site
```

`tug registry login` reads the token on stdin and adds the host to the secret, keeping the hosts already there. GHCR needs a classic personal access token with `read:packages`. To write the whole JSON yourself, give it to `tug secret set TUG_REGISTRY_AUTH --project site` on stdin.

| Topic | Behavior |
| --- | --- |
| Docker Hub | Use the host `docker.io`, including for short image names |
| Supported | HTTPS registries with Basic or Bearer authentication |
| Not supported | Credential helpers and plaintext registries |
| Credentials | Use pull-only credentials |
| Who sees them | Control decrypts the secret for resolution. Assigned agents receive only credentials for their published image hosts through the authenticated secrets endpoint and pass them directly as Engine API `X-Registry-Auth`. They stay out of desired state, container environments and Docker login files, and referencing the reserved secret in a service definition is rejected |
| Rotation | Updates apply to future pull requests, including retries and rollback. Keep access to retained image digests when rotating credentials |

tug issues one node identity (key and certificate) per node. It does not push built images, manage registry users or log agents into registries. Teams that build images in CI push them themselves and deploy with `image:`.

## Backup and restore

`tug control backup --local` takes a consistent SQLite snapshot (including operator credential records) and writes a `0600` `.tar.gz`, in a `0700` directory, to `TUG_CONTROL_BACKUP_DIR` (default `<data dir>/control-backups`). The archive holds:

| Part | Notes |
| --- | --- |
| `tug.db`, `master.key`, `pki/` | State, the master key and the private CA |
| `images/` | Retained build archives. Leave them out with `--no-images`, and deploy again to rebuild them after a restore |
| Metadata | |

`tug control restore <artifactRef> --confirm` overwrites the database, master key and image store from such an archive. Restart control afterwards with `tug control restart`. Restore validates through a read-only connection before replacing live data, then rejects database-dependent requests with HTTP 503 until restart.

- **Pauses.** SQLite snapshot creation and restore integrity checking run synchronously and pause control API traffic, WebSocket handling and timers. Duration grows with data size and storage speed, and the reference measurements are in [Testing](testing.md#sqlite-contract-and-blocking-measurements). Take larger backups outside latency-sensitive rollout windows, and keep project lease durations above the expected blocking time.
- **Scope.** This backs up the control plane only. It does not capture workload volumes. Back up project data with `x-tug.backup`, see [Backups](backups.md).
- **Nightly archive.** Once a backup destination is set, control also stores a nightly archive of itself, without images, in the `_control` repository of that destination, see [Control plane backup](backups.md#control-plane-backup). `tug control backup --download [-o <file>]` takes an on-demand copy to your machine.
- **While control is down,** running containers keep serving, and agents cannot pick up new desired state until it is back.

### Recover control on another host

For a planned move of the whole installation, including workloads, see [Migrating to new servers](migration.md). The procedure below recovers control onto a different host with the original operator credential and a `node replace` to repoint each agent. Exercise results and their limits are in the [real-host evaluation](real-host-evaluation.md#recovery-drill), and a restore of six projects and two nodes onto a new host with 3.0.0 is in [Rolling, rollback, upgrade and recovery](real-host-evaluation.md#rolling-rollback-upgrade-and-recovery).

Keep control's public host name when you move it, because credentials verify that name. Only the connect address may change. Restore workload data separately from its project backups. Keep the control backup encrypted off the host, and keep the original operator credential and backup repository passwords separately, because the control archive contains the master key and private CA.

1. **Isolate the old control.** Stop or isolate it before directing agents to the replacement. Run `tug control stop <ssh-target>` for the old host, which stops the control container and leaves its volume, image and ports alone, or block its port. A stopped control stays stopped, also after the host reboots, until `tug control restart`. Two active control planes with divergent state are not a supported failover setup. Running workload containers keep serving while control is unavailable.
2. **Install the replacement.** Run `tug control setup` on the new host with the matching tug release, writing its temporary bootstrap credential to a private file. This initializes a new control and CA solely to authorize the restore.
3. **Restore the backup.** Choose where it comes from, and run the same command without `--confirm` first to check the backup and print what it holds.

   | Source | Command |
   | --- | --- |
   | A file you kept (for example from `tug control backup -o recovery.tar.gz`), decrypted | `tug control restore --from-file recovery.tar.gz --confirm --credential <bootstrap-credential>`. It uploads the file to the new control, so nothing is copied by hand |
   | The shared destination | `tug control restore --from-destination s3:https://s3.example.com/bucket/tug-backups --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --confirm --credential <bootstrap-credential>`. The new control reads the newest `_control` snapshot, and `--snapshot <id>` picks another from `tug control backup list`. The destination credentials and the control password you escrowed with `tug backup password --control` come from your environment (`TUG_CONTROL_BACKUP_PASSWORD`), or pipe the password in with `--password-stdin` and keep the credentials in the environment. They are used for this restore only |
   | An archive already on the control host | `tug control restore /data/restore-input.tar.gz --confirm` |

4. **Restart the control container.** The restore prints `restartRequired: true` and names the next step. Run `tug control restart <ssh-target>` on the new host with the original operator credential. It restarts the same container, so the image, volume and published ports stay as `control setup` made them. Restore replaces the bootstrap CA, credentials, state and image store, and the temporary credential no longer authenticates after restart. The database, master key and CA are replaced together, and if the restore is interrupted, the previous state is put back at the next start. Commands queued or running when the backup was taken are retired at that start instead of being delivered again, and the workload backup runs they carried are closed as missed or failed. You need only the backup, your original operator credential and, for a destination restore, the destination credentials and control password. No file from the old host is needed.
5. **Reconnect.** Use the original operator credential, and `--control-url https://<replacement-host>:8443` if the address changed. Verify the recovered projects, deployments and backup catalog. Repoint agents that still use the old address with `tug node replace <node> <ssh-target> --control-url https://<replacement-host>:8443 --agent-control-url https://<replacement-host>:8443 --credential <original-credential>`, then verify each node returns online and the site serves the expected data.

A snapshot older than later node or operator changes does not contain those changes, so follow [Backups and authorization history](#backups-and-authorization-history). This sequence does not replace a separate, tested backup of workload volumes or databases.

## Upgrading the control plane

Upgrades, version skew and rollback are in [Upgrade control and nodes](upgrades.md).

## Moving control data into the volume (`control migrate`)

Control installed by an earlier release keeps its data (database, master key, CA, build archives) in the host directory `/var/lib/tug-control`. Now it keeps it in the Docker volume `tug-control`, so nothing on the host is needed to move or rebuild the control host. `tug control setup` on an old host refuses and names this command, because a new install would start on an empty volume and create a second CA.

```sh
tug control migrate root@control.example.com
```

It rewrites nothing you chose: control keeps its image, URL, port and SANs. In order it:

1. Stops control, never removing it.
2. Copies the directory into the volume as root, with modes and SQLite files intact.
3. Writes a version marker into the volume last.
4. Points `/opt/tug-control/docker-compose.yml` at the volume.
5. Starts control again and waits for its CA.

If the copy fails, the old control starts again and the Compose file is untouched, and rerunning after any failure finishes the job. The old directory stays as a fallback and holds a copy of the master key and the CA, so remove it once control is healthy. Control stays on the image it was running, so the `0700` restriction control now puts on its data directory applies once `tug control setup` upgrades it, which works as before after migrating.

## Moving the control plane

Because clients verify the generated control name, the address is only a default.

1. Move or re-address the host and set the new `TUG_CONTROL_URL` on control, or rerun `control setup` with the new `--control-url`. Control adds the new address to its certificate on restart.
2. Until credentials are refreshed, point clients at the new address with `tug --control-url https://NEW:8443 ...` or `TUG_CONTROL_URL`. For an agent, rerun `tug node add <node> <ssh-target> --agent-control-url https://NEW:8443`, an idempotent upgrade that keeps the node's key and passes the new address to the agent as `TUG_CONTROL_URL`.
3. Optionally reissue credentials so they carry the new default: `control setup --recover-root` for root, `credential create` for others, `node replace` for nodes.

No credential becomes invalid because the address changed. The control name changes only if the CA itself is replaced, which requires redistributing every credential.

## Lost or compromised something

| Situation | What to do |
| --- | --- |
| Lost the root credential | `tug control setup <ssh-target> --recover-root` |
| A CI credential leaked | `tug credential revoke <name>`. Live sessions close within a second |
| A node is suspect | `tug node disable <node>` now, then `tug node replace` |
| A node's identity is corrupt or expired | `tug node repair` or `tug node replace` |
| Restored an older control backup | Recover root if needed, reapply revocations, then `node replace --all` ([Backups and authorization history](#backups-and-authorization-history)) |

## Access control and configuration

Besides the `root` admin credential, control accepts named operator credentials with `read`, `deploy` or `admin` roles, optionally limited to projects, for CI and teammates. See [Access control](access-control.md) for roles, the endpoint table, the audit trail and a GitHub Actions deploy example. Control environment variables are in [Configuration](configuration.md#control-plane).
