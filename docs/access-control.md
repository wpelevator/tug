# Access control

Control listens on one TLS port (default `8443`) and requires a client certificate from every peer. There is no plain HTTP listener, no unauthenticated route and no bearer token. Certificates are signed by control's private CA; clients pin that CA and still verify the server name. A missing or foreign certificate fails the TLS handshake before any HTTP is parsed. After the handshake, a gate and then every request and WebSocket upgrade check the principal in the database, so revocation and key replacement apply to the next request and close live sessions within a second.

The certificate's URI SAN names the **identity class**, which decides which routes the peer can reach at all:

| SAN | Class | May reach |
| --- | --- | --- |
| `tug:node:<id>` | node | `/agent/v1/*` (including `POST /agent/v1/renew` and the agent stream) |
| `tug:operator:<id>` | operator or CI | `/api/v1/*` and `/api/v1/live`, subject to role and project scope |
| `tug:enroll:<id>` | bootstrap | `POST /agent/v1/enroll` only |

A principal outside its class gets `403`. Authorization follows the **public key**, not the certificate: control stores the SHA-256 of each principal's SubjectPublicKeyInfo (`key_hash`) and accepts any CA-signed certificate for that key, so renewal is just signing another certificate for the same key. Replacing a key makes every certificate for the old key unusable at once.

Operator credentials come in two kinds, both with a unique name, a role and optionally allowed projects:

- **`root`** is an ordinary named admin issued on the control host by `tug control-install` (`control issue-credential --name root --role admin`). Upgrades never reissue it; `tug control-install --recover-root` replaces only root's key without the API.
- **Named credentials** are for CI systems, teammates and automation. Create them with `tug credential-create` (control generates the key and returns the credential once; it keeps no private-key copy) and revoke them with `tug credential-revoke`. They last one year at most.

Replace a credential by creating a new name, verifying it, updating consumers and then revoking the old name. Keep at least one verified admin throughout.

## Roles

Roles are cumulative.

| Role | Can do |
| --- | --- |
| `read` | Status, events, project and deployment records, volume listings and secret names (never values). No mutations. |
| `deploy` | Everything in `read`, plus create projects, deploy, roll back, cancel deployments, restart services, fetch service logs and read command results, for its allowed projects. |
| `admin` | Everything the operator token can do: secrets, volumes, nodes, enrollment, backups, restore, diagnostics and token management. Admin tokens cannot be limited to projects. |

A `deploy` credential must be trusted with its workloads' secrets: live `inspect` returns resolved container environment values, `exec` can read them, and deployed code can disclose any secret it receives. Setting and deleting secrets is `admin` only; listing secret names is `read`. The deploy role can trigger project backups, while control backups and restores require `admin`.

Project scope limits API access to project records; it does not isolate hosts or co-located projects. Current deployments can select shared nodes and request host bind mounts, external volumes, volume driver options and added capabilities. Treat deployment authors as administrators of the nodes they can select. Use separate hosts or control planes for mutually untrusted authors. See the [security audit](security.md) for the demonstrated boundaries and outstanding fixes.

## Endpoint table

This table is the contract. It mirrors `ROUTE_ROLES` in `src/credentials.ts`, `createApp` refuses to register a `/api/v1` route that is not listed there, and a test compares the table with the live router and with this page, so a new route cannot ship without a declared role.

The project column says how a scoped token's allowed projects are checked: the project comes from the request body, the query string (default `site`), the path, or the stored record for the given ID. Admin-only routes are control-wide.

| Route | Role | Project check |
| --- | --- | --- |
| `GET /api/v1/status` | `read` | Response is filtered to allowed projects |
| `GET /api/v1/events` | `read` | `project` query, or filtered to allowed projects |
| `GET /api/v1/projects/:project` | `read` | Path |
| `GET /api/v1/deployments/:id` | `read` | Deployment's project |
| `GET /api/v1/volumes` | `read` | Query |
| `GET /api/v1/secrets` | `read` | Query (names and versions only) |
| `POST /api/v1/projects` | `deploy` | Body `name` |
| `POST /api/v1/deployments` | `deploy` | Body or upload payload `project` |
| `POST /api/v1/deployments/:id/cancel` | `deploy` | Deployment's project |
| `POST /api/v1/rollback` | `deploy` | Body |
| `POST /api/v1/scale` | `deploy` | Body |
| `POST /api/v1/restart` | `deploy` | Body |
| `POST /api/v1/logs` | `deploy` | Body |
| `GET /api/v1/live` | `deploy` | First WebSocket frame |
| `GET /api/v1/commands/:id` | `deploy` | Command's project; commands without a project (diagnostics, key rotation) need `admin` |
| `POST /api/v1/backups/run` | `deploy` | Body `project` |
| `GET /api/v1/backups` | `read` | Query `project` |
| `POST /api/v1/restores` | `admin` | Body `project`; without `confirm` it only returns the plan |
| `GET /api/v1/restores` | `read` | Query `project` |
| `POST /api/v1/restores/:id/release` | `admin` | Drops the holds of an interrupted restore |
| `POST /api/v1/restores/:id/resume` | `admin` | Runs an interrupted restore again |
| `GET /api/v1/backup/destination` | `admin` | Control-wide; URL and variable names, never values |
| `POST /api/v1/backup/destination` | `admin` | Control-wide |
| `DELETE /api/v1/backup/destination` | `admin` | Control-wide |
| `GET /api/v1/backup/repository-password` | `admin` | Query `project`; prints the repository password |
| `POST /api/v1/secrets` | `admin` | Control-wide |
| `DELETE /api/v1/secrets/:name` | `admin` | Control-wide |
| `DELETE /api/v1/volumes/:name` | `admin` | Control-wide |
| `GET /api/v1/nodes` | `admin` | Control-wide |
| `POST /api/v1/nodes/:name/identity` | `admin` | Control-wide |
| `POST /api/v1/nodes/:name/disable` | `admin` | Control-wide |
| `POST /api/v1/nodes/enrollment-credential` | `admin` | Control-wide |
| `POST /api/v1/nodes/:name/rotate-wg-key` | `admin` | Control-wide |
| `POST /api/v1/nodes/:name/ingress` | `admin` | Control-wide |
| `DELETE /api/v1/nodes/:name` | `admin` | Control-wide |
| `POST /api/v1/control/backups/run` | `admin` | Control-wide |
| `POST /api/v1/control/restore` | `admin` | Control-wide |
| `GET /api/v1/diagnostics` | `admin` | Control-wide |
| `POST /api/v1/diagnostics/nodes` | `admin` | Control-wide |
| `POST /api/v1/credentials` | `admin` | Control-wide |
| `GET /api/v1/credentials` | `admin` | Control-wide |
| `DELETE /api/v1/credentials/:name` | `admin` | Control-wide |

