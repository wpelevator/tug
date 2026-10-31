# Real-host evaluation, 31 October 2026

Two WordPress sites on the existing test hosts, using the current CLI against the control plane already running there. This is an operator trial, not a passing CI job. The roadmap's WordPress picture was the target. What the tool can deploy today is a smaller thing, and the gap shows up as soon as you follow a normal Compose file.

## Result

Both sites are installed and serving over public HTTPS.

This document preserves what the installed `m4-amd64` hosts did during the trial. Since then, current `main` has made `tug deploy` include the node's apply error, made `doctor --node` wait for its queued result, kept lifecycle events quiet after the first change, and added an outbound agent wake channel so deployments and queued commands do not normally wait for the next periodic poll. The remaining findings are still open unless a paragraph says otherwise.

| Site | URL | Node | Host | Cert |
|---|---|---|---|---|
| Press A | https://a.178.128.250.108.sslip.io | `app` | 142.93.140.20 | Let's Encrypt, CN=YE1, through 29 Jan 2027 |
| Press B | https://b.178.128.250.108.sslip.io | `edge` | 178.128.250.108 | Let's Encrypt, CN=YE2, through 29 Jan 2027 |

Each site is `wordpress:6.8-apache` plus `mariadb:11.4` on the same node, with a persistent volume for `/var/www/html` and another for `/var/lib/mysql`. Ingress is the managed Caddy on `edge`. HTTP returns 308 to HTTPS. The homepages return 200 with the site title. The admin user is `editor`. The password is only in `/tmp/tug-wp-eval/credentials.txt` on the operator machine, mode `0600`, and is not in this repo.

The second `wp1` deploy, images already pulled, reached `succeeded` in 20 seconds. `wp2`, including the image pull onto the other host, took 57 seconds. After both were up, `app` had 263 MB available of 961 MB and `edge` had 331 MB. MariaDB RSS was 85 MB and 116 MB only because the compose file sets `--innodb-buffer-pool-size=48M`. WordPress RSS was about 120 MB on each host.

