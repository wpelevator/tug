# Access control

The control API accepts two kinds of credentials, both sent as `Authorization: Bearer <token>` and both usable anywhere `TUG_TOKEN` is:

- The **operator token** is the root credential created when control first starts (`TUG_OPERATOR_TOKEN`, or generated and written to `<data dir>/operator.token`). It has full access and appears as `operator` in the audit trail. Nothing about existing installs changes.
- **Named API tokens** are narrower credentials for CI systems, teammates and automation. Each has a unique name, a role and optionally a list of allowed projects. Create them with `tug token-create`, and revoke them with `tug token-revoke`.

Agents (`/agent/v1/*`) use their node agent credentials; API tokens, including admin tokens and the operator token, are refused on agent endpoints.

## Roles

Roles are cumulative.

| Role | Can do |
| --- | --- |
| `read` | Status, events, project and deployment records, volume listings and secret names (never values). No mutations. |
| `deploy` | Everything in `read`, plus create projects, deploy, roll back, cancel deployments, restart services, fetch service logs and read command results, for its allowed projects. |
| `admin` | Everything the operator token can do: secrets, volumes, nodes, enrollment, backups, restore, diagnostics and token management. Admin tokens cannot be limited to projects. |

A `deploy` token can never read secret values (no API endpoint returns them to an operator at all), and cannot set or delete secrets, manage nodes, take or restore backups, run diagnostics or manage tokens. Setting and deleting secrets is `admin` only; listing secret names is `read`.

## Endpoint table

This table is the contract. It mirrors `ROUTE_ROLES` in `src/tokens.ts`, `createApp` refuses to register a `/api/v1` route that is not listed there, and a test compares the table with the live router and with this page, so a new route cannot ship without a declared role.

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
| `GET /api/v1/backup/destination` | `admin` | Control-wide; URL and variable names, never values |
| `POST /api/v1/backup/destination` | `admin` | Control-wide |
| `DELETE /api/v1/backup/destination` | `admin` | Control-wide |
| `GET /api/v1/backup/key` | `admin` | Query `project`; prints the repository password |
| `POST /api/v1/secrets` | `admin` | Control-wide |
| `DELETE /api/v1/secrets/:name` | `admin` | Control-wide |
| `DELETE /api/v1/volumes/:name` | `admin` | Control-wide |
| `GET /api/v1/nodes` | `admin` | Control-wide |
| `POST /api/v1/nodes/register` | `admin` | Control-wide |
| `POST /api/v1/nodes/enroll-token` | `admin` | Control-wide |
| `POST /api/v1/nodes/:name/rotate-wg-key` | `admin` | Control-wide |
| `POST /api/v1/nodes/:name/ingress` | `admin` | Control-wide |
| `DELETE /api/v1/nodes/:name` | `admin` | Control-wide |
| `POST /api/v1/control/backups/run` | `admin` | Control-wide |
| `POST /api/v1/control/restore` | `admin` | Control-wide |
| `GET /api/v1/diagnostics` | `admin` | Control-wide |
| `POST /api/v1/diagnostics/nodes` | `admin` | Control-wide |
| `POST /api/v1/tokens` | `admin` | Control-wide |
| `GET /api/v1/tokens` | `admin` | Control-wide |
| `DELETE /api/v1/tokens/:name` | `admin` | Control-wide |

## Failures

- `401` means the token is missing, unknown, revoked or expired.
- `403` means the token is valid but its role is too low (`forbidden: this action requires the deploy role`) or the project is outside its scope (`forbidden: this token may not access that project`). The project message is identical whether the other project exists, whether a deployment or command ID exists, or whether the project name is valid, so a scoped token cannot probe for projects or IDs.

## Projects and scoping

A `read` or `deploy` token created with `--project` may only act on those projects. Listings are filtered rather than refused: `status` returns only allowed projects, their deployments and their node status, and `events` without `--project` returns only events of allowed projects (events without a project, such as token changes and node events, are hidden from scoped tokens). A token without `--project` covers every project, including ones created later. `status` still lists node names and health to every token, since placement names appear in Compose files.

