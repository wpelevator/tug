# Releases

tug is published as the npm package [`@wpelevator/tug`](https://www.npmjs.com/package/@wpelevator/tug) (bins `tug` and `tug-runtime`) and as the multi-arch (`linux/amd64`, `linux/arm64`) Docker image `ghcr.io/wpelevator/tug`. The package and image always share one version, and the CLI's install commands default to the image with the CLI's own version.

## Changesets

Versions come from [Changesets](https://github.com/changesets/changesets). Every pull request with a user-facing change (CLI, API, agent behavior, image contents, docs for a new behavior) adds a changeset:

```bash
npm run changeset
```

It asks for the bump (`patch`, `minor` or `major`) and a summary, and writes a Markdown file in `.changeset/` that you commit with the PR. The summary becomes the changelog entry, so write it for users. Changes with no user-facing effect (CI, refactors, tests) need none.

## Choosing the bump

tug trusts semver, and the control, CLI and agents enforce it (see [Upgrading the control plane](upgrades.md)): they interoperate while their major matches, and a client on a newer major than its control is refused. The bump in a changeset is therefore a compatibility promise, not a measure of how big the change feels:

- `patch`: fixes and changes that do not alter what the control, CLI and agents say to each other, including documentation.
- `minor`: new features. Additive wire changes (a new route, an optional field, a new agent command) are minor: older peers keep working, and a newer CLI against an older control reports the missing route.
- `major`: anything that breaks an older peer: removing or renaming a route, header or field, adding a required one, narrowing accepted values, or changing the meaning of an existing message. A major also moves the `/api/v1` and `/agent/v1` roots to the new major only when old and new must be served side by side; otherwise the root keeps its name.

A schema change appends a migration step in `src/db/db.ts` (never edit a released step) and adds a previous-release fixture under `tests/fixtures/db/`; a database change that a step cannot make safely, such as dropping data an older release still reads, is a `major`.

Before 1.0 semver gives no guarantees, so the whole `0.minor` is the compatibility key: any minor bump is a skew boundary and the control, CLI and agents upgrade together, so keep `minor` for wire changes and use `patch` for the rest.

## Upgrading to 3.0: values come only from control

`tug deploy` no longer reads the shell environment of the machine that runs it, the `.env` next to the Compose file, `env_file` entries or `COMPOSE_PROFILES`. A `${NAME}` is filled from a project secret, a project variable, `--var` or the default in the file ([Where values come from](compose.md#where-values-come-from)).

3.0 is a new major, so the CLI, control and agents move together. A 3.0 CLI is refused by a 2.x control, and a 2.x CLI refuses to run against a 3.0 control with `update the CLI with: npm i -g @wpelevator/tug@<version>`. Upgrade in this order:

1. Install the 3.0 CLI on one machine and run `tug upgrade`. It upgrades control and then every node, see [Upgrade control and nodes](upgrades.md).
2. Run `tug deploy --dry-run` in a copy of each project. It prints every name with its source and fails naming the ones control lacks. It needs a 3.0 control, so it comes after step 1.
3. Move what you relied on into control: `tug secret import .env` (every entry becomes a secret unless `--vars` names it, and in a terminal you confirm the list or choose per entry with `--select`), or `tug secret set` and `tug var set` one by one. In CI, set variables with `tug var set` or pass `--var TAG=$GITHUB_SHA`.
4. Replace each `env_file:` with `environment:` entries (`KEY: ${KEY}`) once its values are in control, and replace `COMPOSE_PROFILES=x` with `tug deploy --profile x` or `profile: [x]` in `tug.yml`.
5. Update the CLI in CI and on every other laptop. Until you do, they are refused by the 3.0 control.

Control 3.0 reads the database written by 2.x and adds `project_vars` and a value record to deployments. Deployments made before the upgrade have no record.

## Upgrading to 4.0: the image you wrote is the image that runs

Four defaults changed so that a deploy does what the Compose file says and a green backup check means the repository is healthy. 4.0 is a new major, so the CLI, control and agents move together, as for 3.0: upgrade with `tug upgrade` from a 4.0 CLI ([Upgrade control and nodes](upgrades.md)), then update the CLI in CI and on every other laptop.

| Before 4.0 | From 4.0 | What to do |
| --- | --- | --- |
| A service with both `build:` and `image:` was built, and the `image:` name was only a tag | tug deploys `image:` as written, pinned by digest, and builds nothing. `tug deploy --build` builds every such service for that deploy, and `x-tug: { build: true }` on a service always builds it. `build:` alone still builds | If CI built on the node through this pair, add `--build` to that deploy or set `x-tug.build: true`. If CI pushes the image to a registry first, nothing changes and the deploy stops rebuilding it ([Build or pull](compose.md#build-or-pull)) |
| With no `--project`, `TUG_PROJECT` or `project:` in `tug.yml`, the project was `site` | The project is the Compose file's `name:`, or the name of its directory. The `site` default is gone from the CLI. `tug init` and `tug setup` write `project:` to `tug.yml` | Run `tug status` before the first deploy. A project that lives under `site` needs `project: site` in `tug.yml`, or a deploy creates a second project and finds none of its secrets ([Which project](configuration.md#which-project)) |
| A bare `environment` key (`DB_PASSWORD` or `DB_PASSWORD:`) passed through whatever the container host had, usually nothing | It is checked like `${DB_PASSWORD}`: the deploy fails naming it when control has no secret or variable of that name. `KEY: ""` is a literal empty value | Run `tug values` (or `tug deploy --dry-run`) in each project and set what it lists as missing, or write `KEY: ""` where an empty value was intended ([Where values come from](compose.md#where-values-come-from)) |
| `tug backup list --check` failed only for stale, failed or missed backups, so a prune that failed every night stayed green | It also fails when a target's retention failed in two runs in a row, or once when restic exited with its lock code (11), and the same for control's own backup. A run whose retention works clears it | If the destination is append-only (`rest-server --append-only`, a bucket that refuses deletes), run `tug backup destination set <url> --retention external` once, or the check goes red after two backups. Pruning is then yours, see [Append-only destinations](backups.md#append-only-destinations) |

`GET /api/v1/backups` and `tug backup list --json` serve parsed fields in place of each run's raw `metadata_json` string, which is gone. The frozen fields are per target `retention` (`state`: `ok`, `failed` or `external`, `message`, `failures`, `locked`), `lock` (set while the newest run found the repository locked) and `cause` (`locked` or null), per run `retention`, `cause` and `warnings`, and the same three on `control`. `tug backup destination show` has `retention` (`managed` or `external`). `GET /api/v1/backups` also has `verify` (the repository's last check: `ok`, `prune`, `check`, `startedAt`, `finishedAt`, `subset`, `message`, `trigger`), `maintenanceRunning` and, per target, `protection` (`off-host`, `verified`, `restore-tested` or null), and `control.verify`. A per-run `restic forget` no longer prunes: the data of forgotten snapshots is freed by a weekly `backup.maintain` job, so a repository can hold more data than before until its first weekly prune, and an agent older than 4.0 still prunes on every run. Two events are new, `backup.retention_failed` and `backup.retention_recovered`, and a failed run that exited on restic's lock code carries `cause: "locked"` on `backup.failed`.

Control 4.0 reads the database written by 3.x and changes no table. A destination set to `--retention external` is one row in `meta`, which a 3.x control ignores. A 3.x CLI is refused by a 4.0 control, and a 4.0 CLI refuses a 3.x control, so there is no mixed state to plan for.

## What 1.0 freezes

From 1.0.0 these are public contracts. Inside one major they change only compatibly, and a breaking change is a new major announced in the changelog:

- **The CLI:** command names, flags and exit codes, and the JSON printed by `--json` and by commands documented as machine-readable.
- **`x-tug`:** the keys, values and defaults in [Compose extensions](compose.md) and the published `x-tug.schema.json`. A new key is a minor; a key's meaning does not change.
- **The wire protocol:** the HTTP routes under `/api/v1` and `/agent/v1`, the `x-tug-*` skew headers and the agent commands, as described in [Upgrading the control plane](upgrades.md).
- **Persisted state:** the control database and the agent state database upgrade in place through migrations; the credential file (`v: 1`), the join key (`v: 2`) and the control backup archive stay readable by every release of the same major. A change that cannot be read by an older release of the major is announced as a schema or format change in the changelog.
- **Image and package names:** `@wpelevator/tug` and `ghcr.io/wpelevator/tug:X.Y.Z`, `X.Y` and `latest`.

Not covered: log wording, human-readable output, the contents of `tug doctor`, `edge` images and anything marked experimental in its documentation.

## Release flow

The npm package includes the compiled runtime in `dist/` and the documentation in `docs/`, as listed in `package.json`'s `files` allowlist. npm also includes the root README and package metadata. To inspect the release contents locally without publishing, run `npm pack --dry-run`; its `prepack` hook builds the runtime first.

1. A PR with a changeset merges to `main`.
2. `release.yml` runs on every push to `main`. While unreleased changesets exist, `changesets/action` opens or updates a "chore: version packages" PR that runs `npm run version-packages` (bumps `package.json`, updates `package-lock.json`, writes `CHANGELOG.md` and deletes the consumed changesets).
3. Merging that PR is the release. The same workflow then runs `npm run release` (`changeset publish`), which publishes `@wpelevator/tug` to npm with provenance and creates the git tag.
4. When a package was published, the `image` job builds the multi-arch image from that commit and pushes `ghcr.io/wpelevator/tug` tagged `X.Y.Z`, `X.Y` and `latest`.
5. Independently, every push to `main` pushes `ghcr.io/wpelevator/tug:edge`, the latest unreleased build.

Nothing is released by hand: do not run `npm publish` or create tags yourself. Pull requests created by the workflow with `GITHUB_TOKEN` do not trigger other workflows, so CI does not start on the "Version Packages" PR by itself; push an empty commit to its branch or close and reopen it if you want checks on it.

## Native binary

A self-contained `tug` client built with `bun build --compile` is prototyped but not part of the release flow yet: no release job builds it and there is no Homebrew formula. When it ships it will be a `binaries` job after step 3 that attaches per-target tarballs and checksums to the GitHub Release. The prototype results, the one-binary-or-two decision (ship the client only; control stays on Node in the image) and the remaining checklist are in [Standalone binary](standalone-binary.md).

## npm trusted publishing

The workflow publishes with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC, so there is no `NPM_TOKEN` secret. The package on npmjs.com is configured with GitHub repository `wpelevator/tug` and workflow file `release.yml`, so that file must keep its name. The job has `permissions: id-token: write` and installs npm >= 11.5.1, the first version that supports trusted publishing.

## One-time repository setup

- Settings > Actions > General > Workflow permissions: allow "Read and write permissions" and "Allow GitHub Actions to create and approve pull requests", so `changesets/action` can open the Version Packages PR.
- After the first image push, open the `tug` package under the organization's Packages and set its visibility to public (new GHCR packages are private by default), so hosts can pull without logging in. Make sure the package is linked to the repository and that Actions has write access to it (Package settings > Manage Actions access).
- Optionally protect `main` and require the CI checks, so a release only comes from tested code.

## Local development image

To try an unreleased build, `tug control setup` and `tug node add` accept `--build-local-image`, which builds `tug:local` from the checkout and copies it over SSH, or `--image ghcr.io/wpelevator/tug:edge`. See [Nodes](nodes.md) and [Control plane](control-plane.md).
