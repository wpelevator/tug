# Control plane

## Install over SSH

```bash
tug control install root@control.example.com --token "$TUG_TOKEN" --registry registry.example.com
```

`control install` runs SSH preflight checks on the host (Docker, Docker Compose, writable Tug paths, at least 2048 MB free under `/var/lib`, the API port free), builds the local Tug image and transfers it with `docker save` / `scp` / `docker load` (skip with `--no-transfer-image`), then starts the `control` container from `src/templates/control-compose.yml`. It prints the operator token and the control URL (`http://<host>:<port>`, port `8080` by default).

`--registry <host>` is required: Tug does not provision a registry and uses this host in built image references. If the registry uses an htpasswd file and you want Tug to manage per-node credentials, also pass `--registry-auth-path` (the htpasswd path as mounted into the control container) and `--registry-container` (the registry container to restart when credentials change).

Then point the CLI at it:

```bash
tug init --control-url https://control.example.com --token "$TUG_TOKEN"
```

## TLS

`control install` publishes the API over plain HTTP. Either front it with your own reverse proxy and TLS termination, or let control terminate TLS itself by setting `TUG_TLS_CERT_FILE` and `TUG_TLS_KEY_FILE`, for example with a self-signed certificate on a private network. Agents then use `TUG_CONTROL_URL=https://...`; for a private CA, set `NODE_EXTRA_CA_CERTS=<ca.pem>` on the agent or embed the CA in the enrollment key with `node enroll --ca`.

## Registry

Every node gets a registry pull token at registration or enrollment. When `TUG_REGISTRY_AUTH_PATH` is set, control writes a bcrypt htpasswd entry per node (username = node name) and restarts `TUG_REGISTRY_CONTAINER`, so the registry itself enforces the tokens. `node install --registry <host>` runs `docker login` on the node; enrolled agents log in on startup.

- `tug node:rotate-registry-token <node>` issues a new token and invalidates the old one.
- `tug node:revoke-registry-token <node>` removes the node's credential so future pulls fail until it is rotated.

## Backup and restore

`tug control-backup run` checkpoints SQLite and writes a `.tar.gz` with `tug.db`, `master.key` and metadata to `TUG_CONTROL_BACKUP_DIR` (default `<data dir>/control-backups`). `tug control-backup restore <artifactRef> --confirm` overwrites the database and master key from such an archive; restart control afterwards. This covers disaster recovery of the control host only; back up project data (volumes, databases) with your own tooling.

Running containers keep serving while control is down; agents just cannot pick up new desired state until it is back.

## Configuration

See [Configuration](configuration.md#control-plane) for control environment variables.
