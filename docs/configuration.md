# Configuration

## CLI

`tug init` writes `.tug.json` in the current directory with the control URL, operator token and default project, so later commands don't need them repeated.

| Variable | Purpose |
|---|---|
| `TUG_CONFIG` | Path to the CLI config file (default `./.tug.json`). |
| `TUG_CONTROL_URL` | Control API URL; overrides the config file. |
| `TUG_TOKEN` | Operator token; overrides the config file. |

## Control plane

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | API port. |
| `TUG_DATA_DIR` | `./data` | SQLite database, master key, operator token, build contexts, backups. |
| `TUG_UPLOAD_DIR` | `<data dir>/uploads` | Temporary storage for uploaded build contexts. |
| `TUG_OPERATOR_TOKEN` | generated | Initial operator token, used only when none exists yet. The token is printed and written to `<data dir>/operator.token`. |
| `TUG_REGISTRY` | `localhost:5000` | Registry host used in built image references. |
| `TUG_PUSH` | `true` | Set `false` to build without pushing (local development). |
| `TUG_REGISTRY_AUTH_PATH` | unset | htpasswd file control manages per-node credentials in. |
| `TUG_REGISTRY_CONTAINER` | unset | Registry container restarted when credentials change. |
| `TUG_TLS_CERT_FILE`, `TUG_TLS_KEY_FILE` | unset | Serve HTTPS directly instead of plain HTTP. |
| `TUG_LOCK_TTL_MS` | `600000` | Lifetime of per-project operation locks. |
| `TUG_STALE_SECONDS` | `60` | Seconds without a poll before a node is marked `stale`. |
| `TUG_CONTROL_BACKUP_DIR` | `<data dir>/control-backups` | Control backup archives. |
| `TUG_CONTROL_RESTORE_DIR` | `<data dir>/control-restore` | Scratch directory for restores. |
| `TUG_MESH` | `false` | Set `true` to allocate overlay IPs, store WireGuard peers and send `network` blocks. See [Networking](networking.md). |
| `TUG_MESH_CIDR` | `10.210.0.0/16` | IPv4 overlay range (prefix `/8` to `/29`). |
| `TUG_WG_PORT` | `51820` | WireGuard UDP port nodes listen on, and the port appended to public addresses without one. |
| `TUG_SERVICE_DNS` | same as `TUG_MESH` | Publish health-aware `serviceEndpoints` so agents inject cross-node `extra_hosts`. Set `true` without the mesh to use plain node addresses. |
| `TUG_ACME_EMAIL` | unset | Email for ACME registration in rendered Caddy configs. |

## Agent

| Variable | Default | Purpose |
|---|---|---|
| `TUG_CONTROL_URL` | `http://localhost:8080` | Control URL; overrides the one in an enrollment key. |
| `TUG_AGENT_TOKEN` | unset | Agent token for push-installed or manually registered nodes. Takes precedence over persisted credentials. |
| `TUG_JOIN_KEY` / `TUG_JOIN_KEY_FILE` | unset | Enrollment key (or a file holding it) used when no token is available. |
| `TUG_NODE_NAME` | hostname | Node name when not bound by the enrollment key. |
| `TUG_NODE_ADDRESS`, `TUG_NODE_PUBLIC_ADDRESS` | unset | Addresses reported at enrollment. |
| `TUG_STATE_DIR` | `/var/lib/tug` | Credentials, applied state, WireGuard keys, ingress config and generated project files. |
| `TUG_POLL_INTERVAL_MS` | `5000` | Poll interval. |
| `TUG_APPLY` | `true` | Set `false` to render files and report without touching Docker. |
| `TUG_MESH` | `false` | Set `true` to generate a WireGuard key, report it and reconcile `wg0`. Needs `wg`, `ip`, host networking and `NET_ADMIN`. |
| `TUG_CADDY_IMAGE` | `caddy:2-alpine` | Image for the managed Caddy container on ingress nodes. |
| `NODE_EXTRA_CA_CERTS` | unset | Extra CA for a control plane with a private certificate. |

## Entrypoint

`TUG_ROLE=control|agent` selects the role when `src/main.ts` (`dist/main.js` in the image, whose entrypoint is `node dist/main.js`) is started without an argument.
