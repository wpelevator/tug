# Control plane

## Install over SSH

```bash
tug control-install root@control.example.com --token "$TUG_TOKEN"
```

`control-install` runs SSH preflight checks on the host (Docker, Docker Compose, writable Tug paths, at least 2048 MB free under `/var/lib`, the API port free), then starts the `control` container from `src/templates/control-compose.yml`. Add `--install-docker` to install Docker Engine and Compose first on a supported Debian, Ubuntu, Fedora and RHEL-compatible host. It prints the operator token and the control URL (`http://<host>:<port>`, port `8080` by default).

The control container runs the published image `ghcr.io/wpelevator/tug:<CLI version>` (the installed CLI's own package version, so control and the CLI match). Pass `--image <tag>` to use another tag, or `--build-local-image` to build the image from the current checkout and copy it to the host over SSH with `docker save` / `scp` / `docker load` (tagged `tug:local` unless `--image` is given); the latter is for development and needs the repository's Dockerfile in the working directory. See [Releases](releases.md). Running `control-install` again over an existing control upgrades it in place: the port preflight accepts the port when the existing `tug-control-control-1` container holds it, and still fails when anything else does.

`--registry <host>` is optional. Without it, control stores built images as compressed archives and agents download them over the authenticated control connection. Published `image:` services still pull from their declared registry. With it, control pushes built images to that registry. If the registry uses an htpasswd file and you want Tug to manage per-node credentials, also pass `--registry-auth-path` (the htpasswd path as mounted into the control container) and `--registry-container` (the registry container to restart when credentials change).

Then point the CLI at it:

```bash
tug init --control-url https://control.example.com --token "$TUG_TOKEN"
```

## TLS

`control-install` publishes the API over plain HTTP. Either front it with your own reverse proxy and TLS termination, or let control terminate TLS itself by setting `TUG_TLS_CERT_FILE` and `TUG_TLS_KEY_FILE`, for example with a self-signed certificate on a private network. Agents then use `TUG_CONTROL_URL=https://...`; for a private CA, set `NODE_EXTRA_CA_CERTS=<ca.pem>` on the agent or embed the CA in the enrollment key with `node-enroll --ca`.

## Image delivery without a registry

With no registry configured, remote builds save immutable images under `<data dir>/images/<build ID>.tar.gz`. Agents download only the images assigned to them through `GET /agent/v1/images/:buildId`, verify the compressed SHA-256 and byte count, validate the saved image metadata and load the archive. Generated Compose sets `pull_policy: never` for those services. No registry certificate, daemon trust change or inbound connection to a node is needed; control's existing TLS/CA configuration applies to downloads.

`tug deploy --build-local` builds application images on the operator machine and uploads archives instead of source. Control validates and imports them, gives them immutable tags and either serves them or pushes them to the configured registry. Builds are single-platform Linux images (amd64 or arm64); use a Docker builder matching target nodes. Agents reject an incompatible image platform before starting it. This flag is distinct from the installers' development-only `--build-local-image`, which builds the Tug runtime itself.

All published desired-state history is retained, including rollback and lagging-node references. Its image archives remain available indefinitely, with no limit on history count or disk size. Cleanup removes failed unpublished builds and orphan archives. Agents prune only their recorded, unused Tug images absent from their authorized retained set and never run global Docker prune. Disk usage therefore grows with retained successful builds. Each transfer sends a complete compressed image, with no layer reuse.

## Registry

Every node gets a registry pull token at registration or enrollment. When `TUG_REGISTRY_AUTH_PATH` is set, control writes a bcrypt htpasswd entry per node (username = node name) and restarts `TUG_REGISTRY_CONTAINER`, so the registry itself enforces the tokens. `node-install --registry <host>` runs `docker login` on the node; enrolled agents log in on startup.

- `tug node-rotate-registry-token <node>` issues a new token and invalidates the old one.
- `tug node-revoke-registry-token <node>` removes the node's credential so future pulls fail until it is rotated.

## Backup and restore

`tug control-backup` takes a consistent SQLite snapshot (including API tokens) and writes a `.tar.gz` with `tug.db`, `master.key`, retained `images/` archives and metadata to `TUG_CONTROL_BACKUP_DIR` (default `<data dir>/control-backups`). `tug control-restore <artifactRef> --confirm` overwrites the database, master key and image store from such an archive; restart control afterwards. This covers disaster recovery of the control host only; back up project data (volumes, databases) with the restic sidecar in [Backups](backups.md), which also shows a scheduled `control-backup`.

Running containers keep serving while control is down; agents just cannot pick up new desired state until it is back.

## Access control

Besides the root operator token, control accepts named API tokens with `read`, `deploy` or `admin` roles, optionally limited to projects, for CI and teammates. Every deployment and control event records the acting token. See [Access control](access-control.md) for the endpoint table, the audit trail and a GitHub Actions deploy example. Tokens are stored hashed in the control database and travel with control backups.

## Configuration

See [Configuration](configuration.md#control-plane) for control environment variables.