## Failures

- `401` means the certificate is unknown, revoked, expired, disabled or its key is not the stored one. A missing or foreign certificate never gets this far: the TLS handshake fails.
- `403` means the token is valid but its role is too low (`forbidden: this action requires the deploy role`) or the project is outside its scope (`forbidden: this token may not access that project`). The project message is identical whether the other project exists, whether a deployment or command ID exists, or whether the project name is valid, so a scoped token cannot probe for projects or IDs.

## Projects and scoping

A `read` or `deploy` token created with `--project` may only act on those projects. Listings are filtered rather than refused: `status` returns only allowed projects, their deployments and their node status, and `events` without `--project` returns only events of allowed projects (events without a project, such as token changes and node events, are hidden from scoped tokens). A token without `--project` covers every project, including ones created later. `status` still lists node names and health to every token, since placement names appear in Compose files.

## Audit trail

Every deployment and every control event records the acting token name, `root` for the root credential. `tug events` and `GET /api/v1/events` return it as `actor`, and deployment records (`GET /api/v1/deployments/:id`, `tug status`) carry it as `actor`. Control actions write events of these types: `deploy`, `rollback`, `cancel`, `restart`, `secret.set`, `secret.delete`, `credential.create` and `credential.revoke`. Events never contain secret values or token secrets. Rollbacks that control starts by itself (`x-tug: { rollback: auto }`, see [Compose extensions](compose.md#automatic-rollback)) and their `deployment.auto_rollback` events are attributed to the reserved actor `system:auto-rollback`; token names cannot contain a colon, so no token can use it. Events written by agents have no `actor`. Control events that belong to no project (token changes) show up in `tug events --all`.

## Managing tokens

```bash
tug credential-create ci-site --role deploy --project site
tug credential-create ci-site --role deploy --project site --project blog --expires-in-days 90
tug credential-create alice --role read
tug credential-list
tug credential-revoke ci-site
```

- Names are 1 to 64 letters, numbers, dots, underscores or hyphens. A revoked credential keeps its name so audit entries stay unambiguous; choose a new name to replace it.
- `credential-create` prints the credential once, on stdout; a note on stderr reminds you to store it. Only the key hash is stored, so a lost credential cannot be recovered, only replaced.
- `credential-list` shows name, role, projects, creator, creation, last use, expiry and revocation time, never secrets.
- Revocation applies to the next request. Expired tokens are refused with `401` the same way. `last_used_at` is refreshed at most once a minute in the background, so it is approximate and bookkeeping never delays or fails a request.
- Tokens live in the control database, so they are part of `tug control-backup` and come back with `tug control-restore`; a restore returns the token set (including revocations) to the backup's state.
- `root` is listed like any other admin credential. Use `--recover-root` if its credential is lost; prefer day-to-day use of named admin credentials.

## Deploying from GitHub Actions

Create a project-scoped `deploy` token and store it with the control URL as repository secrets:

```bash
tug credential-create github-site --role deploy --project site
```

Add `TUG_CREDENTIAL` (the printed credential) under the repository's Settings, Secrets and variables, Actions. A workflow:

```yaml
name: Deploy
on:
  push:
    branches: [main]

concurrency:
  group: deploy-site
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Deploy
        env:
          TUG_CREDENTIAL: ${{ secrets.TUG_CREDENTIAL }}
          TUG_PROJECT: site
        run: npx --yes @wpelevator/tug deploy -f docker-compose.yml --version "git-${GITHUB_SHA::12}"
```

`deploy` waits for the rollout and fails the job when the deployment fails or times out (add `--no-wait` to return immediately). Services with `build:` upload the checkout for a remote build on control; add `--build-local` to build on the runner, which has Docker, and upload the images instead. Pin the CLI version (`@wpelevator/tug@<version>`) to match your control plane. Rolling back from CI needs only the same token (`npx @wpelevator/tug rollback`).

## Limits

- A `deploy` token can run any image or Compose configuration on the nodes of its projects, execute commands in those containers, and read their logs and raw Docker inspection data. Treat it as access to those nodes: inspection data can include environment variables, and logs can contain whatever the application prints. Scope tokens to the projects they need and expire short-lived ones.
- Control-wide state (nodes, backups, diagnostics, tokens, secrets and volume deletion) is admin only. There is no per-project secret management role.
- Roles and project scopes are fixed at creation; to change them, create a new token and revoke the old one.
- A `deploy` event is written when a deployment is published. A build that fails before publishing appears only in its deployment record (with its `actor`), not as an event.
