# Development

The source is TypeScript. Development and tests run the `.ts` files directly through Node's built-in type stripping, so there is no build step, but it needs Node >= 22.18 (`engines.node`); development and CI use Node 24 (`.nvmrc`). SQLite uses built-in `node:sqlite`; installation requires no SQLite npm addon, Python or C++ compiler. The module is marked active development on Node 22.18.0 and can emit an experimental warning on supported Node releases; warnings are not globally suppressed. Compilation to `dist/` happens when building the Docker image and when packing the npm package (`prepack`).

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run format
npm run build
npm run test:smoke:dist
```

Code style is enforced by Prettier (`.prettierrc.json`: 100 columns, single quotes, trailing commas; indentation comes from `.editorconfig`). `npm run lint` runs ESLint and then `prettier --check .`, and CI runs it, so an unformatted file fails the build. `npm run format` rewrites files with Prettier and then applies ESLint's autofixes. `eslint-config-prettier` switches off the ESLint rules that would fight the formatter, so ESLint only reports correctness problems. Prettier covers TypeScript, JavaScript and JSON; Markdown, YAML, the install templates and generated files are listed in `.prettierignore`. Prettier moves a trailing `// eslint-disable-line` comment when it rewraps a statement, so put suppressions on their own line above the code they cover (`// eslint-disable-next-line`).

`npm test` runs `node --test 'src/**/*.test.ts'`. `npm run typecheck` runs `tsc --noEmit` over `src/` and `tests/` with `strict` on. `npm run build` compiles `src/` to `dist/` (JavaScript plus `.d.ts`) and copies `src/templates` to `dist/templates`. `npm run test:smoke:dist` builds and checks that `control-install` and `node-install` render their templates from `dist/`.

Import specifiers in the source use the `.ts` extension (`import { x } from './util.ts'`) because Node's type stripping does not remap `.js` to `.ts`; `tsc` rewrites them to `.js` in `dist/` (`rewriteRelativeImportExtensions`). Only erasable TypeScript syntax is allowed (`erasableSyntaxOnly`: no enums or constructor parameter properties).

Unit tests sit next to the source files as `src/*.test.ts`. The agent integration test lives in `tests/integration/`. [Testing](testing.md) explains how the test layers fit together and what each one is expected to catch.

## Docker image

The Dockerfiles are multi-stage: a build stage runs `npm ci && npm run build`, and the final image ships `dist/` plus production dependencies only, with entrypoint `node dist/main.js`. `tsc` does not copy `src/templates/*`, so `npm run build` copies them next to the emitted `dist/cli.js`; the CLI resolves them relative to the running file, so `node src/cli.ts` and `node dist/cli.js` both work.

The runtime image ships the Docker client (control uses it to load, tag and remove image archives through the mounted socket), `wg` and `ip` for the mesh, and the compiled `tug-runtime` entry (`dist/main.js`). It deliberately has no Compose plugin: agents drive the Docker Engine API, and the control-plane host runs the control container with the host's own Compose (`control-install` checks for it). `Dockerfile.alpine` is the same runtime on Alpine without the mesh tools.

Run `npm run test:smoke:image` to build the actual shipped runtime image and execute its Docker client and Node binaries, the compiled control/agent database initialization (a writable snapshot and read-only validation) and `tools/scripts/verify-mtls-runtime.js`, which issues certificates with `@peculiar/x509`, serves mTLS with the production TLS options and calls it through the undici transport, including the loopback connect-target override that still verifies the generated control name. Nothing from the host socket or CLI plugins is mounted. To test an already-built image, set `TUG_RUNTIME_IMAGE=<tag>`; to check the Alpine image, set `TUG_RUNTIME_DOCKERFILE=Dockerfile.alpine`. CI runs this packaging smoke before the integration test, so the fake-VPS image cannot mask missing runtime tools.

## Continuous integration and releases

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: typecheck and lint on Node 24 (the version in `.nvmrc`), unit tests and the dist smoke test on the exact minimum Node 22.18.0 and current Node 22 and 24, plus the Docker integration tests (fake VPS containers, registry-free image delivery, the WireGuard mesh and rolling rollouts) as separate jobs. `.github/workflows/release.yml` versions and publishes; see [Releases](releases.md). Every user-facing change needs a changeset (`npm run changeset`).

