# Development

The source is TypeScript. Development and tests run the `.ts` files directly through Node's built-in type stripping, so there is no build step, but it needs Node >= 22.18 (`engines.node`). Compilation to `dist/` happens only when building the Docker image.

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run test:smoke:dist
```

`npm test` runs `node --test 'src/**/*.test.ts'`. `npm run typecheck` runs `tsc --noEmit` over `src/` and `test/` with `strict` on. `npm run build` compiles `src/` to `dist/` (JavaScript plus `.d.ts`) and copies `src/templates` to `dist/templates`. `npm run test:smoke:dist` builds and checks that `control install` and `node install` render their templates from `dist/`.

Import specifiers in the source use the `.ts` extension (`import { x } from './util.ts'`) because Node's type stripping does not remap `.js` to `.ts`; `tsc` rewrites them to `.js` in `dist/` (`rewriteRelativeImportExtensions`). Only erasable TypeScript syntax is allowed (`erasableSyntaxOnly`: no enums or constructor parameter properties).

Unit tests sit next to the source files as `src/*.test.ts`. The agent integration test lives in `test/integration/`.

## Docker image

The Dockerfiles are multi-stage: a build stage runs `npm ci && npm run build`, and the final image ships `dist/` plus production dependencies only, with entrypoint `node dist/main.js`. `tsc` does not copy `src/templates/*`, so `npm run build` copies them next to the emitted `dist/cli.js`; the CLI resolves them relative to the running file, so `node src/cli.ts` and `node dist/cli.js` both work.

## Compose stack

`docker-compose.yml` defines:

- `registry`: a local Docker Registry on port `5000`, built from `services/registry` with htpasswd auth enabled (`auth.htpasswd` in `services/registry/config/config.yml`).
- `control`: the control API on port `8080`, with SQLite and master key data in a named volume. It mounts the `registry-auth` volume (`LAUNCHPAD_REGISTRY_AUTH_PATH`) and the Docker socket, so it can write per-node htpasswd entries and restart the registry container (`LAUNCHPAD_REGISTRY_CONTAINER`) when a node's registry token is issued, rotated or revoked.
- `agent`: an optional profile service; run it with `--profile agent` after setting `LAUNCHPAD_AGENT_TOKEN`.

```bash
docker compose up --build control registry
# after registering a node and obtaining its token:
LAUNCHPAD_AGENT_TOKEN=... docker compose --profile agent up agent
```

The control service prints the initial operator token and stores it in `./data/operator.token` when run on the host, or in the `launchpad-data` volume when run in Docker.

## Host mode

```bash
npm run start:control
export LAUNCHPAD_TOKEN=$(cat data/operator.token)
node src/cli.ts init --control-url http://localhost:8080 --token "$LAUNCHPAD_TOKEN"
node src/cli.ts node:register --name dev-node --address 127.0.0.1
```

Start an agent that renders files and reports status without applying Docker changes:

```bash
export LAUNCHPAD_AGENT_TOKEN=<token from node:register>
export LAUNCHPAD_NODE_NAME=dev-node
export LAUNCHPAD_APPLY=false
npm run start:agent
```

Deploy a Compose project without uploading a build context:

```bash
node src/cli.ts deploy -f docker-compose.yml --no-build-upload
node src/cli.ts status
```

Omit `--no-build-upload` to upload the current directory and let control run `docker build` for services with `build:`. `LAUNCHPAD_PUSH=false` builds without pushing; enable pushing when a reachable registry is configured.

## Integration test

`docker-compose.sample.yml` is a three-service sample app with explicit placement: `web` on `vps-a`, `worker` on `vps-b`, `cache` on `vps-c`.

`docker-compose.integration.yml` starts a control plane and three fake VPSes. On macOS/Docker Desktop each fake VPS is a privileged Linux container with its own Docker daemon and Launchpad agent, so agents apply Compose into isolated Docker environments rather than the host daemon.

```bash
npm run test:integration
```

The test provisions `vps-a`, `vps-b` and `vps-c`, sets a sample secret, deploys `docker-compose.sample.yml`, waits for all three agents to report the desired version, verifies registry pull auth with `scripts/integration-verify-registry-auth.js` (a rotated token authenticates, a wrong password and a revoked token are rejected), and tears the stack down. Set `KEEP_INTEGRATION_STACK=true` to keep containers and volumes for inspection. The integration network uses subnet `10.89.240.0/24`; change it if that overlaps with local Docker or VPN networks.

## Test VPS with Lima

`template-vps.yml` is a [Lima](https://lima-vm.io/) template for an Ubuntu VM with Docker and Node.js installed, useful as a real SSH target for `control install` and `node install`:

```bash
limactl start --name=vps template-vps.yml
```
