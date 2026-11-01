# Standalone binary

Status: proposed, not implemented. This document is the design for shipping the `tug` CLI as a self-contained executable, so it can be installed with Homebrew without a Node.js dependency. When it lands, this page becomes the canonical description of the binary build and [Releases](releases.md) links to it.

## Scope

Only the `tug` CLI (`src/cli.ts`) becomes a binary. The control plane and agent (`tug-runtime`, `src/main.ts`) use SQLite metadata and server-only packages (`express`, `multer`) and already ship in the multi-arch Docker image, so they stay there. The npm package and the image are unchanged.

SQLite in control and agents uses an isolated `node:sqlite` adapter; a future Bun bundle of those processes could supply `bun:sqlite` through the same contract, as described in [Architecture](architecture.md#sqlite-storage). That is outside this CLI-only proposal, whose import graph does not include the database.

The CLI imports `commander`, `js-yaml`, `tar`, the mutual-TLS client stack (`undici` for the pinned HTTPS transport, `ws` for live sessions, `@peculiar/x509` with `reflect-metadata` for credentials and certificate requests) and Node built-ins (`node:crypto`, `node:tls`). All of these are pure JavaScript with no native addons, so a binary needs no per-platform compilation. See [mTLS dependencies](#mtls-dependencies) for what is verified and what is not.

## Tool: Bun compile

The binary is built with `bun build --compile`, which bundles the TypeScript entry point, its dependencies and the Bun runtime into one executable. Bun can cross-compile every target from a single CI runner, which keeps the release workflow to one job.

| Target | Release asset |
|---|---|
| `bun-darwin-arm64` | `tug-darwin-arm64.tar.gz` |
| `bun-darwin-x64` | `tug-darwin-x64.tar.gz` |
| `bun-linux-x64` | `tug-linux-x64.tar.gz` |
| `bun-linux-arm64` | `tug-linux-arm64.tar.gz` |

Windows is out of scope: Tug drives hosts over SSH and shell scripts, and the project does not target Windows operators today. Add `bun-windows-x64` if that changes. Use the `-musl` Linux targets only if Alpine users ask for them.

Node SEA is the fallback if a Bun runtime difference cannot be worked around. It needs a native runner per target and macOS signing, so it is more CI work for the same result.

## mTLS dependencies

Control accepts only client-certificate connections, so the binary must be able to present a CA-signed client certificate, pin the credential's CA, verify the generated control name while connecting to a different address (a tunnel, a moved host), and generate a P-256 key and certificate request. Four things carry that: `fetch` through an `undici` `Agent` with `connect` TLS options (`createTransport` in `src/agent-credential.ts`), a `ws` WebSocket with the same TLS options (`src/cli-live-transport.ts`), `node:crypto` WebCrypto and `X509Certificate`, and `@peculiar/x509`.

**Verified (Node).** `tools/scripts/verify-mtls-runtime.js` issues a CA, a server certificate and an operator credential with `@peculiar/x509`, serves mTLS with the production options (TLS 1.3, client certificate required, no session resumption), and calls it through `createTransport`, including the loopback connect-target override that still verifies the public name, a wrong-name refusal and a handshake refusal without a client certificate. `npm run test:smoke:image` runs it inside the shipped Debian runtime image, and `TUG_RUNTIME_DOCKERFILE=Dockerfile.alpine npm run test:smoke:image` runs it inside `Dockerfile.alpine` (Node 24 on Alpine/musl, `aarch64`). Both pass, so `@peculiar/x509` and undici work on Debian and Alpine with no native build step or extra system package. The same script passes on Node 26 on macOS.

**Not verified (Bun).** No Bun toolchain was available where this was checked, and none was downloaded, so the compiled binary has not been run. These are the risks to check first, in order of likelihood:

1. `undici`. Bun provides its own `fetch` and may substitute or only partly implement the `undici` package's `Agent` and `dispatcher` option. If the `Agent` is ignored the request would go out without the client certificate or CA pin. Bun's own `fetch` accepts a `tls` option (`ca`, `cert`, `key`, `serverName`, `checkServerIdentity`), which covers the same ground.
2. `ws` with `ca`, `cert`, `key`, `servername` and `checkServerIdentity` options on a `wss:` connection. Bun implements `ws` natively and may handle the TLS options differently.
3. `node:crypto` `X509Certificate`, `webcrypto.subtle` ECDSA P-256 import/export in PKCS#8 and SPKI, and `@peculiar/x509` finding the crypto provider (`x509.cryptoProvider.set(crypto.webcrypto)`).
4. `reflect-metadata` and `tsyringe` side effects surviving bundling and tree-shaking.

**Decision.** No Bun-specific adapter yet. All HTTPS use goes through `createTransport` and all WebSocket use through `createCliLiveTransport`, so an adapter, if the checks below fail, is a small replacement of exactly those two factories (Bun's `fetch` with `tls`, and Bun's `WebSocket` with `tls`) behind the existing interfaces, selected at build time like the SQLite adapter in [Architecture](architecture.md#sqlite-storage). Run `tools/scripts/verify-mtls-runtime.js` against the compiled binary's modules (or port its checks into the binary smoke test) before the first release, and add the adapter only if one of them fails.

## Required code changes

The CLI reads two things from disk that do not exist inside a single executable.

1. **Templates.** `cli.ts` reads `install-docker.sh`, `control-compose.yml`, `control-install.sh`, `node-install.sh` and `agent.env` from a `templates` directory next to the running file. Embed them at build time by importing each as text (`import x from './templates/x.sh' with { type: 'text' }`) and have `loadTemplate` take the embedded string. Under plain Node (dev, tests, npm package) the same module must still work, so put the template lookup behind one function that reads from disk when the files exist and uses the embedded copy otherwise, or generate a `templates.generated.ts` module in the build step that both paths import.
2. **Version.** `packageVersion()` in `src/image.ts` reads `package.json`. The version selects the Docker image tag the CLI installs (`ghcr.io/wpelevator/tug:X.Y.Z`), so it must be exact. Inject it at build time with `bun build --define` and fall back to reading `package.json` when the constant is absent.

Review the remaining runtime behavior under Bun: `spawnSync` calls to `docker`, `ssh` and `scp`, `openAsBlob` for uploads, `fetch` against the control API, and `tar` streaming in `cli-build.ts`. The existing CLI tests should run against the binary, not only the TypeScript sources.

## Build and test

- Add `tools/scripts/build-binary.js` (Node, per project convention) that runs `bun build --compile` for each target with the version defined, writes `dist-bin/tug-<os>-<arch>`, and packs each into a `.tar.gz` with a `.sha256` file.
- Add an `npm run build:binary` script that calls it. Bun is a build-time dependency only, installed in CI with `oven-sh/setup-bun` and not added to `package.json`.
- Extend the smoke test (`test:smoke:dist` already runs `src/cli.templates.test.ts` against `CLI_ENTRY`) so `CLI_ENTRY` can point at the native binary and assert `tug --version`, that every template renders, and that an mTLS request through a local test control succeeds with the pinned CA and connect-target override (the checks of `verify-mtls-runtime.js`).
- CI runs the smoke test on the host-native binary for linux x64 and macOS arm64. The other targets are cross-compiled only.

## Release and Homebrew

1. `release.yml` already knows when a package was published. Add a `binaries` job after publish that builds the four targets from that commit and uploads the tarballs and checksums to the GitHub Release for the tag.
2. Create a tap repository `wpelevator/homebrew-tap` with `Formula/tug.rb`. The formula has `on_macos` and `on_linux` blocks, each with `on_arm` and `on_intel`, pointing at the release asset URL and SHA256 for that target. The install step is `bin.install "tug"`, and `test do` runs `tug --version`.
3. The `binaries` job bumps the formula (URLs, checksums, version) and pushes to the tap, using a fine-scoped token or GitHub App limited to that repository.
4. Users install with `brew install wpelevator/tap/tug`. The npm install path keeps working for people who already have Node.

## Signing

macOS binaries produced by Bun carry an ad-hoc signature, which is enough for Apple silicon to run them. Homebrew downloads do not set the quarantine attribute, so Gatekeeper does not prompt for brew installs. Notarization is required only if the tarballs are offered for direct download from a browser. Do that later with an Apple Developer ID if there is demand. Publish the `.sha256` files for every asset so direct downloads can be verified.

## Checklist

- [ ] Embed templates and make `loadTemplate` work from the embedded copy
- [ ] Inject the version at build time with a `package.json` fallback
- [ ] `tools/scripts/build-binary.js` and `npm run build:binary`
- [ ] Smoke test against the native binary, including the mTLS checks above
- [ ] Verify (and, only if needed, adapt) undici and `ws` TLS options under Bun
- [ ] `binaries` job in `release.yml` uploading assets and checksums
- [ ] `wpelevator/homebrew-tap` formula and automatic bump
- [ ] Document binary and Homebrew install in the README, [CLI reference](cli.md) and [Releases](releases.md); then drop the "proposed" status above