### CI caching

The `.github/actions/setup` composite action installs Node.js with the npm download cache (keyed on the lockfile) and runs `npm ci`; every job uses it. The integration jobs prebuild their images with `.github/actions/build-images` (Buildx and the GitHub Actions layer cache, scopes `runtime` and `fake-vps`) and set `TUG_COMPOSE_BUILD=` so the integration scripts run `docker compose up` (on the CI host, to start the test stack) without `--build`; the Compose files tag those images `tug-runtime:integration` and `tug-fake-vps:integration`. Locally the variable is unset and the scripts keep passing `--build`. Only pushes to `main` write the cache, because a pull request can read the default branch's cache but not another pull request's. The release workflow's `edge` job exports the `runtime` scope and the versioned `image` job reads it. The Dockerfiles pin the Node.js major (`node:24-*`), so an upstream LTS bump cannot silently invalidate the cache or change the shipped runtime.

Published images are `ghcr.io/wpelevator/tug`. To test an unreleased CLI against a checkout, use `--build-local-image` on `control-install` and `node-install` (builds `tug:local` from the working directory and copies it over SSH). The dev Compose files (`docker-compose*.yml`) and the integration tests always build the image from the checkout with `build: .` and never pull from GHCR.

## Compose stack

`docker-compose.yml` defines:

- `control`: the control plane on its single mTLS port `8443`, with SQLite, the master key, the private CA and saved image archives in a named volume, plus the Docker socket for builds. It requires `TUG_ADVERTISE_URL`, the HTTPS origin clients connect to.
- `agent`: an optional profile service (applying nothing, `TUG_APPLY=false`); run it with `--profile agent` once you have an enrollment credential for it.

```bash
export TUG_ADVERTISE_URL=https://localhost:8443
docker compose up --build control
# issue the root operator credential on the control-plane host (fresh state only):
docker compose exec control node dist/main.js control issue-credential --name root --role admin > tug-root.credential.json
node src/cli.ts init tug-root.credential.json
# prepare a node, then start the agent with the join key it prints:
node src/cli.ts node-prepare-enrollment --name dev-node --agent-control-url https://127.0.0.1:8443
TUG_JOIN_KEY=... docker compose --profile agent up agent
```

Control does not print or store a credential on startup; `issue-credential` writes the credential to stdout and keeps no private key. The agent keeps its identity in the `agent-state` volume, so it ignores the join key after the first start.

## Host mode

```bash
export TUG_ADVERTISE_URL=https://localhost:8443
npm run start:control
node src/main.ts control issue-credential --name root --role admin > tug-root.credential.json
node src/cli.ts init tug-root.credential.json
```

Host mode shares `./data` (or `TUG_DATA_DIR`) between control and `issue-credential`. Register a development node the way `node-install` does, with the node making its own key:

```bash
export TUG_STATE_DIR=$PWD/data/agent TUG_NODE_NAME=dev-node
node src/main.ts agent identity > dev-node.csr
node src/cli.ts node-register dev-node --csr dev-node.csr --address 127.0.0.1 | node src/main.ts agent install-cert
```

Start an agent that reports status without applying Docker changes:

```bash
export TUG_APPLY=false
npm run start:agent
```

Deploy a Compose project without uploading a build context:

```bash
node src/cli.ts deploy -f docker-compose.yml
node src/cli.ts status
```

Services with `build:` upload the current directory and control builds and stores compressed saved images for agents. `deploy --build-local` instead builds on the operator daemon and uploads archives; the platform must match target nodes. Published-image-only applications upload no context and control pins their registry digests before publication.

## Integration test

`docker-compose.sample.yml` is a three-service sample app with explicit placement: `web` on `vps-a`, `worker` on `vps-b`, `cache` on `vps-c`.

`docker-compose.integration.yml` starts a control plane and three fake VPSes. On macOS/Docker Desktop each fake VPS is a privileged Linux container with its own Docker daemon and Tug agent, so agents apply containers into isolated Docker environments through their own Engine API rather than the host daemon.

```bash
npm run test:integration
```

