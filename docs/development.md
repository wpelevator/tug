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

The runtime image ships its own Docker client and Compose plugin for the control host, which still installs through Compose, because mounting the host Docker socket does not make the host's CLI plugins available inside the agent. Runtime and fake-VPS Dockerfiles pin `DOCKER_COMPOSE_VERSION=2.32.4` and support `amd64`/`arm64`; update and verify both pins together. This Compose version retains compatibility with the older nested Docker daemons used in integration tests.

Run `npm run test:smoke:image` to build the actual shipped runtime image and execute its Docker, Compose and Node binaries plus compiled control/agent database initialization, a writable snapshot and read-only validation without mounting the host socket or CLI plugins. To test an already-built image, set `TUG_RUNTIME_IMAGE=<tag>`. CI runs this packaging smoke before the integration test, so the fake-VPS image cannot mask missing runtime tools.

## Continuous integration and releases

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: typecheck and lint on Node 24 (the version in `.nvmrc`), unit tests and the dist smoke test on the exact minimum Node 22.18.0 and current Node 22 and 24, plus the Docker integration tests (fake VPS containers, registry-free image delivery, the WireGuard mesh and rolling rollouts) as separate jobs. `.github/workflows/release.yml` versions and publishes; see [Releases](releases.md). Every user-facing change needs a changeset (`npm run changeset`).

### CI caching

The `.github/actions/setup` composite action installs Node.js with the npm download cache (keyed on the lockfile) and runs `npm ci`; every job uses it. The integration jobs prebuild their images with `.github/actions/build-images` (Buildx and the GitHub Actions layer cache, scopes `runtime` and `fake-vps`) and set `TUG_COMPOSE_BUILD=` so the integration scripts run `compose up` without `--build`; the Compose files tag those images `tug-runtime:integration` and `tug-fake-vps:integration`. Locally the variable is unset and the scripts keep passing `--build`. Only pushes to `main` write the cache, because a pull request can read the default branch's cache but not another pull request's. The release workflow's `edge` job exports the `runtime` scope and the versioned `image` job reads it. The Dockerfiles pin the Node.js major (`node:24-*`), so an upstream LTS bump cannot silently invalidate the cache or change the shipped runtime.

Published images are `ghcr.io/wpelevator/tug`. To test an unreleased CLI against a checkout, use `--build-local-image` on `control-install` and `node-install` (builds `tug:local` from the working directory and copies it over SSH). The dev Compose files (`docker-compose*.yml`) and the integration tests always build the image from the checkout with `build: .` and never pull from GHCR.

## Compose stack

`docker-compose.yml` defines:

- `control`: the control API on port `8080`, with SQLite, master key and saved image archives in a named volume, plus the Docker socket for builds.
- `agent`: an optional profile service; run it with `--profile agent` after setting `TUG_AGENT_TOKEN`.

```bash
docker compose up --build control
# after registering a node and obtaining its token:
TUG_AGENT_TOKEN=... docker compose --profile agent up agent
```

The control service prints the initial operator token and stores it in `./data/operator.token` when run on the host, or in the `tug-data` volume when run in Docker.

## Host mode

```bash
npm run start:control
export TUG_TOKEN=$(cat data/operator.token)
node src/cli.ts init --control-url http://localhost:8080 --token "$TUG_TOKEN"
node src/cli.ts node-register dev-node --address 127.0.0.1
```

Start an agent that renders files and reports status without applying Docker changes:

```bash
export TUG_AGENT_TOKEN=<token from node-register>
export TUG_NODE_NAME=dev-node
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

`docker-compose.integration.yml` starts a control plane and three fake VPSes. On macOS/Docker Desktop each fake VPS is a privileged Linux container with its own Docker daemon and Tug agent, so agents apply Compose into isolated Docker environments rather than the host daemon.

```bash
npm run test:integration
```

The test provisions `vps-a`, `vps-b` and `vps-c`, sets a sample secret, deploys `docker-compose.sample.yml`, waits for all three agents to report the desired version, verifies published images run by the digest pinned on control, and tears the stack down. Set `KEEP_INTEGRATION_STACK=true` to keep containers and volumes for inspection. The integration network defaults to subnet `10.89.240.0/24`; override it with `TUG_TEST_SUBNET` if that overlaps with local Docker or VPN networks. For concurrent runs, set a unique `COMPOSE_PROJECT_NAME`, `TUG_TEST_PORT` and matching `TUG_CONTROL_URL`.

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

Layers `docker-compose.integration-network.yml` over the same stack with `TUG_MESH=true` on control and all agents and `vps-c` marked as an ingress node, deploys `docker-compose.network-sample.yml` (`web` on `vps-a`, `client` on `vps-b`) and runs `tools/scripts/integration-verify-network.js`: node-to-node pings and a WireGuard handshake over the overlay, a container on `vps-b` fetching `http://web:8080` by name, Caddy on `vps-c` serving `Host: app.test` from `vps-a`, and mesh connectivity again after `node-rotate-wg-key`. It uses the compose project `tug-it-net` and the same ports as the plain integration test, so run them one at a time. The Docker host's kernel must support WireGuard (Linux 5.6+, Docker Desktop's VM included).
