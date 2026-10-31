# Development

```bash
npm install
npm test
npm run lint
```

Unit tests sit next to the source files as `src/*.test.js`. The agent integration test lives in `test/integration/`.

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
node src/cli.js init --control-url http://localhost:8080 --token "$LAUNCHPAD_TOKEN"
node src/cli.js node:register --name dev-node --address 127.0.0.1
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
node src/cli.js deploy -f docker-compose.yml --no-build-upload
node src/cli.js status
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