This did not exercise the original specification's topology (plan.md, since removed in favor of the roadmap's [reference topology](roadmap.md#reference-topology)): three PHP-FPM nodes, a front node speaking FastCGI, a separate database node, Memcached, and an NFS docroot. Those needed M6 and M7, which have since been implemented but not validated on real hosts. With two 1 GB hosts, that layout would not fit even if the fields existed.

## What I followed, and what I actually did

The README quick start says install control over SSH, `tug init` against an HTTPS URL, set a secret, `node-install`, deploy, then use `status`, `events`, `logs`, `restart` and `doctor`. The hosts were already past install. Control is bound to `10.110.0.3:8080`, not the public address. Port 8080 on `142.93.140.20` refuses connections. The working operator path is an SSH tunnel to `127.0.0.1:18082` and a config file outside the repo (`/tmp/tug-real-m4/config.json`, project still set to `realcheck`). That tunnel pattern is one example buried in the CLI and nodes docs. It is not the quick start.

The agents are `tug:m4-amd64`, not `ghcr.io/wpelevator/tug:0.2.0`. `tug doctor` on the laptop reports Docker Compose v5.6.1. The same command's control check reports v2.32.4, which is the plugin inside the runtime image. `tug status` does not show the image tag or the CLI version the node is running. An operator comparing those two Compose versions will think the install is inconsistent. It is, but status will not say so.

I did not reinstall from the published image. The cluster was already serving, and a rebuild would have tested the installer again rather than the application path. The version skew is still invisible.

## What worked

- Two projects on one ingress node. Caddy picked up `a.178.128.250.108.sslip.io` and `b.178.128.250.108.sslip.io` without dropping the existing `178.128.250.108.sslip.io` route.
- Certificates issued with `TUG_ACME_EMAIL` unset. DNS for `*.178.128.250.108.sslip.io` is the whole trick, and it is not mentioned in the docs.
- `secret-set` from stdin, before the project row existed. Values stayed out of argv. `secret-list` shows names and versions only.
- Placement, persistent volume records, and `volume-list` naming the node.
- Health checks: TCP to MariaDB, HTTP to WordPress. Once the compose file was one Compose would accept, both deploys converged without raising the 300 second default timeout.
- Binding the app port to the overlay address on `app` (`10.210.0.1:8080:80`) and to `127.0.0.1:8080:80` on `edge` kept port 8080 off the public interfaces. Caddy still reached both sites.

## Failures and friction

### The first deploy failed, and the CLI hid the reason

The first compose file used the dependency every WordPress example uses:

```yaml
depends_on:
  db:
    condition: service_healthy
```

MariaDB 11.4 has no Docker `HEALTHCHECK`. `x-tug.health` is not one either. Tug strips `x-tug` before writing the node compose file, then runs `docker compose up`. Compose refused to start WordPress:

```text
dependency failed to start: container wp1-db-1 has no healthcheck configured
```

`tug deploy` printed `deployment dep_73508669cffa774f failed: one or more assigned nodes reported failed health` and exited in 50 seconds. That is shorter than the health retries in the file, so it was not a timeout. `tug events --project wp1` showed `service.pulling` and `service.starting`, then nothing about the failure. `tug logs wordpress` printed nothing, because the container was still `Created`. `tug logs db` showed MariaDB ready for connections, which sends you looking at WordPress. The compose error exists only inside the `status_json` string on the node status row. I got it by SSH, then by parsing `tug status`.

Both visibility gaps are closed on current `main` and not on these hosts. [PR #13](https://github.com/wpelevator/tug/pull/13) emits one `service.failed` event with the apply error, and retries of the same failure stay quiet. [PR #17](https://github.com/wpelevator/tug/pull/17) also includes the reporting node's apply or rollout error in the deployment failure that `tug deploy` prints.

A plain `depends_on: [db]` worked. The WordPress image already waits for the database. The docs say `depends_on` is a hint and that readiness comes from `x-tug.health`. They do not say that `condition: service_healthy` fails the deploy, or that you must add a Docker `healthcheck:` block yourself if you want Compose to wait.

### JSON is the interface

`tug deploy` on success prints the deployment row and the full desired state, including the compose file. The word `succeeded` is a field you scroll to. There is no human summary and no `--quiet`. The docs say there is no global `--json` because JSON is already the default. That is honest, and it is also why a failed deploy is hard to read: the one string a person needs is not in the error line.

`tug status` returns database rows. Health is a snake_case column plus a stringified JSON blob (`status_json`) that holds the camelCase agent report. Finding out that `wp1` is serving means parsing a string inside a string. CLI docs say new structured results use camelCase and that unchanged API responses may keep database names. Status is the command an operator runs first, and it is the unchanged dump.

`doctor --node edge` returned `"ok": true` and a command id. It does not wait. `restart` and `node-rotate-wg-key` do. The command description says "run" diagnostics. The nodes doc says "queues". Both are true, and the result never comes back to the terminal.

### The config project is a trap

The tunnel config's `project` is `realcheck`. `tug logs wordpress`, without `--project`, posted to that project and returned `404 {"error":"service not found"}`, then told me to run `--help`. It did not say which project it used. `events` is project-scoped the same way. `status` is control-wide. After `init`, every later command inherits whatever project you set, and the error looks like a missing service.

### Ingress bind addresses are insider knowledge

Caddy dials `127.0.0.1` for a service on the ingress node and the overlay address for any other node (`src/ingress.ts`). A published port of `8080:80` listens on `0.0.0.0`, so the app is also on the public IP, next to Caddy, with no TLS. Binding the overlay IP on the app node and `127.0.0.1` on the edge node is what makes the ingress work without that exposure. The networking doc says the edge uses the published host port. It does not say which address that port has to be on, or that the overlay IP is something you have to look up and paste into the compose file. If the node is re-registered and gets a new overlay address, the compose file is wrong and nothing in `tug deploy` will say so before Compose tries the bind.

### Service DNS does not get you a remote database

Names injected with `extra_hosts` point at the node address, and the client must use the published host port. A MariaDB that is not published is reachable only on the Compose network, which means the same node. Publishing `3306` so WordPress on the other node can use the name puts the database on an address the mesh can route to. Binding it to the overlay IP only is the same undocumented trick as the app port. The generated `wp2` compose file had no `extra_hosts`, which is correct: both of its services are on `edge`.

So the deployable WordPress shape is app and database on one node, one project per site. The original specification's shape, app nodes talking to a database node over a service name, is not the shape this tool deploys. Copying that example fails for more than missing nodes. It uses `domains`, `upstream`, `upstreamProtocol`, `sticky`, and `type: shared` / `driver: nfs`. Current validation accepts `placement`, `replicas` (must equal the node count), `health`, `ingress`, and `rollout`. The rest is either ignored or not implemented. At the time of this evaluation M6 (label placement, `replicas: N` spread) and M7 (NFS docroot) were not built; both are implemented now but unvalidated on real hosts. Ingress is an HTTP reverse proxy, not FastCGI.

Rolling the WordPress container would be the wrong next step. A rolling revision publishes a different host port and shares the named volume with the old revision. Two PHP processes on one `wp-content` is how you corrupt uploads. The rollout docs say volumes are shared and that databases should stay on `recreate`. They do not say that about a PHP docroot. I left both sites on recreate.

### Secrets and environment are easy to get half-right

A value that is not exactly `${NAME}` makes Tug treat the environment key as a secret name. `WORDPRESS_DB_HOST: db` does not require a secret, and the literal is what the container gets. A project secret with that same name would also be released to the node and written into `.env`. The `.env` writer does not quote values. A password containing `#`, `$`, a space, or a newline breaks interpolation. Nothing in the secrets section says "use a substitution for the password, a literal for the hostname, and keep the password free of compose metacharacters." I used hex passwords because I had read `writeEnv`, not because the docs told me to.

### Steady state is still a health check every poll

`reconcile` runs `docker compose up -d` and the health checks on every poll, not only when the desired version changes. After `wp1` was already `serving`, the WordPress access log still showed user-agent `node`, from `172.20.0.1`, requesting `/` and following the 302 to `/wp-admin/install.php` about every 9 seconds. Node's fetch follows redirects. The docs mention that. They do not mention that a redirect to the public hostname would send the health check out through Caddy and back, or that the checker keeps doing it after the deploy has succeeded. For this site the installer returned 200, so the check passed. A redirect to a non-2xx URL would flap a healthy site.

On the image these hosts are running, those polls also wrote `service.pulling`, `starting`, `health_checking` and `serving` every time. [PR #13](https://github.com/wpelevator/tug/pull/13), merged after this trial, stops that. The agent keeps a fingerprint and emits lifecycle events only when the revision, rendered compose or secrets change. The apply and the health check still run on every poll, which the new observability page states on purpose. The access-log noise is not fixed. The event flood is, once these agents are replaced.

### What I still had to do by SSH

M5 (`exec`, `logs -f`, `ps`) is the stated next milestone, and this run needed it on the first failure. Completing the WordPress install was a POST to `install.php` from the laptop, which is fine. Finding out why the container never started was not. Current `main` now puts the last apply error in the deployment failure and waits for `doctor --node`, but it still has no live shell or log stream.

`volume-list` records the volume and the node. It does not show whether the Docker volume exists or how large it is. I did not test `volume-remove`. I also did not re-run rolling deploys, rollback, or `--build-local` on these sites. Those already passed on the nginx fixture. They are not what a WordPress install hits first.

## Documentation

The pages disagree with the path that works.

- The README's steps 1 and 2 assume a public HTTPS control URL. This cluster's API is HTTP on a VPC address, on purpose. The quick start should show the tunnel, and it should say that `control-install` publishes `PORT:8080` on all interfaces unless you change the rendered compose. The bind to `10.110.0.3` is not a documented flag.
- There is no compose example with a database, a secret, a volume, and an ingress host. The samples are nginx, busybox, and redis, placed on `vps-a`, `vps-b`, and `vps-c`. These nodes are named `app` and `edge`. A person copying the sample will fail placement and learn nothing about `depends_on` or TLS.
- `sslip.io` is how both real-host runs got a trusted certificate without owning a domain. It belongs in the networking page next to `tls: auto`, including the rate-limit warning: sslip.io is one registered domain, and Let's Encrypt's per-domain cap is shared with everyone else using it. Two hostnames worked today. A third batch might not.
- Preflight checks free disk (2048 MB under `/var/lib` for control, 1024 MB for a node) and never checks RAM. Both hosts have 1 GB and no swap. An unmodified MariaDB on the control host, next to the agent and the control container, is a bad idea. The control-plane page says the control VPS is not in the request path. It does not say not to put a database on that same 1 GB machine. This cluster does, because there are only two machines.
- plan.md is still the "original specification" linked from the README, and its WordPress compose file is not a file this CLI accepts. The roadmap already says M6 and M7 serve that topology. The README does not. Someone who starts at the README and opens plan.md will try to deploy it. Resolved since: plan.md was removed and the [roadmap](roadmap.md#reference-topology) now holds the reference topology.

## What I would change first

1. Add one worked example: WordPress or any HTTP app plus a database, secrets via `${DB_PASSWORD}`, `depends_on` without `service_healthy`, ingress on an sslip.io name, and a note on the 1 GB MariaDB flag. State that app and database have to share a node until a published port or M7 exists.
2. Make `tug deploy` print one line on success (`wp1 wp1-2 succeeded, 2 services`) and keep the JSON behind a flag. Same for `status`: project, version, health, node, without a nested string.
3. Name the selected project in "service not found" errors.
4. Stop publishing application ports on `0.0.0.0` by default when an ingress is set. Bind the overlay address, or `127.0.0.1` on the ingress node, in the generated file. The operator should not have to paste `10.210.0.1` into the source compose.
5. Say in the README that the plan.md WordPress stack is not deployable yet, and point at the example that is. (Done differently: plan.md was removed and the roadmap describes the topology Tug targets.)

I would not treat this run as evidence for rolling deploys, image build, or rollback. Those were not on this path. I would treat it as evidence that a person can get two real sites up, and that the first failure still requires SSH.


## M6, M7 and enrollment on fresh hosts

31 October 2026, on the same two Ubuntu 24.04 droplets (1 vCPU, 1 GB, amd64, a shared VPC), after wiping both: containers, volumes, images, `wg0` and all Tug state. Control ran on 142.93.140.20 with `TUG_MESH=true`. The Tug image was built for amd64 from the branch and loaded with `docker save`.

| Check | Result |
|---|---|
| `node-install --mesh --label ...` on two hosts (`a`: `app`,`storage`; `b`: `app`) | Both online with labels; WireGuard mesh up |
| `global: true` + `placement.labels: [app]` | One `web` replica on each labelled node |
| `replicas: 1` + labels | One `worker`, on the alphabetically first matching node |
| `tug scale worker 2` / `1` | Second replica started on `b`, then removed; `0` and unknown services rejected |
| NFS volume (`x-tug.type: nfs`, exporter `a`) | `b` mounted `10.210.0.1:/srv/tug/shared` over the WireGuard overlay (NFSv3); a file written on `b` appeared on `a`; the exporter bind-mounted the directory |
| `ps`, `inspect`, `exec`, `logs -f` against real nodes | Worked |
| `node-enroll --install-docker --mesh` cloud-config on a host with Docker purged | Docker Engine and Compose installed, agent started, node enrolled with its label |
| Enrolled node with no public address behind `ufw` deny-incoming | WireGuard handshake and overlay ping to `a` worked; NFS mount worked |

What this does not prove: the cloud-config was applied by re-running cloud-init (`cloud-init clean`, then its stages) with the config in `cloud.cfg.d`, not from first-boot user data, and the agent image came through an SSH-tunnelled throwaway registry. The firewalled node has a public IP, so this is not NAT. Debian, Fedora and Rocky bootstraps, arm64, and certificate renewal were not run.

### Findings

- **Fixed: dead nodes held rollouts open.** After `b`'s host was repurposed as `c`, the old `b` stayed registered with its labels. The next deploy placed `global` replicas on `b`, which never answered, and the deployment stayed `rolling_out` until cancelled. Label and `global` placement, and `tug scale`, now skip nodes not seen within `TUG_STALE_SECONDS`. `scale` also no longer spreads a labelled service onto nodes that do not match its labels when none match.
- **Fixed: there was no way to remove a node.** `tug node-remove <node>` now deletes it (refused while a current deployment places something on it, or while its agent still reports, unless `--force`). Run on the hosts: removing the dead `b` succeeded and `a`'s WireGuard peer for it was dropped, while removing `a` was refused with the services placed on it.
- **Fixed: `control-install` could not enable the mesh.** `TUG_MESH` had to be added to the generated compose file by hand; `control-install --mesh` now does it (unit-tested only).
- **Open: NFS needs host preparation Tug does not do.** The exporter needs an NFS server and `/etc/exports`; consumers need `nfs-common`.
- **Open: `cloud-init clean` regenerates SSH host keys.** Expected, but it makes the next SSH to the host fail strict checking.
