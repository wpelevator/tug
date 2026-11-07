# tug

Deploy Docker Compose apps to your own Linux VPS with one command, from your laptop or CI. Images, rollbacks, backups, HTTPS and secrets are built in, so one small server can run the whole stack.

A typical VPS is a durable, always-on computer with enough CPU, memory and disk to host several sites or a medium-size application and its database. You do not need a cluster, a per-app platform plan or a pile of managed services to run that well, and a plain server often costs far less than renting the same capacity piece by piece. tug is the missing layer that makes self-hosting on one or a few servers safe and repeatable, so you keep the savings without giving up deploys, rollbacks, backups and HTTPS.

## What you get

- **Image delivery built in, registry optional.** By default your own images are built on the control server (or on your machine with `tug deploy --build-local`) and sent to each server as an archive over connections the agents already make. If you prefer to build in CI, push to any HTTPS registry (GHCR, Docker Hub, a private one) and declare `image:`; control pins the tag to a digest before deploying. Third-party images such as `nginx` are always pulled from their registry.
- **One scoped credential for CI.** CI holds a single tug credential limited by role (`read`, `deploy` or `admin`), and `deploy` credentials can be limited to projects (`tug credential create ci --role deploy --project site`). Built images need no registry login on your servers. For a private registry, store its pull credentials once as an encrypted project secret (`TUG_REGISTRY_AUTH`; see [private registries](docs/control-plane.md#published-images-and-private-registries)); control uses them to resolve digests and agents receive only the credentials for the registries their images need.
- **Scheduled, restorable backups.** Mark a volume or database with `x-tug.backup`, point tug at S3-compatible storage and it runs scheduled [restic](https://restic.net) backups; databases use a dump command. `tug restore run db` brings one back.
- **One-command rollback.** `tug rollback` returns to a previous deployment, and `x-tug: { rollback: auto }` does it when a node reports the new version unhealthy. It cannot undo database writes or schema changes.
- **HTTPS ingress included.** Managed Caddy serves a hostname with `tls: auto`, obtains the certificate and renews it. Your DNS must point at the server and ports 80 and 443 must be reachable.
- **Encrypted secrets, delivered where needed.** `tug secret set DB_PASSWORD` keeps them encrypted on control and delivers each one only to the nodes whose services use it, so nothing lives in your repository.
- **Logs and shells from your laptop.** `tug logs`, `tug exec`, `tug run` (for example the `wp` CLI), `tug ps` and `tug status` go through the control plane. SSH is needed only to install and manage nodes (`tug setup`, `tug node add`); day-to-day operation goes through the control plane.
- **Config checks before deploy.** `tug lint` checks your `x-tug` config offline in milliseconds (the same schema ships as JSON Schema for [editor autocomplete and squiggles](docs/compose.md#editor-autocomplete-and-squiggles)), and a published tag is resolved to a digest on control before anything is deployed, so a typo'd tag is a deploy-time error instead of a surprise on the live server.

tug is free. Your Compose file stays a Compose file: `x-tug` is a standard Compose extension that plain Docker Compose ignores, so there is no new config format to learn or unlearn. Start with one VPS and add more when you need them. tug is built for a small number of servers and Compose applications, including Node.js, Laravel, Ruby and WordPress apps.

## Try it

Follow [Deploy your first service](docs/getting-started.md) to install tug, deploy nginx to one VPS and verify that it works. You need Node.js 22.18 or newer and Docker Compose v2 on your computer, plus SSH access to a Linux server. tug can install Docker on supported servers.

```bash
npm install -g @wpelevator/tug      # or run it with npx @wpelevator/tug

tug setup root@203.0.113.5          # install the control plane
tug node add root@203.0.113.5 --name app1  # install the agent on the same VPS
tug deploy                          # deploy a Compose file in this directory
```

The control plane and agent share the VPS with your application. Once your service is running, you can [add HTTPS](docs/networking.md#layer-b-ingress-and-tls), [back up your data](docs/backups.md) or [add another server](docs/service-placement.md).

Existing service and resource targets can be chosen interactively (try `tug logs`, `tug deploy cancel` or `tug restore run`; see [interactive CLI selection](docs/cli.md#interactive-selection)). In a terminal tug asks before it changes anything: whether to install Docker, which private address the node should use and whether it should handle ingress. It shows the plan and waits for you to confirm. `tug deploy` asks for any Compose variables, such as `${DB_PASSWORD}`, that no secret or `.env` provides. In CI or any other script nothing is ever asked, so pass the choices as flags (`--address`, `--ingress`, `--install-docker`, `-y`).

Long-running deployments, rollbacks, setup, image transfers, backups, restores and agent command waits report their current stage and elapsed time to stderr every ten seconds. Progress also works in CI and keeps JSON results separate. See [CLI progress reporting](docs/cli.md).

## How tug is different

tug moves the checks earlier: your images are built (on control, or on your machine with `--build-local`) and published tags are resolved to digests before a deployment is published, and a failed build leaves the nodes untouched. Third-party images are still pulled from their upstream registry at rollout.

- **Updates without downtime, when you opt in.** With `x-tug: { rollout: { strategy: rolling } }` the new revision starts next to the old one and ingress switches only once it is healthy. It needs ingress, a tug health check and one published port; see [rolling rollouts](docs/compose.md#rolling-rollouts). The default `recreate` restarts the container and can interrupt traffic.
- **Know what is running.** Published images are pinned to a digest, built images get an immutable tag, and every deployment records who made it. `tug status`, `tug events` and `tug ps` show what runs where and how it got there.
- **Adding a server does not change your app.** Your Compose file and `x-tug` are held as desired state on control, `tug node add` bootstraps a fresh node (installing Docker if you ask), and services placed on it get the same pinned images.
- **Choose where things run.** Pin a database and its volume to one node and spread web containers over several.
- **Works behind NAT.** Agents only dial out to control, so a node can sit behind a firewall that allows nothing inbound. tug needs no cloud provider API or overlay network.

## Not for you if

- You need Kubernetes-style scheduling, autoscaling, distributed storage, database failover, automatic rescheduling across a cluster or servers provisioned through a provider's API. See the [Docker Swarm comparison](docs/swarm-comparison.md).
- Your workloads are not Compose and Docker, or you need to roll back the host itself. `tug rollback` reverts deployments, not host packages or kernel settings.
- You run several servers with no private network between them. Management traffic works where inbound connections don't, but node-to-node service traffic needs a VPC, LAN or VPN.
- You need to hide secrets from people who can deploy. A `deploy` credential can read secret values with `exec` or through deployed code; `inspect` redacts environment values, but not a secret you put in `command` or `labels`.

## Your Compose file, plus a little `x-tug`

This example builds on the [quickstart](docs/getting-started.md). It pins the app, database and database volume to `app1`. Placement can be omitted with one node, but explicit placement keeps the database on its chosen server when you add more nodes. Enable ingress with `tug node ingress app1`, point the hostname's DNS at the VPS, and allow public ports 80 and 443. Save this as `compose.yaml` and replace the hostname with yours:

```yaml
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

See the [examples directory](examples/) for stack-specific applications and [local stack benchmarks](docs/testing.md#example-stack-benchmarks) for measured behavior of those examples. Everything `x-tug` can express is in [Compose extensions](docs/compose.md).

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
| Add a server I cannot SSH to | `tug node enroll`, then run the printed `docker run` on it |
| Manage secrets | `tug secret set`, `tug secret list`, `tug secret remove` |
| Back up now, or restore | `tug backup run`, `tug restore run <target>` |
| Give CI a deploy key | `tug credential create ci --role deploy` |
| Check everything is healthy | `tug doctor` |

Every command and option is in the [CLI reference](docs/cli.md). `tug status --json` prints raw JSON for scripts.

## Is tug right for you?

tug fits if you run Compose apps on one or a few VPSes, want deploys, rollbacks, secrets and backups handled in one tool, and are happy with a single control server that you back up. A server can host multiple apps as long as it has enough capacity; tug does not automatically balance resource usage or replace a failed server.

See [Not for you if](#not-for-you-if) for what tug deliberately leaves out. Node-to-node traffic travels over your own private network (Tailscale, a VPC, a LAN), so you own its firewalling and encryption. The goals, principles and planned milestones are in the [Roadmap](docs/roadmap.md).

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

`tug deploy` reads your Compose file on your machine and sends it to the control plane, which stores it as an immutable desired state, builds application images when needed and pins published images to digests. tug delivers its built images as archives; published images are pulled from their upstream registries. Each agent fetches the work for its node, applies it through the Docker Engine API, runs the health checks and reports back. The control plane marks the deployment done when every node reports it serving. Compose runs only on your machine for application normalization; nodes need Docker, and the control installation also uses Compose. Cross-node workload traffic uses your own private network.

Control serves mutual TLS directly on one port (`8443`). Every operator, CI job and node authenticates with a certificate from a private CA created at install, so the control address can be a bare IP and can change later. Do not terminate TLS in front of it. A `controlUrl` in `tug.yml` tells the CLI where control is (see [CLI configuration](docs/cli.md#config-file)). [Architecture](docs/architecture.md) covers every flow in detail, and [Security](docs/security.md) the trust boundaries.

## Documentation

Start with the [single-VPS tutorial](docs/getting-started.md), then choose the topic that matches your next task:

- **Deploy and operate**
  - [Application examples](examples/README.md)
  - [Health checks and rollouts](docs/healthchecks.md)
  - [Troubleshooting](docs/troubleshooting.md)
- **Networking and access**
  - [Hostnames, HTTPS and service networking](docs/networking.md)
  - [Credentials and CI](docs/access-control.md)
  - [Security trust boundaries](docs/security.md)
- **Servers and data**
  - [Service placement and scaling](docs/service-placement.md)
  - [Node management](docs/nodes.md)
  - [Backups and recovery](docs/backups.md)
  - [Moving to new servers](docs/migration.md)
- **Reference**
  - [CLI](docs/cli.md)
  - [Compose extensions](docs/compose.md)
  - [Configuration](docs/configuration.md)
  - [Control plane](docs/control-plane.md)
- **Contribute and design**
  - [Development](docs/development.md)
  - [Testing](docs/testing.md)
  - [Releases](docs/releases.md)
  - [Architecture](docs/architecture.md)
  - [Roadmap](docs/roadmap.md)
  - [Observability status and proposal](docs/observability.md)
  - [Capabilities proposal](docs/capabilities.md)
  - [Consoles and agent-built control planes (proposal)](docs/consoles.md)
  - [Terminology](docs/terminology.md)
  - [Standalone binary (prototype)](docs/standalone-binary.md)
  - [Docker Swarm comparison](docs/swarm-comparison.md)
  - [Podman and other container engines (proposal)](docs/container-engines.md)

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details. Database code uses direct SQLite queries; [SQLite storage](docs/architecture.md#sqlite-storage) describes query boundaries and synchronous transactions.
