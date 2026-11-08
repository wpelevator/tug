# Standalone binary

Status: prototyped on the `prototype-bun-binary` branch, not released. The client builds and runs under Bun with templates and version embedded (`src/embedded.ts`, `tools/binary/entry.ts`, `tools/scripts/build-binary.js`, `npm run build:binary`) and has a smoke test (`npm run test:smoke:binary`); the CI job, release job and Homebrew tap do not exist. Sections below describe the prototype as findings and the code changes as the design to implement. This document is the design and the record of what the prototype found for shipping the `tug` CLI as a self-contained executable, so it can be installed with Homebrew without a Node.js dependency. When it ships, this page becomes the canonical description of the binary build and [Releases](releases.md#native-binary) links to it.

## Scope

Only the client is shipped as a binary. The control plane and agent (`tug-runtime`, `src/main.ts`) stay on Node in the multi-arch Docker image, and the npm package and the image are unchanged. See [One binary or two](#one-binary-or-two) for why.

The control plane and agent use SQLite metadata and server-only packages (`express`, `multer`). SQLite goes through an isolated `node:sqlite` adapter ([Architecture](architecture.md#sqlite-storage)); the prototype found that Bun 1.4.4 implements `node:sqlite`, including the error codes the adapter classifies, so no `bun:sqlite` adapter is needed. The CLI's import graph does not include the database.

## Prototype findings

Built and run with Bun 1.4.4 on macOS arm64. Bun is a build-time tool only; the prototype installed it from npm into a scratch directory. 

### One binary or two

One multi-call binary is cheap but only its client half is usable today.

| Build | Size |
|---|---|
| CLI only (`src/cli.ts`) | 86 MB |
| Runtime only (`src/main.ts`) | 88 MB |
| Multi-call (`tools/binary/entry.ts`) | 88 MB |

The Bun runtime is about 85 MB of each, so carrying control and agent costs about 2 MB and size does not argue for splitting. A single artifact also matches the release model, because the CLI already pins the image tag it installs to its own version. The prototype entry dispatches `tug ...` to the CLI and `tug runtime <control|agent> ...` (or an executable named `tug-runtime`) to `src/main.ts`.

Control cannot run on Bun yet. Bun's `https` server gives request sockets no `getPeerCertificate()`, and control identifies every caller from the peer certificate (`peerIdentity` in `src/pki.ts`), so each mTLS request is reset. This reproduces with `bun tools/scripts/verify-mtls-runtime.js` against a built `dist/`, which passes on Node. The listener, SQLite, PKI and `issue-credential` all work under Bun; the peer certificate is the only blocker found.

Recommendation: ship the client binary and keep control and agent on Node in the image. Leave `tug runtime` out of the release entry. A Bun-hosted control is possible but needs a listener change, described next, so it is a separate piece of work with its own risk, not a build flag.

### Peer certificate under Bun

A probe with a CA, a server certificate and a client certificate carrying a `tug:` URI SAN compared three ways of reading the client certificate on the same mTLS server, under Node 26 and Bun 1.4.4:

| Where the certificate is read | Node | Bun |
|---|---|---|
| `req.socket` inside `https.createServer` (what control does) | works | `getPeerCertificate` is missing |
| the `secureConnection` socket of `https.createServer` | works | `getPeerCertificate` is missing |
| a raw `tls.createServer` socket, with the connection handed to an `http.Server` via `emit('connection', socket)` | works | works, including on the `req.socket` the HTTP handler sees |

`socket.authorized` is `true` in every case, so Bun verifies the chain; only the accessor for the certificate is absent from its HTTPS server sockets. The third shape is the way through: terminate TLS with `tls.createServer` using the options in `src/tls-server.ts`, give each accepted socket to an inner `http.Server`, and keep calling `peerIdentity(req.socket)` unchanged. Because the inner server owns the HTTP and `upgrade` handling, Express and the agent WebSocket route need no change.

What this does not prove: the probe did not run control end to end that way. Before relying on it, check that TLS 1.3 only, the zero session timeout and no-ticket settings behave the same on Bun's TLS stack (session resumption would let a request ride a connection that never presented a certificate), that `handshakeTimeout` and socket error handling still apply, that the certificate-renewal reload of the listener (`serverTlsOptions` is rebuilt on renewal in `src/control.ts`) works with `tls.Server.setSecureContext`, and that the `ws` upgrade path authenticates. Hosting control on Bun also changes the production runtime for a security boundary, so it needs the integration suite (`npm run test:integration*`) against the Bun build, not only the unit tests.

Alternatives, in order of preference:

1. Keep control and agent on Node and ship only the client binary. No new risk; this is the recommendation.
2. Move the control listener to the raw `tls.createServer` shape above, which also works on Node, so the change is runtime-neutral and testable on Node first. Only then build the runtime for Bun.
3. Wait for Bun to add `getPeerCertificate` to its HTTPS server sockets. Nothing here depends on that happening.
4. Node SEA for the runtime, if a single executable of control is wanted without changing runtime.

### Risks checked

| Risk | Result |
|---|---|
| `package.json` and templates are not on disk in the executable | Reproduced (`ENOENT /$bunfs/package.json`). Fixed with `src/embedded.ts`: the Bun entry registers the embedded version and templates, and every reader falls back to disk when nothing is registered, so Node behavior is unchanged |
| `undici` `Agent` under Bun | Confirmed broken. Bun substitutes a shim whose `Agent` has no `close()` and ignores `connect`, which would silently drop the client certificate and CA pin. `createTransport` now uses Bun's `fetch` with `tls` (`ca`, `cert`, `key`, `serverName`, `checkServerIdentity`) when running under Bun |
| `reflect-metadata` and `tsyringe` ordering | Failed in the bundle ("requires a reflect polyfill"). The entry must `import 'reflect-metadata'` first; the import in `src/pki.ts` is not enough |
| `import.meta.url === file://argv[1]` "run directly" guards | Every bundled module shares one URL, so `control.ts` and `agent.ts` both self-started and control crashed on a second listen. Both guards now check `isEmbedded()` first |
| `ws` live sessions with TLS options | Not verified |
| Docker and SSH child processes, `openAsBlob` uploads, `tar` streaming | Not verified |
| Template rendering inside the binary | Templates are embedded (their text is in the executable) but no command that renders them was run |

### Verified with the compiled binary

As the client against a Node-hosted control: the mTLS request succeeds, `--control-url https://127.0.0.1:<port>` still verifies the generated control name, a credential issued under a different CA is refused with the CA-mismatch message, and a caller without a client certificate is refused at the handshake. Typecheck, lint and the full test suite passed with the prototype's changes applied.

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

## Review findings and fixes

A review of the prototype against the client's security goals found defects that the Node build does not have. Each is fixed and pinned by a test in `src/cli.binary.test.ts`, which runs when `TUG_BINARY` names a built executable.

| Finding | Fix |
|---|---|
| A compiled Bun executable loads `bunfig.toml` (including `preload`, which runs code) and `.env` from the working directory, so running `tug` in a cloned repository could execute code or repoint `TUG_CONTROL_URL` | `build-binary.js` passes `--no-compile-autoload-bunfig`, `--no-compile-autoload-dotenv`, `--no-compile-autoload-tsconfig` and `--no-compile-autoload-package-json` |
| Bun rejects the string `minVersion: 'TLSv1.3'`; dropping it let a TLS 1.2-only control with a CA-signed certificate be accepted | The Bun transport passes the numeric `0x0304` |
| Bun's `fetch` follows `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY`, which the Node path never does, so mTLS requests and loopback `--control-url` traffic went to the proxy | The Bun transport sets `NO_PROXY=*` for the duration of each request only, so `docker` and `ssh` children keep their proxy settings |
| `tug doctor` reported a missing local `node` | The check is skipped when the process is embedded |
| A template added to `src/templates/` but not to the entry would fail at runtime | `src/embedded.test.ts` compares the directory with the entry's registry |
| The build used whatever `bun` was on PATH, and `ws` and `undici` are Bun's own implementations | `build-binary.js` refuses any Bun other than the pinned `BUN_VERSION` |

Still unverified from the review: the `bun-linux-x64` target needs AVX2 and glibc (`-baseline` and `-musl` targets may be needed), SIGINT and exit codes during interactive `exec`, and cosmetic differences such as colored numbers in `console.log` on a terminal. The `isEmbedded()` guards in `control.ts` and `agent.ts` matter only if a multi-call entry is added; the CLI entry never loads those files.

## mTLS dependencies

Control accepts only client-certificate connections, so the binary must be able to present a CA-signed client certificate, pin the credential's CA, verify the generated control name while connecting to a different address (a tunnel, a moved host), and generate a P-256 key and certificate request. Four things carry that: `fetch` through an `undici` `Agent` with `connect` TLS options (`createTransport` in `src/agent-credential.ts`), a `ws` WebSocket with the same TLS options (`src/cli-live-transport.ts`), `node:crypto` WebCrypto and `X509Certificate`, and `@peculiar/x509`.

**Verified (Node).** `tools/scripts/verify-mtls-runtime.js` issues a CA, a server certificate and an operator credential with `@peculiar/x509`, serves mTLS with the production options (TLS 1.3, client certificate required, no session resumption), and calls it through `createTransport`, including the loopback connect-target override that still verifies the generated control name, a refusal of a server certificate without that name and a handshake refusal without a client certificate. `npm run test:smoke:image` runs it inside the shipped runtime image (Node 24 on Alpine/musl), so `@peculiar/x509` and undici are checked on musl with no native build step or extra system package. The same script passes on Node 26 on macOS.

**Bun.** The first review had no Bun toolchain; the prototype above has since run the compiled binary and settled items 1, 3 (partly) and 4 below. The original risk list is kept for context:

1. `undici`. Bun provides its own `fetch` and may substitute or only partly implement the `undici` package's `Agent` and `dispatcher` option. If the `Agent` is ignored the request would go out without the client certificate or CA pin. Bun's own `fetch` accepts a `tls` option (`ca`, `cert`, `key`, `serverName`, `checkServerIdentity`), which covers the same ground.
2. `ws` with `ca`, `cert`, `key`, `servername` and `checkServerIdentity` options on a `wss:` connection. Bun implements `ws` natively and may handle the TLS options differently.
3. `node:crypto` `X509Certificate`, `webcrypto.subtle` ECDSA P-256 import/export in PKCS#8 and SPKI, and `@peculiar/x509` finding the crypto provider (`x509.cryptoProvider.set(crypto.webcrypto)`).
4. `reflect-metadata` and `tsyringe` side effects surviving bundling and tree-shaking.

**Decision.** The HTTPS adapter turned out to be needed: `createTransport` selects Bun's `fetch` with `tls` when running under Bun, and the `undici` `Agent` otherwise. The WebSocket factory `createCliLiveTransport` is the remaining place a small Bun-specific replacement (Bun's `WebSocket` with `tls`) may be needed; check it before the first release. `tools/scripts/verify-mtls-runtime.js` covers the server side under Node only, so port its client checks into the binary smoke test.

## Code changes

The CLI reads two things from disk that do not exist inside a single executable. The prototype made both changes; this is the design to land.

1. **Templates.** `src/embedded.ts` holds a registry. `tools/binary/entry.ts` imports `install-docker.sh`, `control-compose.yml`, `control-install.sh`, `node-install.sh` and `agent.env` as text (`with { type: 'text' }`) and registers them. `loadTemplate` and `dockerBootstrap` go through `readTemplate`, which returns the embedded copy when present and reads `templatesDir` from disk otherwise, so dev, tests and the npm package are unchanged. The entry lives in `tools/binary/`, outside `src/`, so `tsc` and Node never load it.
2. **Version.** `packageVersion()` returns the embedded version when registered and reads `package.json` otherwise. The entry imports `package.json` as JSON, which Bun bundles, so no `--define` is needed. The version selects the Docker image tag the CLI installs (`ghcr.io/wpelevator/tug:X.Y.Z`), so it must be exact.

Review the remaining runtime behavior under Bun: asynchronous child processes for Docker, SSH and SCP installation work, synchronous Docker/SSH onboarding probes, `openAsBlob` for uploads, `fetch` against the control API, and `tar` streaming in `cli-build.ts`. Check that elapsed-time progress continues during child processes and that captured output stays separate from stderr progress. The existing CLI tests should run against the binary, not only the TypeScript sources.

## Build and test

- Add `tools/scripts/build-binary.js` (Node, per project convention) that runs `bun build --compile tools/binary/entry.ts` for each target, writes `dist-bin/tug-<os>-<arch>`, and packs each into a `.tar.gz` with a `.sha256` file.
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

Proven in the prototype, to be implemented in the repository:

- [ ] Embed templates and make `loadTemplate` work from the embedded copy
- [ ] Embed the version with a `package.json` fallback
- [ ] Bun entry outside `src/`, `reflect-metadata` first, "run directly" guards in `control.ts` and `agent.ts` skip when embedded
- [ ] Bun `fetch` with `tls` in `createTransport`, with tests that pin the selection

Still to do:

- [x] `tools/scripts/build-binary.js` and `npm run build:binary` (host and cross targets build; non-host targets not run)
- [ ] Smoke test against the native binary in CI, and extend it with the remaining mTLS checks (expired certificate, redirect, offline) and rendering every template (`src/cli.binary.test.ts` covers version, working-directory hardening, proxy, TLS 1.3 floor and `doctor`)
- [ ] Verify (and, only if needed, adapt) the `ws` TLS options and the Docker, SSH, upload and `tar` paths under Bun
- [ ] Keep `tug runtime` out of the release entry unless the control listener moves to the raw `tls.createServer` shape ([Peer certificate under Bun](#peer-certificate-under-bun))
- [ ] `binaries` job in `release.yml` uploading assets and checksums
- [ ] `wpelevator/homebrew-tap` formula and automatic bump
- [ ] Document binary and Homebrew install in the README, [CLI reference](cli.md) and [Releases](releases.md); then drop the "prototyped, not implemented" status above
