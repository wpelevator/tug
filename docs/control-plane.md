# Control plane

## Install over SSH

```bash
tug control-install root@control.example.com
```

The address clients use by default is the SSH target's host plus the published port (`https://control.example.com:8443`); `control-install` prints it. Pass `--advertise-url` to override it, for example when you install through an SSH alias or a private address but clients reach control elsewhere. It is only an address: clients verify the generated control name, not this URL. `control-install` runs SSH preflight checks on the host (Docker, Docker Compose, writable Tug paths, at least 2048 MB free under `/var/lib`, the mTLS port free), then starts the `control` container from `src/templates/control-compose.yml`, publishing one port (default `8443`). Add `--install-docker` to install Docker Engine and Compose first on a supported Debian, Ubuntu, Fedora and RHEL-compatible host.

On a fresh install it then issues the **root** credential on the host (`docker exec ... control issue-credential --name root --role admin` over SSH) and writes it straight to a local `0600` file (`--credential-out`, default `tug-root.credential.json`); it never lands in container logs or a permanent file on control. Upgrading by running `control-install` again preserves credentials and never reissues root. If the root credential is lost, `tug control-install <ssh-target> --advertise-url ... --recover-root` replaces only root's key without the API, closes its sessions within a second and audits the recovery; other admins are unaffected.