## Audit trail

Every deployment and every control event records the acting token name, `operator` for the root token. `tug events` and `GET /api/v1/events` return it as `actor`, and deployment records (`GET /api/v1/deployments/:id`, `tug status`) carry it as `actor`. Control actions write events of these types: `deploy`, `rollback`, `cancel`, `restart`, `secret.set`, `secret.delete`, `token.create` and `token.revoke`. Events never contain secret values or token secrets. Rollbacks that control starts by itself (`x-tug: { rollback: auto }`, see [Compose extensions](compose.md#automatic-rollback)) and their `deployment.auto_rollback` events are attributed to the reserved actor `system:auto-rollback`; token names cannot contain a colon, so no token can use it. Events written by agents have no `actor`. Control events that belong to no project (token changes) show up in `tug events --all`.

## Managing tokens

```bash
tug token-create ci-site --role deploy --project site
tug token-create ci-site --role deploy --project site --project blog --expires-in-days 90
tug token-create alice --role read
tug token-list
tug token-revoke ci-site
```

- Names are 1 to 64 letters, numbers, dots, underscores or hyphens. `operator` is reserved. A revoked token keeps its name so audit entries stay unambiguous; choose a new name to replace it.
- `token-create` prints the token once, on stdout; a note on stderr reminds you to store it. Tokens look like `tug_tok_...`. Only a SHA-256 hash is stored, so a lost token cannot be recovered, only replaced.
- `token-list` shows name, role, projects, creator, creation, last use, expiry and revocation time, never secrets.
- Revocation applies to the next request. Expired tokens are refused with `401` the same way. `last_used_at` is refreshed at most once a minute in the background, so it is approximate and bookkeeping never delays or fails a request.
- Tokens live in the control database, so they are part of `tug control-backup` and come back with `tug control-restore`; a restore returns the token set (including revocations) to the backup's state.
- The root operator token is not a named token: it is not listed and cannot be revoked, and there is no command to rotate it yet. Prefer day-to-day use of named admin tokens, which you can revoke.

## Deploying from GitHub Actions

Create a project-scoped `deploy` token and store it with the control URL as repository secrets:

```bash
tug token-create github-site --role deploy --project site
```

Add `TUG_CONTROL_URL` (for example `https://control.example.com`) and `TUG_TOKEN` (the printed token) under the repository's Settings, Secrets and variables, Actions. A workflow:

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
          TUG_CONTROL_URL: ${{ secrets.TUG_CONTROL_URL }}
          TUG_TOKEN: ${{ secrets.TUG_TOKEN }}
          TUG_PROJECT: site
        run: npx --yes @wpelevator/tug deploy -f docker-compose.yml --version "git-${GITHUB_SHA::12}"
```

`deploy` waits for the rollout and fails the job when the deployment fails or times out (add `--no-wait` to return immediately). Services with `build:` upload the checkout for a remote build on control; add `--build-local` to build on the runner, which has Docker, and upload the images instead. Pin the CLI version (`@wpelevator/tug@<version>`) to match your control plane. Rolling back from CI needs only the same token (`npx @wpelevator/tug rollback`).

## Limits

- A `deploy` token can run any image or Compose configuration on the nodes of its projects, execute commands in those containers, and read their logs and raw Docker inspection data. Treat it as access to those nodes: inspection data can include environment variables, and logs can contain whatever the application prints. Scope tokens to the projects they need and expire short-lived ones.
- Control-wide state (nodes, backups, diagnostics, tokens, secrets and volume deletion) is admin only. There is no per-project secret management role.
- Roles and project scopes are fixed at creation; to change them, create a new token and revoke the old one.
- A `deploy` event is written when a deployment is published. A build that fails before publishing appears only in its deployment record (with its `actor`), not as an event.
