# Configuration

## CLI

`launchpad init` writes `.launchpad.json` in the current directory with the control URL, operator token and default project, so later commands don't need them repeated.

| Variable | Purpose |
|---|---|
| `LAUNCHPAD_CONFIG` | Path to the CLI config file (default `./.launchpad.json`). |
| `LAUNCHPAD_CONTROL_URL` | Control API URL; overrides the config file. |
| `LAUNCHPAD_TOKEN` | Operator token; overrides the config file. |

## Control plane

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | API port. |
| `LAUNCHPAD_DATA_DIR` | `./data` | SQLite database, master key, operator token, build contexts, backups. |
| `LAUNCHPAD_UPLOAD_DIR` | `<data dir>/uploads` | Temporary storage for uploaded build contexts. |
| `LAUNCHPAD_OPERATOR_TOKEN` | generated | Initial operator token, used only when none exists yet. The token is printed and written to `<data dir>/operator.token`. |
| `LAUNCHPAD_REGISTRY` | `localhost:5000` | Registry host used in built image references. |
| `LAUNCHPAD_PUSH` | `true` | Set `false` to build without pushing (local development). |
| `LAUNCHPAD_REGISTRY_AUTH_PATH` | unset | htpasswd file control manages per-node credentials in. |
| `LAUNCHPAD_REGISTRY_CONTAINER` | unset | Registry container restarted when credentials change. |
| `LAUNCHPAD_TLS_CERT_FILE`, `LAUNCHPAD_TLS_KEY_FILE` | unset | Serve HTTPS directly instead of plain HTTP. |
| `LAUNCHPAD_LOCK_TTL_MS` | `600000` | Lifetime of per-project operation locks. |
| `LAUNCHPAD_STALE_SECONDS` | `60` | Seconds without a poll before a node is marked `stale`. |
| `LAUNCHPAD_CONTROL_BACKUP_DIR` | `<data dir>/control-backups` | Control backup archives. |
| `LAUNCHPAD_CONTROL_RESTORE_DIR` | `<data dir>/control-restore` | Scratch directory for restores. |

## Agent

| Variable | Default | Purpose |
|---|---|---|
| `LAUNCHPAD_CONTROL_URL` | `http://localhost:8080` | Control URL; overrides the one in an enrollment key. |
| `LAUNCHPAD_AGENT_TOKEN` | unset | Agent token for push-installed or manually registered nodes. Takes precedence over persisted credentials. |
| `LAUNCHPAD_JOIN_KEY` / `LAUNCHPAD_JOIN_KEY_FILE` | unset | Enrollment key (or a file holding it) used when no token is available. |
| `LAUNCHPAD_NODE_NAME` | hostname | Node name when not bound by the enrollment key. |
| `LAUNCHPAD_NODE_ADDRESS`, `LAUNCHPAD_NODE_PUBLIC_ADDRESS` | unset | Addresses reported at enrollment. |
| `LAUNCHPAD_STATE_DIR` | `/var/lib/launchpad` | Credentials, applied state and generated project files. |
| `LAUNCHPAD_POLL_INTERVAL_MS` | `5000` | Poll interval. |
| `LAUNCHPAD_APPLY` | `true` | Set `false` to render files and report without touching Docker. |
| `NODE_EXTRA_CA_CERTS` | unset | Extra CA for a control plane with a private certificate. |

## Entrypoint

`LAUNCHPAD_ROLE=control|agent` selects the role when `src/main.js` is started without an argument.
