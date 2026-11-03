# Tug

Deploy Docker Compose apps to your own Linux VPS, from your laptop or CI, without Kubernetes or a hosted platform.

A VPS is a durable computer with enough resources to host multiple sites or a medium-size application and its database. Tug helps you use that capacity: keep your Compose file, deploy with one command, and manage rollouts, secrets, backups and restores. Start with one server and add more when you need them. Tug is built for a small number of servers and Compose applications, including Node.js, Laravel, Ruby and WordPress apps.

Tug runs a small control plane and an agent, which can share the same VPS with your applications. It builds application images on the control server or your machine and delivers them to your nodes, so you do not need to run or configure an image registry for those builds. Published images are still pulled from their upstream registries.

## What you can do with it

- **Deploy a Compose file to your servers.** `tug deploy` builds or pulls your images, starts them on the right nodes, waits for health checks and tells you why if something fails. `tug rollback` returns to the previous version, and `x-tug: { rollback: auto }` does it for you.
- **Choose where things run.** Pin a database and its volume to one node, spread web containers over several, and let Tug's managed Caddy ingress serve them over HTTPS with certificates it obtains for you.
- **Update without downtime.** Opt-in rolling rollouts start the new version, wait until it is healthy and only then switch traffic.
- **Keep secrets out of your repository.** `tug secret set DB_PASSWORD` stores them encrypted and sends each one only to the nodes whose services use it.
- **Back up and restore.** Scheduled backups of databases and volumes to S3-compatible storage with restic, and `tug restore run db` to bring one back.
- **Look inside running services.** `tug logs`, `tug exec`, `tug run` (for example `wp` CLI), `tug ps` and `tug status` work through the control plane, so you never SSH to a node to see what is going on.
- **Give CI a limited key.** `tug credential create` makes read-only, deploy-only or admin credentials, and every change records who made it.

Agents only dial out to the control plane, so nodes can work behind NAT or a firewall that allows nothing inbound. Tug does not need a cloud provider's API or an overlay network.

## Try it

Follow [Deploy your first service](docs/getting-started.md) to install Tug, deploy nginx to one VPS and verify that it works. You need Node.js 22.18 or newer and Docker Compose v2 on your computer, plus SSH access to a Linux server. Tug can install Docker on supported servers.

```bash
npm install -g @wpelevator/tug      # or run it with npx @wpelevator/tug

tug setup root@203.0.113.5          # install the control plane
tug node add root@203.0.113.5 --name app1  # install the agent on the same VPS
tug deploy                          # deploy a Compose file in this directory
```

The control plane and agent share the VPS with your application. Once your service is running, you can [add HTTPS](docs/networking.md#layer-b-ingress-and-tls), [back up your data](docs/backups.md) or [add another server](docs/service-placement.md).

In a terminal Tug asks before it changes anything: whether to install Docker, which private address the node should use and whether it should handle ingress. It shows the plan and waits for you to confirm. `tug deploy` asks for any Compose variables, such as `${DB_PASSWORD}`, that no secret or `.env` provides. In CI or any other script nothing is ever asked, so pass the choices as flags (`--address`, `--ingress`, `--install-docker`, `-y`).

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

## Is Tug right for you?

Tug fits if you run Compose apps on one or a few VPSes, want deploys, rollbacks, secrets and backups handled in one tool, and are happy with a single control server that you back up. A server can host multiple apps as long as it has enough capacity; Tug does not automatically balance resource usage or replace a failed server.

It deliberately does not do Kubernetes-style scheduling, autoscaling, distributed storage or database failover, and it does not provision servers through a provider's API. Node-to-node traffic travels over your own private network (Tailscale, a VPC, a LAN), so you own its firewalling and encryption. If you want automatic rescheduling of containers across a cluster, see how it compares with [Docker Swarm](docs/swarm-comparison.md). The goals, principles and planned milestones are in the [Roadmap](docs/roadmap.md).

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

`tug deploy` reads your Compose file on your machine and sends it to the control plane, which stores it as an immutable desired state, builds application images when needed and pins published images to digests. Tug delivers its built images as archives; published images are pulled from their upstream registries. Each agent fetches the work for its node, applies it through the Docker Engine API, runs the health checks and reports back. The control plane marks the deployment done when every node reports it serving. Compose runs only on your machine for application normalization; nodes need Docker, and the control installation also uses Compose. Cross-node workload traffic uses your own private network.

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
  - [Terminology](docs/terminology.md)
  - [Standalone binary proposal](docs/standalone-binary.md)
  - [Docker Swarm comparison](docs/swarm-comparison.md)

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details. Database code uses direct SQLite queries; [SQLite storage](docs/architecture.md#sqlite-storage) describes query boundaries and synchronous transactions.