The control container runs the published image `ghcr.io/wpelevator/tug:<CLI version>` (the installed CLI's own package version, so control and the CLI match). Pass `--image <tag>` to use another tag, or `--build-local-image` to build the image from the current checkout and copy it to the host over SSH with `docker save` / `scp` / `docker load` (tagged `tug:local` unless `--image` is given); the latter is for development and needs the repository's Dockerfile in the working directory. See [Releases](releases.md). Running `control-install` again over an existing control upgrades it in place: the port preflight accepts the port when the existing `tug-control-control-1` container holds it, and still fails when anything else does.

Built images always travel as compressed archives over the authenticated control connection. Published `image:` services pull directly from their upstream registry by the digest resolved on control before deployment publication.

Then import the credential and point the CLI at it:

```bash
tug init tug-root.credential.json
```

`tug init` copies the credential (a file, or `-` for stdin) into a `0600` file under `~/.config/tug/credentials/` and points the git-ignored `tug.local.yml` at it. CI passes `TUG_CREDENTIAL` (the encoded credential) or `TUG_CREDENTIAL_FILE`; precedence is `--credential <file>`, then the environment (setting both is an error), then the overlay's `credential` path. Tracked configuration may not name a credential.

## Authentication and PKI

Control listens on **one** TLS 1.3 port that requires a client certificate from every peer. There is no plain HTTP listener, no unauthenticated route (not even a health check: monitor TCP reachability separately from authenticated readiness) and no bearer token. Operators, CI and nodes all use certificates signed by control's private CA; see [Access control](access-control.md) for identity classes, roles and key-based authorization.

- **CA.** A self-signed P-256 CA (10-year lifetime) is created only for a fresh installation and kept at `<data dir>/pki/ca.key` (`0600`) and `ca.crt`. Missing, corrupt or mismatched CA material alongside existing state is a startup error. CA rotation is out of scope; replacing the CA means redistributing trust and credentials.
- **Control name.** Control has a generated name, `control-<first 12 hex of the CA key hash>.tug`, derived from its CA. It is stable for the life of the CA, needs no configuration and survives backup and restore with `pki/`. Clients recompute it from the CA they pin and verify the server against it, so verification never depends on the address they dial.
- **Server certificate.** SANs are the control name, the host of `TUG_ADVERTISE_URL` (required, a credential-free `https://` origin including the published port; the default address written into credentials) and optional `TUG_EXTRA_SANS` (comma-separated DNS names and IPs). The server certificate lasts 90 days, is renewed at two thirds of its lifetime while running, and the TLS context reloads without a restart. Control warns when the CA nears expiry.
- **Profiles.** Control assigns every certificate: it verifies CSR signatures and P-256 keys and never copies requester-supplied subjects, SANs, validity or extensions. Leaves are `CA=false` with one assigned identity URI, back-dated five minutes and capped by the CA's validity.
- **Connections.** Chain validation rejects missing or foreign certificates during the handshake, before any HTTP is parsed. TLS session resumption is disabled and any reused session is closed, so every connection presents its certificate. A post-handshake gate then checks the database, and every request and WebSocket upgrade checks it again. Disable, replace, remove, revoke, root recovery and certificate expiry close the affected sockets (API-originated changes immediately, host-side changes within a second).
- **Clients.** The CLI and agent pin the credential's CA and verify the control name derived from the CA. `--control-url` / `--agent-control-url` change only the TCP connect target (for example `127.0.0.1:18082` through an SSH tunnel), and the credential's stored URL is just the default target. Moving control to a new IP or DNS name therefore invalidates no credential; see [Getting started](getting-started.md#moving-the-control-plane).

Deployment boundaries: TCP passthrough works. TLS termination ahead of control does not (it breaks the client certificate), and TLS interception fails certificate validation. Browsers need explicit CA trust and an imported client credential; browser setup is out of scope. The optional WireGuard mesh is a data-plane overlay and is unchanged ([Networking](networking.md)).

### Backups and authorization history

`control-backup` includes `pki/` (except the regenerable server certificate) and the key bindings. Restore validates the CA before changing live state, closes live sessions and requires a restart. Because authorization follows keys, a snapshot older than a certificate renewal does not lock a node out. An older snapshot still forgets nodes and operators created after it, restores keys that were replaced afterwards, and revives principals disabled or revoked afterwards. After an older restore: recover root on the host if needed (`--recover-root`), reapply revocations and disables, run `tug node-replace-identity` for nodes whose key changed and `tug node-install` for nodes created after the snapshot (`tug node-replace-identity --all` after a CA loss).

## Image delivery without a registry

Remote builds save immutable images under `<data dir>/images/<build ID>.tar.gz`. Agents download only the images assigned to them through `GET /agent/v1/images/:buildId`, verify the compressed SHA-256 and byte count, validate the saved image metadata and load the archive. The agent loads those artifacts without a registry pull. No registry certificate, daemon trust change or inbound connection to a node is needed; downloads use the same mTLS connection as every other agent request.

`tug deploy --build-local` builds application images on the operator machine and uploads archives instead of source. Control validates and imports them, gives them immutable tags and serves them to assigned agents. Builds are single-platform Linux images (amd64 or arm64); use a Docker builder matching target nodes. Agents reject an incompatible image platform before starting it. This flag is distinct from the installers' development-only `--build-local-image`, which builds the Tug runtime itself.

All published desired-state history is retained, including rollback and lagging-node references. Its image archives remain available indefinitely, with no limit on history count or disk size. Cleanup removes failed unpublished builds and orphan archives. Agents prune only their recorded, unused Tug images absent from their authorized retained set and never run global Docker prune. Disk usage therefore grows with retained successful builds. Each transfer sends a complete compressed image, with no layer reuse.

## Published images and private registries

Control resolves each distinct published image tag once per deployment through the registry HTTPS manifest API and stores its SHA-256 digest in both desired service state and canonical Compose. Multi-platform images retain their complete index digest, allowing each node to select its architecture from that same immutable index. An explicit SHA-256 pin is validated and kept without a network lookup. If resolution fails, the deployment fails before replacing current desired state. Rollback and scaling reuse the stored pins without resolving tags again. Registries must retain pinned manifests and layers for rollback and fresh-node pulls; Tug does not mirror published images.

Private registry credentials live in the encrypted project secret `TUG_REGISTRY_AUTH`, a JSON object keyed by registry host (including a port when applicable):

```json
{"ghcr.io":{"username":"ci-user","password":"pull-token"},"docker.io":{"username":"hub-user","password":"hub-token"}}
```

Store it using `tug secret-set TUG_REGISTRY_AUTH --project site` with the value on stdin. Use `docker.io` for Docker Hub, including short image names. HTTPS registries with Basic or Bearer authentication are supported; credential helpers and plaintext registries are not. Use credentials with pull access only. Control decrypts the secret for resolution; assigned agents receive only credentials for their published image hosts through the authenticated secrets endpoint and pass them directly as Engine API `X-Registry-Auth`. Credentials stay out of desired state, container environments and Docker login files; referencing the reserved secret in a service definition is rejected. Secret updates apply to future pull requests, including retries and rollback; keep access to retained image digests when rotating credentials.

Tug issues one node identity (key and certificate) per node. It does not push built images, manage registry users or log agents into registries. Teams building images in CI can push them themselves and deploy with `image:`.

## Backup and restore

`tug control-backup` takes a consistent SQLite snapshot (including operator credential records) and writes a `0600` `.tar.gz` (in a `0700` directory) with `tug.db`, `master.key`, `pki/` (the private CA), retained `images/` archives and metadata to `TUG_CONTROL_BACKUP_DIR` (default `<data dir>/control-backups`). `tug control-restore <artifactRef> --confirm` overwrites the database, master key and image store from such an archive; restart control afterwards. SQLite snapshot creation and restore integrity checking run synchronously and pause control API traffic, WebSocket handling and timers. Duration grows with data size and storage speed; the synthetic benchmark and reference measurements are in [Testing](testing.md#sqlite-contract-and-blocking-measurements). Take larger backups outside latency-sensitive rollout windows and keep project lease durations above expected blocking time. Restore validates through a read-only connection before replacing live data, then rejects database-dependent requests with HTTP 503 until restart. This is the control-plane backup: it covers disaster recovery of the control plane only and does not capture workload volume contents. Back up project data (volumes, databases) with `x-tug.backup` as described in [Backups](backups.md), which also shows a scheduled `control-backup`.

Running containers keep serving while control is down; agents just cannot pick up new desired state until it is back.

## Access control

Besides the `root` admin credential, control accepts named operator credentials with `read`, `deploy` or `admin` roles, optionally limited to projects, for CI and teammates. Every deployment and control event records the acting credential name. See [Access control](access-control.md) for the endpoint table, the audit trail and a GitHub Actions deploy example. Control stores each credential's name, role, scope and public-key hash (never a private key); these records travel with control backups.

## Configuration

See [Configuration](configuration.md#control-plane) for control environment variables.
