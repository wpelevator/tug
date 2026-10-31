# Pad Launch / Launchpad

Deploy Docker Compose projects to one or more ordinary Linux VPSes through a small self-hosted control plane and a pull-based agent on each node, without Kubernetes or a hosted PaaS. The original specification is in [plan.md](plan.md).

## Features

- Control API with bearer-token auth and SQLite metadata.
- Nodes join over SSH (`node install`) or enroll themselves with a single `docker run` (`node enroll`), with per-node agent and registry tokens. Agents only dial out, so nodes behind NAT work.
- Agents pull desired state from control, apply a generated per-node Compose file, run TCP/HTTP/Docker health checks and report status.
- `x-launchpad` placement of services and volumes on nodes, with immutable desired-state records per deployment.
- Optional remote Docker builds on the control host from an uploaded source tarball.
- Secrets encrypted at rest, released only to the nodes whose services reference them, with targeted service recreation when only a secret changes.
- Deployment convergence, per-project operation locks, cancellation, rollback, per-service rollout events and log fetching through the agents.
- Per-node registry pull tokens enforced by an htpasswd-backed registry you provide, with rotation and revocation.
- Control-plane backup and restore, and `launchpad doctor` diagnostics.

## Quick start

1. Install the control plane on a Docker host, pointing it at a registry you already run: `launchpad control install root@control.example.com --registry registry.example.com`.
2. Point the CLI at it: `launchpad init --control-url https://control.example.com --token "$LAUNCHPAD_TOKEN"`.
3. Set the secrets your services need: `launchpad secret:set DB_PASSWORD`.
4. Add nodes, either `launchpad node install root@app1.example.com --name app1 --control-url https://control.example.com --registry registry.example.com`, or `launchpad node enroll --name app1` and run the printed `docker run` on the host.
5. Deploy: `launchpad deploy -f docker-compose.yml`. It waits until every node reports the new version healthy.
6. Operate with `launchpad status`, `events`, `logs`, `restart`, `rollback` and `doctor`.

## Documentation

- [Architecture](docs/architecture.md): components, reconciliation, workflow diagrams, secrets and runtime paths.
- [Compose extensions](docs/compose.md): `x-launchpad` placement, health checks, volumes and limitations.
- [Control plane](docs/control-plane.md): install, TLS, registry credentials, backup and restore.
- [Nodes](docs/nodes.md): SSH install, self-service enrollment, registration and status.
- [CLI reference](docs/cli.md): every `launchpad` command and option.
- [Configuration](docs/configuration.md): CLI, control and agent environment variables.
- [Development](docs/development.md): local setup, Compose stack, host mode and the integration test.
- [Roadmap](docs/roadmap.md): planned milestones toward parity with and beyond uncloud.

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details.
