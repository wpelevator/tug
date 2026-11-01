# Configuration

## CLI

CLI options override environment variables, which override the config files and documented fallback. The config is a YAML or JSON file that is safe to commit: it holds the control URL, default project, defaults for a few command options and the servers you install. The operator credential is never read from it. See [Config file](cli.md#config-file) for the keys and how they map to flags, and [Nodes](nodes.md#declaring-nodes-in-the-config-file) for the `nodes` section.

| Variable | Purpose |
|---|---|
| `TUG_CONFIG` | Path to the CLI config file (default: `tug.yml`, `tug.yaml`, `tug.json` or `.tug.json` in the current directory). |
| `TUG_CONTROL_URL` | Connect target for the control API (an `https://` URL; for example a tunnel). The server is verified by its generated control name regardless; overrides the config file and the credential's default address. |
| `TUG_PROJECT` | Default project; overrides the config file. |
| `TUG_CREDENTIAL` | Encoded operator credential (for CI). Conflicts with `TUG_CREDENTIAL_FILE`; overrides the overlay. |
| `TUG_CREDENTIAL_FILE` | Path of a credential file; overrides the `credential` path in the untracked overlay. |

## Control plane

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8443` | The single mTLS port. |
| `TUG_ADVERTISE_URL` | required | Credential-free `https://` origin clients connect to by default, including the port. It is written into credentials and its host is added to the server certificate, but clients verify the generated control name, not this address. |
| `TUG_EXTRA_SANS` | unset | Comma-separated extra DNS names or IPs for the server certificate. |
| `TUG_RENEW_MIN_INTERVAL_MS` | `3600000` | Minimum time between certificate renewals per node. |
| `TUG_DATA_DIR` | `./data` | SQLite database, master key, `pki/` (CA and server certificate), image archives, build contexts and backups. |
| `TUG_UPLOAD_DIR` | `<data dir>/uploads` | Temporary storage for uploaded source contexts and local image archives. |
| `TUG_MAX_IMAGE_BYTES` | `5368709120` | Maximum bytes per uploaded file (source context or compressed image); expanded archives are limited to 20 GiB and 100,000 entries. |
| `TUG_LOCK_TTL_MS` | `600000` | Lease lifetime of per-project operation locks; active builds renew their lease. |
| `TUG_STALE_SECONDS` | `60` | Seconds without an authenticated work fetch, status report or wake wait before a node is marked `stale`. |
| `TUG_EVENT_RETENTION_DAYS` | `30` | Events older than this many days are deleted; `0` keeps events regardless of age. Pruning runs at startup and then at most once an hour while agents report events. |
| `TUG_EVENT_MAX_ROWS` | `100000` | Only this many of the newest events are kept; `0` removes the limit. A value that is not a whole number falls back to the default. |
| `TUG_CONTROL_BACKUP_DIR` | `<data dir>/control-backups` | Control backup archives. |
| `TUG_CONTROL_RESTORE_DIR` | `<data dir>/control-restore` | Scratch directory for restores. |
| `TUG_MESH` | `false` | Set `true` to allocate overlay IPs, store WireGuard peers and send `network` blocks. See [Networking](networking.md). |
| `TUG_MESH_CIDR` | `10.210.0.0/16` | IPv4 overlay range (prefix `/8` to `/29`). |
| `TUG_WG_PORT` | `51820` | WireGuard UDP port nodes listen on, and the port appended to public addresses without one. |
| `TUG_SERVICE_NAMES` | same as `TUG_MESH` | Publish health-aware `serviceEndpoints` so agents inject cross-node `extra_hosts`. Set `true` without the mesh to use plain node addresses. |
| `TUG_ACME_EMAIL` | unset | Email for ACME registration in rendered Caddy configs. |

## Agent

| Variable | Default | Purpose |
|---|---|---|
| `TUG_CONTROL_URL` | unset | Connect-only override of the control address (for example a private endpoint); the server is verified by its generated control name. |
| `TUG_JOIN_KEY` / `TUG_JOIN_KEY_FILE` | unset | Join key (or a `0600` file holding it) used only when the node has no identity yet; ignored once `agent.json` exists. |
| `TUG_NODE_NAME` | hostname | Node name when not bound by the enrollment key. |
| `TUG_NODE_ADDRESS`, `TUG_NODE_PUBLIC_ADDRESS` | unset | Addresses reported at enrollment. |
| `TUG_STATE_DIR` | `/var/lib/tug` | Identity (`agent.json`, `agent-pending.json`), applied revisions, managed-image identities, temporary image downloads, WireGuard keys, ingress config and generated project files. |
| `TUG_POLL_INTERVAL_MS` | `5000` | Maximum quiet interval between reconciliations. A WebSocket or long-poll wake can start one sooner. |
| `TUG_APPLY` | `true` | Set `false` to render files and report without touching Docker. |
| `TUG_MESH` | `false` | Set `true` to generate a WireGuard key, report it and reconcile `wg0`. Needs `wg`, `ip`, host networking and `NET_ADMIN`. |
| `TUG_ROLLOUT_PORTS` | `20000-20999` | Host port range (`LOW-HIGH`) for revisions of rolling services; each running or draining revision uses one port. |
| `TUG_CADDY_IMAGE` | `caddy:2-alpine` | Image for the managed Caddy container on ingress nodes. |
| `NODE_EXTRA_CA_CERTS` | unset | Extra CA for a control plane with a private certificate. |

## Entrypoint

`TUG_ROLE=control|agent` selects the role when `src/main.ts` (`dist/main.js` in the image, whose entrypoint is `node dist/main.js`) is started without an argument. An argument always wins over the variable. The runtime image has no default command, so `docker run -e TUG_ROLE=agent tug` starts the agent and a bare `docker run tug` prints the usage message; the installers and the compose files pass the role as an argument.
