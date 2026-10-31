# Development

The source is TypeScript. Development and tests run the `.ts` files directly through Node's built-in type stripping, so there is no build step, but it needs Node >= 22.18 (`engines.node`). Compilation to `dist/` happens when building the Docker image and when packing the npm package (`prepack`).

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run test:smoke:dist
```

`npm test` runs `node --test 'src/**/*.test.ts'`. `npm run typecheck` runs `tsc --noEmit` over `src/` and `tests/` with `strict` on. `npm run build` compiles `src/` to `dist/` (JavaScript plus `.d.ts`) and copies `src/templates` to `dist/templates`. `npm run test:smoke:dist` builds and checks that `control-install` and `node-install` render their templates from `dist/`.

Import specifiers in the source use the `.ts` extension (`import { x } from './util.ts'`) because Node's type stripping does not remap `.js` to `.ts`; `tsc` rewrites them to `.js` in `dist/` (`rewriteRelativeImportExtensions`). Only erasable TypeScript syntax is allowed (`erasableSyntaxOnly`: no enums or constructor parameter properties).

Unit tests sit next to the source files as `src/*.test.ts`. The agent integration test lives in `tests/integration/`.

## Docker image

The Dockerfiles are multi-stage: a build stage runs `npm ci && npm run build`, and the final image ships `dist/` plus production dependencies only, with entrypoint `node dist/main.js`. `tsc` does not copy `src/templates/*`, so `npm run build` copies them next to the emitted `dist/cli.js`; the CLI resolves them relative to the running file, so `node src/cli.ts` and `node dist/cli.js` both work.

The runtime image ships its own Docker client and Compose plugin because mounting the host Docker socket does not make the host's CLI plugins available inside the agent. Runtime and fake-VPS Dockerfiles pin `DOCKER_COMPOSE_VERSION=2.32.4` and support `amd64`/`arm64`; update and verify both pins together. This Compose version retains compatibility with the older nested Docker daemons used in integration tests.

Run `npm run test:smoke:image` to build the actual shipped runtime image and execute its Docker, Compose and Node binaries without mounting the host socket or CLI plugins. To test an already-built image, set `TUG_RUNTIME_IMAGE=<tag>`. CI runs this packaging smoke before the registry integration test, so the fake-VPS image cannot mask missing runtime tools.

## Continuous integration and releases

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: typecheck and lint (Node 24 only), unit tests and the dist smoke test on Node 22 and 24, plus the Docker integration tests (fake VPS containers, registry-free image delivery and the WireGuard mesh) as separate jobs. `.github/workflows/release.yml` versions and publishes; see [Releases](releases.md). Every user-facing change needs a changeset (`npm run changeset`).

### CI caching

The `.github/actions/setup` composite action installs Node.js with the npm download cache (keyed on the lockfile) and runs `npm ci`; every job uses it. The integration jobs prebuild their images with `.github/actions/build-images` (Buildx and the GitHub Actions layer cache, scopes `runtime`, `fake-vps` and `registry`) and set `TUG_COMPOSE_BUILD=` so the integration scripts run `compose up` without `--build`; the Compose files tag those images `tug-runtime:integration`, `tug-fake-vps:integration` and `tug-registry:integration`. Locally the variable is unset and the scripts keep passing `--build`. Only pushes to `main` write the cache, because a pull request can read the default branch's cache but not another pull request's. The release workflow's `edge` job exports the `runtime` scope and the versioned `image` job reads it. The Dockerfiles pin the Node.js major (`node:24-*`), so an upstream LTS bump cannot silently invalidate the cache or change the shipped runtime.

Published images are `ghcr.io/wpelevator/tug`. To test an unreleased CLI against a checkout, use `--build-local-image` on `control-install` and `node-install` (builds `tug:local` from the working directory and copies it over SSH). The dev Compose files (`docker-compose*.yml`) and the integration tests always build the image from the checkout with `build: .` and never pull from GHCR.

## Compose stack

`docker-compose.yml` defines:

- `registry`: a local Docker Registry on port `5000`, built from `tools/docker/registry` with htpasswd auth enabled (`auth.htpasswd` in `tools/docker/registry/config/config.yml`).
- `control`: the control API on port `8080`, with SQLite and master key data in a named volume. It mounts the `registry-auth` volume (`TUG_REGISTRY_AUTH_PATH`) and the Docker socket, so it can write per-node htpasswd entries and restart the registry container (`TUG_REGISTRY_CONTAINER`) when a node's registry token is issued, rotated or revoked.
- `agent`: an optional profile service; run it with `--profile agent` after setting `TUG_AGENT_TOKEN`.

```bash
docker compose up --build control registry
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
node src/cli.ts deploy -f docker-compose.yml --no-build-upload
node src/cli.ts status
```

Omit `--no-build-upload` to upload the current directory and let control run `docker build` for services with `build:`. Without `TUG_REGISTRY`, control stores compressed saved images and agents download/load them directly. `deploy --build-local` instead builds on the operator's Docker daemon and uploads image archives without source; the resulting platform must match target nodes. A configured registry retains build-and-push behavior. Published-image-only applications upload no context. `--no-build-upload` is for applications whose images are already published; it cannot supply missing build input.

## Integration test

`docker-compose.sample.yml` is a three-service sample app with explicit placement: `web` on `vps-a`, `worker` on `vps-b`, `cache` on `vps-c`.

`docker-compose.integration.yml` starts a control plane and three fake VPSes. On macOS/Docker Desktop each fake VPS is a privileged Linux container with its own Docker daemon and Tug agent, so agents apply Compose into isolated Docker environments rather than the host daemon.

```bash
npm run test:integration
```

The test provisions `vps-a`, `vps-b` and `vps-c`, sets a sample secret, deploys `docker-compose.sample.yml`, waits for all three agents to report the desired version, verifies registry pull auth with `tools/scripts/integration-verify-registry-auth.js` (a rotated token authenticates, a wrong password and a revoked token are rejected), and tears the stack down. Set `KEEP_INTEGRATION_STACK=true` to keep containers and volumes for inspection. The integration network uses subnet `10.89.240.0/24`; change it if that overlaps with local Docker or VPN networks.

### Registry-free image integration

```bash
npm run test:integration:no-registry
```

The Node-driven `tools/scripts/integration-no-registry.js` uses `docker-compose.integration-no-registry.yml` with isolated control and node Docker daemons and no registry service or registry configuration. It verifies remote builds with changed application contents under a reused display version, rollback, agent restart, local application builds and backup/restore with a fresh image download. Separate daemons ensure a node cannot accidentally reuse control's already-built image instead of downloading the archive. The API port defaults to `18081` (`TUG_IMAGE_TEST_PORT` overrides it); use a unique `COMPOSE_PROJECT_NAME` when running alongside other tests. `KEEP_INTEGRATION_STACK=true` preserves the stack for inspection. These container tests do not establish real SSH installation, public ACME certificate issuance or a real-host NAT/WireGuard baseline.

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
