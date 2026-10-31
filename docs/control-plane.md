# Control plane

## Install over SSH

```bash
tug control-install root@control.example.com --token "$TUG_TOKEN"
```

`control-install` runs SSH preflight checks on the host (Docker, Docker Compose, writable Tug paths, at least 2048 MB free under `/var/lib`, the API port free), then starts the `control` container from `src/templates/control-compose.yml`. Add `--install-docker` to install Docker Engine and Compose first on a supported Debian, Ubuntu, Fedora and RHEL-compatible host. It prints the operator token and the control URL (`http://<host>:<port>`, port `8080` by default).

The control container runs the published image `ghcr.io/wpelevator/tug:<CLI version>` (the installed CLI's own package version, so control and the CLI match). Pass `--image <tag>` to use another tag, or `--build-local-image` to build the image from the current checkout and copy it to the host over SSH with `docker save` / `scp` / `docker load` (tagged `tug:local` unless `--image` is given); the latter is for development and needs the repository's Dockerfile in the working directory. See [Releases](releases.md). Running `control-install` again over an existing control upgrades it in place: the port preflight accepts the port when the existing `tug-control-control-1` container holds it, and still fails when anything else does.

Built images always travel as compressed archives over the authenticated control connection. Published `image:` services pull directly from their upstream registry by the digest resolved on control before deployment publication.

Then point the CLI at it:

```bash
tug init --control-url https://control.example.com --token "$TUG_TOKEN"
```

## TLS

`control-install` publishes the API over plain HTTP. Either front it with your own reverse proxy and TLS termination, or let control terminate TLS itself by setting `TUG_TLS_CERT_FILE` and `TUG_TLS_KEY_FILE`, for example with a self-signed certificate on a private network. Agents then use `TUG_CONTROL_URL=https://...`; for a private CA, set `NODE_EXTRA_CA_CERTS=<ca.pem>` on the agent or embed the CA in the enrollment key with `node-enroll --ca`.

## Image delivery without a registry

Remote builds save immutable images under `<data dir>/images/<build ID>.tar.gz`. Agents download only the images assigned to them through `GET /agent/v1/images/:buildId`, verify the compressed SHA-256 and byte count, validate the saved image metadata and load the archive. The agent loads those artifacts without a registry pull. No registry certificate, daemon trust change or inbound connection to a node is needed; control's existing TLS/CA configuration applies to downloads.

`tug deploy --build-local` builds application images on the operator machine and uploads archives instead of source. Control validates and imports them, gives them immutable tags and serves them to assigned agents. Builds are single-platform Linux images (amd64 or arm64); use a Docker builder matching target nodes. Agents reject an incompatible image platform before starting it. This flag is distinct from the installers' development-only `--build-local-image`, which builds the Tug runtime itself.

All published desired-state history is retained, including rollback and lagging-node references. Its image archives remain available indefinitely, with no limit on history count or disk size. Cleanup removes failed unpublished builds and orphan archives. Agents prune only their recorded, unused Tug images absent from their authorized retained set and never run global Docker prune. Disk usage therefore grows with retained successful builds. Each transfer sends a complete compressed image, with no layer reuse.

## Published images and private registries

Control resolves each distinct published image tag once per deployment through the registry HTTPS manifest API and stores its SHA-256 digest in both desired service state and canonical Compose. Multi-platform images retain their complete index digest, allowing each node to select its architecture from that same immutable index. An explicit SHA-256 pin is validated and kept without a network lookup. If resolution fails, the deployment fails before replacing current desired state. Rollback and scaling reuse the stored pins without resolving tags again. Registries must retain pinned manifests and layers for rollback and fresh-node pulls; Tug does not mirror published images.

Private registry credentials live in the encrypted project secret `TUG_REGISTRY_AUTH`, a JSON object keyed by registry host (including a port when applicable):

```json
{"ghcr.io":{"username":"ci-user","password":"pull-token"},"docker.io":{"username":"hub-user","password":"hub-token"}}
```

Store it using `tug secret-set TUG_REGISTRY_AUTH --project site` with the value on stdin. Use `docker.io` for Docker Hub, including short image names. HTTPS registries with Basic or Bearer authentication are supported; credential helpers and plaintext registries are not. Use credentials with pull access only. Control decrypts the secret for resolution; assigned agents receive only credentials for their published image hosts through the authenticated secrets endpoint and pass them directly as Engine API `X-Registry-Auth`. Credentials stay out of desired state, container environments and Docker login files; referencing the reserved secret in a service definition is rejected. Secret updates apply to future pull requests, including retries and rollback; keep access to retained image digests when rotating credentials.

Tug issues one agent credential per node. It does not push built images, manage registry users or log agents into registries. Teams building images in CI can push them themselves and deploy with `image:`.

## Backup and restore

`tug control-backup` takes a consistent SQLite snapshot (including API tokens) and writes a `.tar.gz` with `tug.db`, `master.key`, retained `images/` archives and metadata to `TUG_CONTROL_BACKUP_DIR` (default `<data dir>/control-backups`). `tug control-restore <artifactRef> --confirm` overwrites the database, master key and image store from such an archive; restart control afterwards. SQLite snapshot creation and restore integrity checking run synchronously and pause control API traffic, WebSocket handling and timers. Duration grows with data size and storage speed; the synthetic benchmark and reference measurements are in [Testing](testing.md#sqlite-contract-and-blocking-measurements). Take larger backups outside latency-sensitive rollout windows and keep project lease durations above expected blocking time. Restore validates through a read-only connection before replacing live data, then rejects database-dependent requests with HTTP 503 until restart. This covers disaster recovery of the control host only; back up project data (volumes, databases) with the restic sidecar in [Backups](backups.md), which also shows a scheduled `control-backup`.

Running containers keep serving while control is down; agents just cannot pick up new desired state until it is back.

## Access control

Besides the root operator token, control accepts named API tokens with `read`, `deploy` or `admin` roles, optionally limited to projects, for CI and teammates. Every deployment and control event records the acting token. See [Access control](access-control.md) for the endpoint table, the audit trail and a GitHub Actions deploy example. Tokens are stored hashed in the control database and travel with control backups.

## Configuration

See [Configuration](configuration.md#control-plane) for control environment variables.
