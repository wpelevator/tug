# tug

[![CI](https://github.com/wpelevator/tug/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/wpelevator/tug/actions/workflows/ci.yml?query=branch%3Amain) [![Release](https://github.com/wpelevator/tug/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/wpelevator/tug/actions/workflows/release.yml?query=branch%3Amain)

Deploy Docker Compose apps to your own Linux VPS with one command, from your laptop or CI. tug adds image delivery, rollbacks, scheduled backups, HTTPS and encrypted secrets, so one small server can run a whole stack and a few servers can run a larger one.

```sh
npm install -g @wpelevator/tug    # or run it with npx @wpelevator/tug
tug lint                          # check compose.yaml offline, no server needed
```

```text
compose.yaml: ok
```

Then install control and an agent on your VPS, and deploy:

```sh
tug setup root@203.0.113.5
tug node add root@203.0.113.5 --name app1
tug deploy
```

You need Node.js 22.18 or newer on your computer and root SSH access to a Linux server. tug can install Docker on Debian, Ubuntu, Fedora and RHEL-compatible servers. [Deploy your first service](docs/getting-started.md) walks through each step.

## Who it is for

tug is for people who run Compose apps (Node.js, Laravel, Ruby, WordPress and the like) on one or a few VPSes and want deploys, rollbacks, backups and HTTPS in one tool, with one control server that they back up. Your Compose file stays a Compose file: `x-tug` is a standard Compose extension that plain Docker Compose ignores. tug is open source under the MIT license.

Managed ingress balances HTTP requests across serving replicas with round robin. Cross-node service names do not balance traffic, and tug does not automatically reschedule services or replace a failed server. Node-to-node traffic uses your own private network (Tailscale, a VPC, a LAN), so you own its firewalling and encryption.

### Not for you if

- You need Kubernetes-style scheduling, autoscaling, distributed storage, database failover, automatic rescheduling across a cluster or servers provisioned through a provider's API. See the [Docker Swarm comparison](docs/swarm-comparison.md).
- Your workloads are not Compose and Docker, or you need to roll back the host itself. `tug rollback` reverts deployments, not host packages or kernel settings.
- You run several servers with no private network between them. Management traffic works where inbound connections don't, but node-to-node service traffic needs a VPC, LAN or VPN.
- You need to hide secrets from people who can deploy. A `deploy` credential can read secret values with `exec` or through deployed code. `inspect` redacts environment values, but not a secret you put in `command` or `labels`.

## What you get

| Need | What tug does | Details |
| --- | --- | --- |
| Get images to servers | Builds your images on control (or on your machine with `tug deploy --build-local`) and sends them over connections the agents already make. Or push to any HTTPS registry and declare `image:`, and control pins the tag to a digest before deploying. With both `build:` and `image:` the image wins, and `tug deploy --build` builds instead. A failed build leaves the nodes untouched. | [Control plane](docs/control-plane.md#image-delivery-without-a-registry) |
| Serve HTTPS | Managed Caddy serves a hostname with `tls: auto`, gets the certificate and renews it. DNS must point at the server and ports 80 and 443 must be reachable. | [Ingress](docs/ingress.md) |
| Back up and restore | Scheduled [restic](https://restic.net) backups of volumes and databases to S3-compatible storage, a restic REST server and other restic backends. `tug restore run db` brings one back. Control backs itself up every night. | [Backups](docs/backups.md) |
| Keep secrets out of git | `tug secret set` keeps them encrypted on control and delivers each only to the nodes whose services use it. Every `${NAME}` in your Compose file comes from control, never from the shell or `.env` of whoever runs the deploy. | [Where values come from](docs/compose.md#where-values-come-from) |
| Roll back | `tug rollback` returns to a previous deployment, and a top-level `x-tug: { rollback: auto }` does it when a node reports the new version unhealthy. It cannot undo database writes or schema changes. | [Health checks](docs/healthchecks.md) |
| Update without a restart | `x-tug: { rollout: { strategy: rolling } }` starts the new revision beside the old one and switches ingress once it is healthy. It needs ingress, a tug health check and one published port. The default `recreate` restarts the container and can interrupt traffic. | [Rolling rollouts](docs/compose.md#rolling-rollouts) |
| Give CI one scoped credential | One credential limited by role (`read`, `deploy` or `admin`), and for `deploy` by project. | [Access control](docs/access-control.md) |
| Read logs and open shells | `tug logs`, `tug exec`, `tug run` (for example the `wp` CLI), `tug ps` and `tug status` go through the control plane. SSH is only for installing and managing nodes. | [CLI](docs/cli.md) |
| Catch config errors early | `tug lint` checks your `x-tug` config offline, and the same schema ships as JSON Schema for [editor autocomplete](docs/compose.md#editor-autocomplete-and-squiggles). | [Compose extensions](docs/compose.md) |
| Know what runs | Published images are pinned to a digest, built images get an immutable tag, and every deployment records who made it. | [Access control](docs/access-control.md#audit-trail) |
| Add a server | `tug node add` bootstraps a fresh node. Agents only dial out to control, so a node can sit behind a firewall that allows nothing inbound. | [Nodes](docs/nodes.md) |

## Your Compose file, plus a little `x-tug`

This WordPress example pins the app, the database and the database volume to `app1`. Placement can be omitted with one node, but explicit placement keeps the database on its chosen server when you add more nodes. Enable ingress with `tug node ingress app1`, point the hostname's DNS at the VPS, allow public ports 80 and 443, and replace the hostname with yours.

<!-- tug-values: DB_ROOT_PASSWORD -->
```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  db:
    image: mariadb:11.4.8
    volumes:
      - db-data:/var/lib/mysql
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    x-tug:
      placement:
        nodes:
          - app1
      health:
        type: tcp
        port: 3306

  wordpress:
    image: wordpress:6.8.3-apache
    depends_on:
      - db
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: root
      WORDPRESS_DB_PASSWORD: ${DB_ROOT_PASSWORD}
    ports:
      - "8080:80"
    x-tug:
      placement:
        nodes:
          - app1
      health:
        type: http
        port: 80
        path: /wp-includes/version.php
      ingress:
        host: blog.example.com
        port: 80
        tls: auto

volumes:
  db-data:
    x-tug:
      placement:
        nodes:
          - app1
```

```sh
tug secret set DB_ROOT_PASSWORD
tug deploy
tug status
tug logs wordpress --follow
```

`tug status` shows what runs where and anything failing. The named volume holds data on `app1` and is not copied to another node, so back it up and restore or move its data deliberately if you replace the server. The [examples](examples/README.md) have complete apps, with scheduled backups, for several stacks, and every `x-tug` key is in [Compose extensions](docs/compose.md).

## Everyday commands

| I want to | Run |
| --- | --- |
| Deploy, or undo a deploy | `tug deploy`, `tug rollback` |
| See what is running and what failed | `tug status`, `tug events`, `tug ps` |
| Read logs or open a shell | `tug logs <service>`, `tug exec <service> sh` |
| Run a one-off command | `tug run <service> -- wp cache flush` |
| Add or replace a server | `tug node add`, `tug node replace <name>` |
| Upgrade control and nodes | `tug upgrade` |
| Manage secrets and variables | `tug secret set`, `tug secret import .env`, `tug var set`, `tug deploy --dry-run` |
| Back up now, or restore | `tug backup run`, `tug restore run <target>` |
| Give CI a deploy key | `tug credential create ci --role deploy` |
| Check that everything is healthy | `tug doctor` |

Project commands sit at the top level and the rest read `tug <subject> <verb>`. Every command and flag is in the [CLI reference](docs/cli.md).

## How it works

```text
                      tug CLI / CI
                           |
                           | mTLS: deploy, status, logs, exec
                           v
+--------------------------------+     +--------------------------------+
| VPS app1                       |     | VPS app2 (optional)            |
|                                |     |                                |
| Control plane                  |     |                                |
| API, SQLite, image builds      |     |                                |
|                                |     |                                |
| Agent --> Docker Engine        |     | Agent --> Docker Engine        |
|              |                 |     |              |                 |
|              +-- service A     |     |              +-- service C     |
|              +-- database      |     |              +-- service D     |
|              +-- more...       |     |              +-- more...       |
|     (zero or more services)    |     |     (zero or more services)    |
|                                |     |                                |
| Local volumes, optional Caddy  |     | Local volumes, optional Caddy  |
+--------------------------------+     +--------------------------------+
             |                                         |
             +------- private workload network --------+

  Each agent connects to the control plane over mTLS. Services are
  placed on either node; local volumes stay on their node. app1 can
  run alone. SSH installs control and agents; normal operations use
  the control API.
```

`tug deploy` reads your Compose file on your machine and sends it to the control plane. Control stores it as an immutable desired state, builds application images when needed and pins published images to digests. Each agent fetches the work for its node, applies it through the Docker Engine API, runs the health checks and reports back. Control marks the deployment done when every node reports it serving. tug reads Compose files with its own reader, so nodes need only Docker Engine and Docker Compose is not needed anywhere.

Control serves mutual TLS on one port (`8443`). Every operator, CI job and node authenticates with a certificate from a private CA created at install, so the control address can be a bare IP and can change later. Do not terminate TLS in front of it. [Architecture](docs/architecture.md) covers every flow, and the [security audit](docs/security-audit.md) covers the trust boundaries.

Control readiness monitoring uses an authenticated `GET /api/v1/readyz` with a `read` credential; it checks database reads, overdue writer work and whether control needs a restart after restore. Project-filtered Prometheus metrics are at `/api/v1/metrics`; optional signed webhooks report actionable state changes. See [Observability](docs/observability.md) for setup and limits.

## Documentation

The [documentation index](docs/index.md) lists every page by task. The ones you will reach for first:

- **Start:** [Deploy your first service](docs/getting-started.md), then the [examples](examples/README.md)
- **Run it for real:** [Production checklist](docs/production-checklist.md), [Backups](docs/backups.md), [Upgrades](docs/upgrades.md), [Troubleshooting](docs/troubleshooting.md)
- **Look it up:** [CLI](docs/cli.md), [Compose extensions](docs/compose.md), [Configuration](docs/configuration.md), [Access control](docs/access-control.md)
- **Contribute:** [Development](docs/development.md), [Testing](docs/testing.md), [Releases](docs/releases.md), and the [design records](docs/design-records.md)

## Development

```sh
npm install
npm test
npm run lint
```

[Development](docs/development.md) covers the integration tests, the Docker image and the test VPS setup.

## License

tug is released under the [MIT License](LICENSE).
