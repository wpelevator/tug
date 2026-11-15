# Tug

[![CI](https://github.com/wpelevator/tug/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/wpelevator/tug/actions/workflows/ci.yml?query=branch%3Amain) [![Release](https://github.com/wpelevator/tug/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/wpelevator/tug/actions/workflows/release.yml?query=branch%3Amain)

Deploy Docker Compose apps to your own Linux VPS with one command, from your laptop or CI. Images, rollbacks, backups, HTTPS and secrets are built in, so one small server can run the whole stack.

```sh
npm install -g @wpelevator/tug    # or run it with npx @wpelevator/tug
tug lint                          # check compose.yaml offline, no server needed
```

```text
compose.yaml: ok
```

Then install control and an agent on your VPS and deploy:

```sh
tug setup root@203.0.113.5
tug node add root@203.0.113.5 --name app1
tug deploy
```

A typical VPS is a durable, always-on computer with enough CPU, memory and disk to host several sites or a medium-size application and its database. Tug is the layer that makes self-hosting on one or a few servers safe and repeatable, so you keep the savings of a plain server without giving up deploys, rollbacks, backups and HTTPS. Tug is free, your Compose file stays a Compose file (`x-tug` is a standard Compose extension that plain Docker Compose ignores), and it is built for a small number of servers running Compose applications, including Node.js, Laravel, Ruby and WordPress apps.

## What you get

| Need | What Tug does | Details |
| --- | --- | --- |
| Get images to servers | Builds your images on control (or on your machine with `tug deploy --build-local`) and sends them to each server over connections the agents already make. Or push to any HTTPS registry and declare `image:`; control pins the tag to a digest before deploying. | [Control plane](docs/control-plane.md#image-delivery-without-a-registry) |
| Give CI one scoped credential | CI holds one credential limited by role (`read`, `deploy` or `admin`), and `deploy` credentials can be limited to projects. | [Access control](docs/access-control.md) |
| Back up and restore | Scheduled [restic](https://restic.net) backups of volumes and databases to S3-compatible storage. `tug restore run db` brings one back. Control backs itself up every night. | [Backups](docs/backups.md) |
| Roll back | `tug rollback` returns to a previous deployment, and `x-tug: { rollback: auto }` does it when a node reports the new version unhealthy. It cannot undo database writes or schema changes. | [Health checks](docs/health-checks.md) |
| Serve HTTPS | Managed Caddy serves a hostname with `tls: auto`, obtains the certificate and renews it. DNS must point at the server and ports 80 and 443 must be reachable. | [Networking](docs/networking.md#layer-b-ingress-and-tls) |
| Keep secrets out of git | `tug secret set` keeps them encrypted on control and delivers each only to the nodes whose services use it. Every `${NAME}` in your Compose file comes from control, never from the shell or `.env` of whoever runs the deploy, and `tug deploy --dry-run` shows where each value came from. | [Where values come from](docs/compose.md#where-values-come-from) |
| Read logs and open shells | `tug logs`, `tug exec`, `tug run` (for example the `wp` CLI), `tug ps` and `tug status` go through the control plane. SSH is needed only to install and manage nodes. | [CLI](docs/cli.md) |
| Catch config errors early | `tug lint` checks your `x-tug` config offline in milliseconds, and the same schema ships as JSON Schema for [editor autocomplete](docs/compose.md#editor-autocomplete-and-squiggles). A published tag is resolved to a digest before anything is deployed. | [Compose extensions](docs/compose.md) |

## Try it

Follow [Deploy your first service](docs/getting-started.md) to install Tug, deploy nginx to one VPS and verify that it works. You need Node.js 22.18 or newer on your computer, plus SSH access to a Linux server. Tug can install Docker on supported servers.

The control plane and agent share the VPS with your application. Once your service is running, you can [add HTTPS](docs/networking.md#layer-b-ingress-and-tls), [back up your data](docs/backups.md) or [add another server](docs/placement.md).

Existing service and resource targets can be chosen interactively (try `tug logs`, `tug deploy cancel` or `tug restore run`; see [interactive CLI selection](docs/cli.md#interactive-selection)). In a terminal Tug asks before it changes anything: whether to install Docker, which private address the node should use and whether it should handle ingress. It shows the plan and waits for you to confirm. `tug deploy` asks for any Compose variables, such as `${DB_PASSWORD}`, that no secret or `.env` provides. In CI or any other script nothing is ever asked, so pass the choices as flags (`--address`, `--ingress`, `--install-docker`, `-y`).

Long-running deployments, rollbacks, setup, image transfers, backups, restores and agent command waits report their current stage and elapsed time to stderr every ten seconds. Progress also works in CI and keeps JSON results separate. See [CLI progress reporting](docs/cli.md).

## How Tug is different

Tug moves the checks earlier: your images are built (on control, or on your machine with `--build-local`) and published tags are resolved to digests before a deployment is published, and a failed build leaves the nodes untouched. Third-party images are still pulled from their upstream registry at rollout.

- **Updates without downtime, when you opt in.** With `x-tug: { rollout: { strategy: rolling } }` the new revision starts next to the old one and ingress switches only once it is healthy. It needs ingress, a Tug health check and one published port; see [rolling rollouts](docs/compose.md#rolling-rollouts). The default `recreate` restarts the container and can interrupt traffic.
- **Know what is running.** Published images are pinned to a digest, built images get an immutable tag, and every deployment records who made it. `tug status`, `tug events` and `tug ps` show what runs where and how it got there.
- **Adding a server does not change your app.** Your Compose file and `x-tug` are held as desired state on control, `tug node add` bootstraps a fresh node (installing Docker if you ask), and services placed on it get the same pinned images.
- **Choose where things run.** Pin a database and its volume to one node and spread web containers over several.
- **Works behind NAT.** Agents only dial out to control, so a node can sit behind a firewall that allows nothing inbound. Tug needs no cloud provider API or overlay network.

## Is Tug right for you?

Tug fits if you run Compose apps on one or a few VPSes, want deploys, rollbacks, secrets and backups handled in one tool, and are happy with a single control server that you back up. A server can host multiple apps as long as it has enough capacity; Tug does not automatically balance resource usage or replace a failed server. Node-to-node traffic travels over your own private network (Tailscale, a VPC, a LAN), so you own its firewalling and encryption. The goals, principles and planned milestones are in the [Roadmap](docs/roadmap.md).

### Not for you if

- You need Kubernetes-style scheduling, autoscaling, distributed storage, database failover, automatic rescheduling across a cluster or servers provisioned through a provider's API. See the [Docker Swarm comparison](docs/swarm-comparison.md).
- Your workloads are not Compose and Docker, or you need to roll back the host itself. `tug rollback` reverts deployments, not host packages or kernel settings.
- You run several servers with no private network between them. Management traffic works where inbound connections don't, but node-to-node service traffic needs a VPC, LAN or VPN.
- You need to hide secrets from people who can deploy. A `deploy` credential can read secret values with `exec` or through deployed code; `inspect` redacts environment values, but not a secret you put in `command` or `labels`.

## Your Compose file, plus a little `x-tug`

This example builds on the [quickstart](docs/getting-started.md). It pins the app, database and database volume to `app1`. Placement can be omitted with one node, but explicit placement keeps the database on its chosen server when you add more nodes. Enable ingress with `tug node ingress app1`, point the hostname's DNS at the VPS, and allow public ports 80 and 443. Save this as `compose.yaml` and replace the hostname with yours:

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

```bash
tug secret set DB_ROOT_PASSWORD
tug deploy
tug status       # what is running where, and anything failing
tug logs wordpress --follow
```

The named volume holds data on `app1`; it is not copied to another node automatically. Back it up and restore or move its data deliberately if you replace the server.

See the [examples directory](examples) for stack-specific applications and [local stack benchmarks](docs/testing.md#example-stack-benchmarks) for measured behavior of those examples. Everything `x-tug` can express is in [Compose extensions](docs/compose.md).

## Everyday commands

Project commands sit at the top level; everything else reads `tug <subject> <verb>`.

| I want to... | Run |
| --- | --- |
| Deploy, or undo a deploy | `tug deploy`, `tug rollback` |
| See what is running and what failed | `tug status`, `tug events`, `tug ps` |
| Read logs or open a shell | `tug logs <service>`, `tug exec <service> sh` |
| Run a one-off command | `tug run <service> -- wp cache flush` |
| Change the number of replicas | `tug scale <service> 3` |
| Add, list or replace servers | `tug node add`, `tug node list`, `tug node replace <name>` |
| Upgrade control and nodes after a release | `tug upgrade` (or `tug control upgrade`, then `tug node upgrade --all`) |
| Add a server I cannot SSH to | `tug node enroll`, then run the printed `docker run` on it |
| Manage secrets and variables | `tug secret set`, `tug secret import .env`, `tug var set`, `tug deploy --dry-run` |
| Back up now, or restore | `tug backup run`, `tug restore run <target>` |
| Give CI a deploy key | `tug credential create ci --role deploy` |
| Check everything is healthy | `tug doctor` |

Every command and option is in the [CLI reference](docs/cli.md). `tug status --json` prints raw JSON for scripts.

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

`tug deploy` reads your Compose file on your machine and sends it to the control plane, which stores it as an immutable desired state, builds application images when needed and pins published images to digests. Tug delivers its built images as archives; published images are pulled from their upstream registries. Each agent fetches the work for its node, applies it through the Docker Engine API, runs the health checks and reports back. The control plane marks the deployment done when every node reports it serving. Tug reads Compose files with its own built-in reader, so Docker Compose is not needed anywhere: nodes need only Docker Engine, and control runs as a container started with `docker run`. Cross-node workload traffic uses your own private network.

Control serves mutual TLS directly on one port (`8443`). Every operator, CI job and node authenticates with a certificate from a private CA created at install, so the control address can be a bare IP and can change later. Do not terminate TLS in front of it. A `controlUrl` in `tug.yml` tells the CLI where control is (see [CLI configuration](docs/cli.md#config-file)). [Architecture](docs/architecture.md) covers every flow in detail, and [Security](docs/security-audit.md) the trust boundaries.

## Documentation

The [documentation index](docs/index.md) lists every page by task. The ones you will reach for first:

- **Start:** [Deploy your first service](docs/getting-started.md), then the [application examples](examples/README.md)
- **Run it for real:** [Production checklist](docs/production-checklist.md), [Backups and recovery](docs/backups.md), [Upgrade control and nodes](docs/upgrades.md), [Troubleshooting](docs/troubleshooting.md)
- **Look it up:** [CLI](docs/cli.md), [Compose extensions](docs/compose.md), [Configuration](docs/configuration.md), [Access control](docs/access-control.md)
- **Understand it:** [Architecture](docs/architecture.md), [Docker Swarm comparison](docs/swarm-comparison.md), [Terminal UI](docs/tui.md)
- **Contribute:** [Development](docs/development.md), [Testing](docs/testing.md), [Releases](docs/releases.md), and the [design records](docs/design-records.md) (roadmap, security audit, proposals)

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details. Database code uses direct SQLite queries; [SQLite storage](docs/architecture.md#sqlite-storage) describes query boundaries and synchronous transactions.
