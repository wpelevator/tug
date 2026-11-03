# Tug

Deploy Docker Compose apps to a few ordinary Linux servers, from your laptop or CI, without Kubernetes or a hosted platform.

You keep your `docker-compose.yml`. Tug installs a small control plane on one server and an agent on each of the others, then `tug deploy` puts your services where you say, waits until they are healthy and rolls back if they are not. It is built for running one to a few dozen sites, WordPress first, on two to ten VPSes, with backups and restores included.

## What you can do with it

- **Deploy a Compose file to your servers.** `tug deploy` builds or pulls your images, starts them on the right nodes, waits for health checks and tells you why if something fails. `tug rollback` returns to the previous version, and `x-tug: { rollback: auto }` does it for you.
- **Choose where things run.** Pin a database and its volume to one node, spread web containers over several, and let Tug's managed Caddy ingress serve them over HTTPS with certificates it obtains for you.
- **Update without downtime.** Opt-in rolling rollouts start the new version, wait until it is healthy and only then switch traffic.
- **Keep secrets out of your repository.** `tug secret set DB_PASSWORD` stores them encrypted and sends each one only to the nodes whose services use it.
- **Back up and restore.** Scheduled backups of databases and volumes to S3-compatible storage with restic, and `tug restore run db` to bring one back.
- **Look inside running services.** `tug logs`, `tug exec`, `tug run` (for example `wp` CLI), `tug ps` and `tug status` work through the control plane, so you never SSH to a node to see what is going on.
- **Give CI a limited key.** `tug credential create` makes read-only, deploy-only or admin credentials, and every change records who made it.

Nodes only dial out to the control plane, so they work behind NAT or a firewall that allows nothing inbound. Tug does not need a cloud provider's API, a registry or an overlay network.

## Try it

You need Node.js 22.18 or newer and Docker Compose v2 on your machine, and SSH access to one or more Linux servers (Debian, Ubuntu, Fedora or a RHEL-compatible distribution). Tug can install Docker on them for you.

```bash
npm install -g @wpelevator/tug      # or run it with npx @wpelevator/tug

tug setup root@203.0.113.5          # install the control plane on a server
tug node add root@198.51.100.7      # add a server that will run your apps
tug deploy                          # deploy ./docker-compose.yml
```

In a terminal Tug asks before it changes anything: whether to install Docker, which private address the node should use and whether it should handle ingress. It shows the plan and waits for you to confirm. `tug deploy` asks for any Compose variables, such as `${DB_PASSWORD}`, that no secret or `.env` provides. In CI or any other script nothing is ever asked, so pass the choices as flags (`--address`, `--ingress`, `--install-docker`, `-y`).

## Your Compose file, plus a little `x-tug`

A normal Compose file already works. Add `x-tug` to say where services run, how to tell they are healthy and where traffic comes in:

```yaml
services:
  db:
    image: mariadb:11.4.8
    volumes: [db-data:/var/lib/mysql]
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    x-tug:
      placement: { nodes: [app1] }
      health: { type: tcp, port: 3306 }

  wordpress:
    image: wordpress:6.8.3-apache
    depends_on: [db]
    x-tug:
      placement: { nodes: [app1] }
      health: { type: http, port: 80, path: /wp-includes/version.php }
      ingress: { host: blog.example.com, port: 80, tls: auto }

volumes:
  db-data:
    x-tug: { placement: { nodes: [app1] } }
```

```bash
tug secret set DB_ROOT_PASSWORD
tug deploy
tug status       # what is running where, and anything failing
tug logs wordpress --follow
```

A complete WordPress site with scheduled database and uploads backups is in the [WordPress example](examples/wordpress/README.md). Everything `x-tug` can express is in [Compose extensions](docs/compose.md).

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

Tug fits if you run a handful of Compose apps on VPSes you already pay for, want deploys, rollbacks, secrets and backups handled in one tool, and are happy with a single control server that you back up.

It deliberately does not do Kubernetes-style scheduling, autoscaling, distributed storage or database failover, and it does not provision servers through a provider's API. Node-to-node traffic travels over your own private network (Tailscale, a VPC, a LAN), so you own its firewalling and encryption. If you want automatic rescheduling of containers across a cluster, see how it compares with [Docker Swarm](docs/swarm-comparison.md). The goals, principles and planned milestones are in the [Roadmap](docs/roadmap.md).

