# Releases

Tug is published as the npm package [`@wpelevator/tug`](https://www.npmjs.com/package/@wpelevator/tug) (bins `tug` and `tug-runtime`) and as the multi-arch (`linux/amd64`, `linux/arm64`) Docker image `ghcr.io/wpelevator/tug`. The package and image always share one version, and the CLI's install commands default to the image with the CLI's own version.

## Changesets

Versions come from [Changesets](https://github.com/changesets/changesets). Every pull request with a user-facing change (CLI, API, agent behavior, image contents, docs for a new behavior) adds a changeset:

```bash
npm run changeset
```

It asks for the bump (`patch`, `minor` or `major`) and a summary, and writes a Markdown file in `.changeset/` that you commit with the PR. The summary becomes the changelog entry, so write it for users. Changes with no user-facing effect (CI, refactors, tests) need none.

## Choosing the bump

Tug trusts semver, and the control, CLI and agents enforce it (see [Upgrading the control plane](control-plane.md#upgrading-the-control-plane)): they interoperate while their major matches, and a client on a newer major than its control is refused. The bump in a changeset is therefore a compatibility promise, not a measure of how big the change feels:

- `patch`: fixes and changes that do not alter what the control, CLI and agents say to each other, including documentation.
- `minor`: new features. Additive wire changes (a new route, an optional field, a new agent command) are minor: older peers keep working, and a newer CLI against an older control reports the missing route.
- `major`: anything that breaks an older peer: removing or renaming a route, header or field, adding a required one, narrowing accepted values, or changing the meaning of an existing message. A major also moves the `/api/v1` and `/agent/v1` roots to the new major only when old and new must be served side by side; otherwise the root keeps its name.

A schema change appends a migration step in `src/db/db.ts` (never edit a released step) and adds a previous-release fixture under `tests/fixtures/db/`; a database change that a step cannot make safely, such as dropping data an older release still reads, is a `major`.

Before 1.0 semver gives no guarantees, so the whole `0.minor` is the compatibility key: any minor bump is a skew boundary and the control, CLI and agents upgrade together, so keep `minor` for wire changes and use `patch` for the rest.

## Upgrading to 3.0: values come only from control

`tug deploy` no longer reads the shell environment of the machine that runs it, the `.env` next to the Compose file, `env_file` entries or `COMPOSE_PROFILES`. A `${NAME}` is filled from a project secret, a project variable, `--var` or the default in the file ([Where values come from](compose.md#where-values-come-from)). Before upgrading the CLI that your laptop and CI use:

1. Run `tug deploy --dry-run` with the 3.0 CLI in a copy of the project: it prints every name with its source and fails naming the ones control lacks.
2. Move what you relied on into control: `tug secret import .env` (every entry becomes a secret unless `--vars` names it, and in a terminal you confirm the list or choose per entry with `--select`), or `tug secret set` and `tug var set` one by one. In CI, set variables with `tug var set` or pass `--var TAG=$GITHUB_SHA`.
3. Replace each `env_file:` with `environment:` entries (`KEY: ${KEY}`) once its values are in control, and replace `COMPOSE_PROFILES=x` with `tug deploy --profile x` or `profile: [x]` in `tug.yml`.

Control 3.0 reads the database written by 2.x and adds `project_vars` and a value record to deployments; deployments made before the upgrade simply have no record. A 2.x CLI keeps working against a 3.0 control, since the value record is optional, but it still resolves values on the machine that runs it.

## What 1.0 freezes

From 1.0.0 these are public contracts. Inside one major they change only compatibly, and a breaking change is a new major announced in the changelog:

- **The CLI:** command names, flags and exit codes, and the JSON printed by `--json` and by commands documented as machine-readable.
- **`x-tug`:** the keys, values and defaults in [Compose extensions](compose.md) and the published `x-tug.schema.json`. A new key is a minor; a key's meaning does not change.
- **The wire protocol:** the HTTP routes under `/api/v1` and `/agent/v1`, the `x-tug-*` skew headers and the agent commands, as described in [Upgrading the control plane](control-plane.md#upgrading-the-control-plane).
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
