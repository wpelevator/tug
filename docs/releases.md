# Releases

Tug is published as the npm package [`@wpelevator/tug`](https://www.npmjs.com/package/@wpelevator/tug) (bins `tug` and `tug-node`) and as the multi-arch (`linux/amd64`, `linux/arm64`) Docker image `ghcr.io/wpelevator/tug`. The package and image always share one version, and the CLI's install commands default to the image with the CLI's own version.

## Changesets

Versions come from [Changesets](https://github.com/changesets/changesets). Every pull request with a user-facing change (CLI, API, agent behavior, image contents, docs for a new behavior) adds a changeset:

```bash
npm run changeset
```

It asks for the bump (`patch`, `minor` or `major`) and a summary, and writes a Markdown file in `.changeset/` that you commit with the PR. The summary becomes the changelog entry, so write it for users. Changes with no user-facing effect (CI, refactors, tests) need none.

## Release flow

1. A PR with a changeset merges to `main`.
2. `release.yml` runs on every push to `main`. While unreleased changesets exist, `changesets/action` opens or updates a "chore: version packages" PR that runs `npm run version-packages` (bumps `package.json`, updates `package-lock.json`, writes `CHANGELOG.md` and deletes the consumed changesets).
3. Merging that PR is the release. The same workflow then runs `npm run release` (`changeset publish`), which publishes `@wpelevator/tug` to npm with provenance and creates the git tag.
4. When a package was published, the `image` job builds the multi-arch image from that commit and pushes `ghcr.io/wpelevator/tug` tagged `X.Y.Z`, `X.Y` and `latest`.
5. Independently, every push to `main` pushes `ghcr.io/wpelevator/tug:edge`, the latest unreleased build.

Nothing is released by hand: do not run `npm publish` or create tags yourself. Pull requests created by the workflow with `GITHUB_TOKEN` do not trigger other workflows, so CI does not start on the "Version Packages" PR by itself; push an empty commit to its branch or close and reopen it if you want checks on it.

## npm trusted publishing

The workflow publishes with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC, so there is no `NPM_TOKEN` secret. The package on npmjs.com is configured with GitHub repository `wpelevator/tug` and workflow file `release.yml`, so that file must keep its name. The job has `permissions: id-token: write` and installs npm >= 11.5.1, the first version that supports trusted publishing.

## One-time repository setup

- Settings > Actions > General > Workflow permissions: allow "Read and write permissions" and "Allow GitHub Actions to create and approve pull requests", so `changesets/action` can open the Version Packages PR.
- After the first image push, open the `tug` package under the organization's Packages and set its visibility to public (new GHCR packages are private by default), so hosts can pull without logging in. Make sure the package is linked to the repository and that Actions has write access to it (Package settings > Manage Actions access).
- Optionally protect `main` and require the CI checks, so a release only comes from tested code.

## Local development image

To try an unreleased build, `tug control install` and `tug node install` accept `--build-local-image`, which builds `tug:local` from the checkout and copies it over SSH, or `--image ghcr.io/wpelevator/tug:edge`. See [Nodes](nodes.md) and [Control plane](control-plane.md).