## How it works

```text
  tug CLI / CI (operator credential)
       |
       |  mTLS: deploy, status, logs, exec
       v
+-------------------------------------+
| Control plane (one mTLS port)       |
|   Control API (role-checked)        |
|   SQLite: desired states, secrets   |
|   private CA, image builds          |
+-------------------------------------+
       ^                       ^
       |  agents dial out: work, status,
       |  WebSocket wake and live sessions
       |                       |
+------+------------+   +------+------------------+
| Node app1         |   | Node app2 (ingress node)|
|   Agent           |   |   Agent                 |
|   Docker Engine   |   |   Docker Engine         |
|   services        |   |   services              |
|                   |   |   managed Caddy ingress |
+-------------------+   +-------------------------+
        \_________________________/
          workload traffic between node addresses
          over the operator's private network

  SSH is used only by the CLI to install the control plane and nodes.
```

`tug deploy` reads your Compose file on your machine and sends it to the control plane, which stores it as an immutable desired state, builds any images and pins published images to digests. Each agent fetches the work for its node, applies it through the Docker Engine API, runs the health checks and reports back. The control plane marks the deployment done when every node reports it serving. Compose runs only on your machine; nodes need just Docker.

Control serves mutual TLS directly on one port (`8443`). Every operator, CI job and node authenticates with a certificate from a private CA created at install, so the control address can be a bare IP and can change later. Do not terminate TLS in front of it. A `controlUrl` in `tug.yml` tells the CLI where control is (see [CLI configuration](docs/cli.md#config-file)). [Architecture](docs/architecture.md) covers every flow in detail, and [Security](docs/security.md) the trust boundaries.

The full walkthrough, including CI credentials, moving the control plane and recovery, is in [Getting started](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md): install control, add nodes, deploy, give CI a credential, move control, recover.
- [Terminology](docs/terminology.md): core concepts, the naming review (which recommendations are implemented), industry comparisons and the remaining proposed interface improvements.
- [Architecture](docs/architecture.md): components, reconciliation, workflow diagrams, secrets and runtime paths.
- [Compose extensions](docs/compose.md): `x-tug` placement, health checks, volumes and limitations.
- [Control plane](docs/control-plane.md): install, mutual TLS and the private CA, image delivery, control-plane backup and recovery on another host.
- [Backups](docs/backups.md): scheduled workload backups with `x-tug.backup` (restic), restore, recipes for common databases, and a restore drill. See also the [WordPress example](examples/wordpress/README.md).
- [Access control](docs/access-control.md): certificate identity classes, scoped operator credentials, roles, audit trail and a GitHub Actions deploy example.
- [Security](docs/security.md): deployment trust boundaries, security audit findings and validation limits.
- [Networking](docs/networking.md): bring-your-own private networking, cross-node service names, ingress and TLS, firewall notes.
- [Nodes](docs/nodes.md): node names and IDs, SSH install, self-service enrollment, certificate renewal and recovery, registration and status.
- [CLI reference](docs/cli.md): every `tug` command and option.
- [Configuration](docs/configuration.md): CLI, control and agent environment variables.
- [Development](docs/development.md): local setup, CI, Compose stack, host mode and the integration test.
- [Testing](docs/testing.md): test layers, rollout metrics, mocked test backlog, and the [Caddy/PHP and static-file benchmark](docs/testing.md#caddy-proxy-overhead-benchmark).
- [Observability](docs/observability.md): what can be observed today, and the proposed logs, metrics and alerting.
- [Releases](docs/releases.md): changesets, npm and Docker image publishing.
- [Standalone binary](docs/standalone-binary.md): proposed Bun-compiled CLI binaries and Homebrew distribution, with the mTLS dependency findings.
- [Roadmap](docs/roadmap.md): goals, principles, the reference WordPress topology and planned milestones.
- [Docker Swarm comparison](docs/swarm-comparison.md): overlapping capabilities, workflow advantages, scheduling and networking limits, failure behavior and workload fit.

## Development

```bash
npm install
npm test
npm run lint
npm run test:integration
```

See [Development](docs/development.md) for details.