The test starts control, runs a provisioner that issues the root credential and each fake VPS's node identity (the `agent identity` / `agent install-cert` flow, written to the shared `/tokens` volume), sets a sample secret, deploys `docker-compose.sample.yml`, waits for all three agents to report the desired revision, verifies published images run by the digest pinned on control, and tears the stack down. Set `KEEP_INTEGRATION_STACK=true` to keep containers and volumes for inspection. The integration network defaults to subnet `10.89.240.0/24`; override it with `TUG_TEST_SUBNET` if that overlaps with local Docker or VPN networks. For concurrent runs, set a unique `COMPOSE_PROJECT_NAME`, `TUG_TEST_PORT` and matching `TUG_CONTROL_URL` (an `https://` connect target; the credential still verifies `https://control:8443`).

### Registry-free image integration

```bash
npm run test:integration:no-registry
```

The Node-driven `tools/scripts/integration-no-registry.js` uses `docker-compose.integration-no-registry.yml` with isolated control and node Docker daemons and no registry service or registry configuration. It verifies remote builds with changed application contents under a reused display version, rollback, agent restart, local application builds and backup/restore with a fresh image download. Separate daemons ensure a node cannot accidentally reuse control's already-built image instead of downloading the archive. The API port defaults to `18081` (`TUG_IMAGE_TEST_PORT` overrides it); use a unique `COMPOSE_PROJECT_NAME` when running alongside other tests. `KEEP_INTEGRATION_STACK=true` preserves the stack for inspection. These container tests do not establish real SSH installation, public ACME certificate issuance or a real-host NAT/WireGuard baseline.

### Rolling rollout integration test

```bash
npm run test:integration:rollout
```

Layers `docker-compose.integration-rollout.yml` over the same stack with a single fake VPS (`vps-a`) that runs the app and is the Caddy ingress node, then runs `tools/scripts/integration-rollout.js`. It deploys v1 of a rolling nginx service next to an unchanged recreated service, keeps requesting the app through Caddy from inside the VPS every ~50 ms while v2 rolls out (zero failed requests, v1 then v2 observed, the old container removed after the drain, the recreated service's container id unchanged), then deploys v3 whose health check fails and asserts that v2 kept serving the whole time, v3 never received a request, control recorded `deployment.auto_rollback` and the rollback deployment succeeded. It uses the compose project `tug-it-rollout` and the same host ports as the other integration tests, so run them one at a time; `KEEP_INTEGRATION_STACK=true` keeps the stack.

## Test VPS with Lima

`template-vps.yml` is a [Lima](https://lima-vm.io/) template for an Ubuntu VM with Docker and Node.js installed, useful as a real SSH target for `control-install` and `node-install`:

```bash
limactl start --name=vps template-vps.yml
```

### Networking integration test

```bash
npm run test:integration:network
```

Layers `docker-compose.integration-network.yml` over the same stack with `TUG_MESH=true` on control and all agents and `vps-c` marked as an ingress node, deploys `docker-compose.network-sample.yml` (`web` on `vps-a`, `client` on `vps-b`) and runs `tools/scripts/integration-verify-network.js`: node-to-node pings and a WireGuard handshake over the overlay, a container on `vps-b` fetching `http://web:8080` by its cross-node service name, Caddy on `vps-c` serving `Host: app.test` from `vps-a`, and mesh connectivity again after `node-rotate-wg-key`. It uses the compose project `tug-it-net` and the same ports as the plain integration test, so run them one at a time. The Docker host's kernel must support WireGuard (Linux 5.6+, Docker Desktop's VM included).

## Running the agent outside Docker

Run the agent in a container, as the installers do (`--network host`, the Docker socket mounted). An agent started as a plain host process, for example `node src/main.ts agent` on macOS, can create containers but cannot reach their IP addresses, so every TCP or HTTP health check times out and the deploy fails with a message such as `tcp timeout 172.21.0.2:3306` that does not mention where the agent runs. On Docker Desktop the Docker daemon lives in a VM, so container addresses are only reachable from inside it. When the agent is not in a container, a failed TCP or HTTP health check says so in its error and points at `docker run`; `doctor` does not check it separately.
