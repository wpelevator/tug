# Real-host evaluation, 31 October 2026

Two WordPress sites on the existing test hosts, using the current CLI against the control plane already running there. This is an operator trial, not a passing CI job. The roadmap's WordPress picture was the target. What the tool can deploy today is a smaller thing, and the gap shows up as soon as you follow a normal Compose file.

## Result

Both sites are installed and serving over public HTTPS.

**Version context.** The trial ran on the earlier runtime. Its control API was plain HTTP on port 8080 with bearer tokens, `/healthz` was unauthenticated, agents applied each project by running `docker compose up` on the node, and cross-node names were called service DNS. The current implementation differs: control serves a single mutual-TLS port (`8443`) with certificates from its own CA and no unauthenticated route, agents use the Docker Engine API with no Compose plugin on nodes, and the feature is called cross-node service names (hosts-file entries). Statements below about HTTP, port 8080, tokens, Compose behavior and `/healthz` describe the trial hosts, not the current product; [Control plane](control-plane.md), [Nodes](nodes.md) and [Architecture](architecture.md) describe the current one. All references to WireGuard, mesh membership, overlay addresses, `--mesh`, `TUG_MESH` and `node-rotate-wg-key` likewise describe the removed tug-owned mesh implementation, retained only as historical evidence; they are not current capabilities or tests that still apply. Findings are kept as evidence, not rewritten.

This document preserves what the installed `m4-amd64` hosts did during the trial. Since then, current `main` has made `tug deploy` include the node's apply error, made `doctor --node` wait for its queued result, kept lifecycle events quiet after the first change, and added an outbound agent wake channel so deployments and queued commands do not normally wait for the next periodic poll. The remaining findings are still open unless a paragraph says otherwise.

| Site | URL | Node | Host | Cert |
|---|---|---|---|---|
| Press A | https://a.178.128.250.108.sslip.io | `app` | 142.93.140.20 | Let's Encrypt, CN=YE1, through 29 Jan 2027 |
| Press B | https://b.178.128.250.108.sslip.io | `edge` | 178.128.250.108 | Let's Encrypt, CN=YE2, through 29 Jan 2027 |

Each site is `wordpress:6.8-apache` plus `mariadb:11.4` on the same node, with a persistent volume for `/var/www/html` and another for `/var/lib/mysql`. Ingress is the managed Caddy on `edge`. HTTP returns 308 to HTTPS. The homepages return 200 with the site title. The admin user is `editor`. The password is only in `/tmp/tug-wp-eval/credentials.txt` on the operator machine, mode `0600`, and is not in this repo.

The second `wp1` deploy, images already pulled, reached `succeeded` in 20 seconds. `wp2`, including the image pull onto the other host, took 57 seconds. After both were up, `app` had 263 MB available of 961 MB and `edge` had 331 MB. MariaDB RSS was 85 MB and 116 MB only because the compose file sets `--innodb-buffer-pool-size=48M`. WordPress RSS was about 120 MB on each host.

This did not exercise the original specification's topology (plan.md, since removed in favor of the roadmap's [reference topology](roadmap.md#reference-topology)): three PHP-FPM nodes, a front node speaking FastCGI, a separate database node, Memcached, and an NFS docroot. Those needed M6 and M7, which have since been implemented but not validated on real hosts. With two 1 GB hosts, that layout would not fit even if the fields existed.

## What I followed, and what I actually did

The README quick start says install control over SSH, `tug init` against an HTTPS URL, set a secret, `node add`, deploy, then use `status`, `events`, `logs`, `restart` and `doctor`. The hosts were already past install. Control is bound to `10.110.0.3:8080`, not the public address. Port 8080 on `142.93.140.20` refuses connections. The working operator path is an SSH tunnel to `127.0.0.1:18082` and a config file outside the repo (`/tmp/tug-real-m4/config.json`, project still set to `realcheck`). That tunnel pattern is one example buried in the CLI and nodes docs. It is not the quick start.

The agents are `tug:m4-amd64`, not `ghcr.io/wpelevator/tug:0.2.0`. `tug doctor` on the laptop reports Docker Compose v5.6.1. The same command's control check reports v2.32.4, which is the plugin inside the runtime image. `tug status` does not show the image tag or the CLI version the node is running. An operator comparing those two Compose versions will think the install is inconsistent. It is, but status will not say so.

I did not reinstall from the published image. The cluster was already serving, and a rebuild would have tested the installer again rather than the application path. The version skew is still invisible.

## What worked

- Two projects on one ingress node. Caddy picked up `a.178.128.250.108.sslip.io` and `b.178.128.250.108.sslip.io` without dropping the existing `178.128.250.108.sslip.io` route.
- Certificates issued with `TUG_ACME_EMAIL` unset. DNS for `*.178.128.250.108.sslip.io` is the whole trick, and it is not mentioned in the docs.
- `secret set` from stdin, before the project row existed. Values stayed out of argv. `secret list` shows names and versions only.
- Placement, persistent volume records, and `volume list` naming the node.
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

MariaDB 11.4 has no Docker `HEALTHCHECK`. `x-tug.health` is not one either. tug strips `x-tug` before writing the node compose file, then runs `docker compose up`. Compose refused to start WordPress:

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

### Cross-node service names (then called service DNS) do not get you a remote database

Names injected with `extra_hosts` point at the node address, and the client must use the published host port. A MariaDB that is not published is reachable only on the Compose network, which means the same node. Publishing `3306` so WordPress on the other node can use the name puts the database on an address the mesh can route to. Binding it to the overlay IP only is the same undocumented trick as the app port. The generated `wp2` compose file had no `extra_hosts`, which is correct: both of its services are on `edge`.

So the deployable WordPress shape is app and database on one node, one project per site. The original specification's shape, app nodes talking to a database node over a service name, is not the shape this tool deploys. Copying that example fails for more than missing nodes. It uses `domains`, `upstream`, `upstreamProtocol`, `sticky`, and `type: shared` / `driver: nfs`. Current validation accepts `placement`, `replicas` (must equal the node count), `health`, `ingress`, and `rollout`. The rest is either ignored or not implemented. At the time of this evaluation M6 (label placement, `replicas: N` spread) and M7 (NFS docroot) were not built; both are implemented now but unvalidated on real hosts. Ingress is an HTTP reverse proxy, not FastCGI.

Rolling the WordPress container would be the wrong next step. A rolling revision publishes a different host port and shares the named volume with the old revision. Two PHP processes on one `wp-content` is how you corrupt uploads. The rollout docs say volumes are shared and that databases should stay on `recreate`. They do not say that about a PHP docroot. I left both sites on recreate.

### Secrets and environment are easy to get half-right

A value that is not exactly `${NAME}` makes tug treat the environment key as a secret name. `WORDPRESS_DB_HOST: db` does not require a secret, and the literal is what the container gets. A project secret with that same name would also be released to the node and written into `.env`. The `.env` writer does not quote values. A password containing `#`, `$`, a space, or a newline breaks interpolation. Nothing in the secrets section says "use a substitution for the password, a literal for the hostname, and keep the password free of compose metacharacters." I used hex passwords because I had read `writeEnv`, not because the docs told me to.

### Steady state is still a health check every poll

`reconcile` compares container config hashes and runs the health checks on every poll, not only when the desired version changes. After `wp1` was already `serving`, the WordPress access log still showed user-agent `node`, from `172.20.0.1`, requesting `/` and following the 302 to `/wp-admin/install.php` about every 9 seconds. Node's fetch follows redirects. The docs mention that. They do not mention that a redirect to the public hostname would send the health check out through Caddy and back, or that the checker keeps doing it after the deploy has succeeded. For this site the installer returned 200, so the check passed. A redirect to a non-2xx URL would flap a healthy site.

On the image these hosts are running, those polls also wrote `service.pulling`, `starting`, `health_checking` and `serving` every time. [PR #13](https://github.com/wpelevator/tug/pull/13), merged after this trial, stops that. The agent keeps a fingerprint and emits lifecycle events only when the revision, rendered compose or secrets change. The apply and the health check still run on every poll, which the new observability page states on purpose. The access-log noise is not fixed. The event flood is, once these agents are replaced.

### What I still had to do by SSH

M5 (`exec`, `logs -f`, `ps`) is the stated next milestone, and this run needed it on the first failure. Completing the WordPress install was a POST to `install.php` from the laptop, which is fine. Finding out why the container never started was not. Current `main` now puts the last apply error in the deployment failure and waits for `doctor --node`, but it still has no live shell or log stream.

`volume list` records the volume and the node. It does not show whether the Docker volume exists or how large it is. I did not test `volume remove`. I also did not re-run rolling deploys, rollback, or `--build-local` on these sites. Those already passed on the nginx fixture. They are not what a WordPress install hits first.

## Documentation

The pages disagree with the path that works.

- The README's steps 1 and 2 assume a public HTTPS control URL. This cluster's API is HTTP on a VPC address, on purpose. The quick start should show the tunnel, and it should say that `control setup` publishes `PORT:8080` on all interfaces unless you change the rendered compose. The bind to `10.110.0.3` is not a documented flag.
- There is no compose example with a database, a secret, a volume, and an ingress host. The samples are nginx, busybox, and redis, placed on `vps-a`, `vps-b`, and `vps-c`. These nodes are named `app` and `edge`. A person copying the sample will fail placement and learn nothing about `depends_on` or TLS.
- `sslip.io` is how both real-host runs got a trusted certificate without owning a domain. It belongs in the networking page next to `tls: auto`, including the rate-limit warning: sslip.io is one registered domain, and Let's Encrypt's per-domain cap is shared with everyone else using it. Two hostnames worked today. A third batch might not.
- Preflight checks free disk (2048 MB under `/var/lib` for control, 1024 MB for a node) and never checks RAM. Both hosts have 1 GB and no swap. An unmodified MariaDB on the control host, next to the agent and the control container, is a bad idea. The control-plane page says the control VPS is not in the request path. It does not say not to put a database on that same 1 GB machine. This cluster does, because there are only two machines.
- plan.md is still the "original specification" linked from the README, and its WordPress compose file is not a file this CLI accepts. The roadmap already says M6 and M7 serve that topology. The README does not. Someone who starts at the README and opens plan.md will try to deploy it. Resolved since: plan.md was removed and the [roadmap](roadmap.md#reference-topology) now holds the reference topology.

## What I would change first

1. Add one worked example: WordPress or any HTTP app plus a database, secrets via `${DB_PASSWORD}`, `depends_on` without `service_healthy`, ingress on an sslip.io name, and a note on the 1 GB MariaDB flag. State that app and database have to share a node until a published port or M7 exists.
2. Make `tug deploy` print one line on success (`wp1 wp1-2 succeeded, 2 services`) and keep the JSON behind a flag. Same for `status`: project, version, health, node, without a nested string.
3. Name the selected project in "service not found" errors.
4. Stop publishing application ports on `0.0.0.0` by default when an ingress is set. Bind the overlay address, or `127.0.0.1` on the ingress node, in the generated file. The operator should not have to paste `10.210.0.1` into the source compose.
5. Say in the README that the plan.md WordPress stack is not deployable yet, and point at the example that is. (Done differently: plan.md was removed and the roadmap describes the topology tug targets.)

I would not treat this run as evidence for rolling deploys, image build, or rollback. Those were not on this path. I would treat it as evidence that a person can get two real sites up, and that the first failure still requires SSH.


## M6, M7 and enrollment on fresh hosts

**Removed mesh implementation:** the commands, flags, environment variables, overlay addresses and packet-path results in this section are historical. tug no longer provides that mesh, and these mesh checks are not a current validation baseline.

31 October 2026, on the same two Ubuntu 24.04 droplets (1 vCPU, 1 GB, amd64, a shared VPC), after wiping both: containers, volumes, images, `wg0` and all tug state. Control ran on 142.93.140.20 with `TUG_MESH=true`. The tug image was built for amd64 from the branch and loaded with `docker save`.

| Check | Result |
|---|---|
| `node add --mesh --label ...` on two hosts (`a`: `app`,`storage`; `b`: `app`) | Both online with labels; WireGuard mesh up |
| `global: true` + `placement.labels: [app]` | One `web` replica on each labelled node |
| `replicas: 1` + labels | One `worker`, on the alphabetically first matching node |
| `tug scale worker 2` / `1` | Second replica started on `b`, then removed; `0` and unknown services rejected |
| NFS volume (`x-tug.type: nfs`, exporter `a`; the volume type has since been removed) | `b` mounted `10.210.0.1:/srv/tug/shared` over the WireGuard overlay (NFSv3); a file written on `b` appeared on `a`; the exporter bind-mounted the directory |
| `ps`, `inspect`, `exec`, `logs -f` against real nodes | Worked |
| `node enroll --install-docker --mesh` cloud-config on a host with Docker purged | Docker Engine and Compose installed, agent started, node enrolled with its label |
| Enrolled node with no public address behind `ufw` deny-incoming | WireGuard handshake and overlay ping to `a` worked; NFS mount worked |

What this does not prove: the cloud-config was applied by re-running cloud-init (`cloud-init clean`, then its stages) with the config in `cloud.cfg.d`, not from first-boot user data, and the agent image came through an SSH-tunnelled throwaway registry. The firewalled node has a public IP, so this is not NAT. Debian, Fedora and Rocky bootstraps, arm64, and certificate renewal were not run.

### Findings

- **Fixed: dead nodes held rollouts open.** After `b`'s host was repurposed as `c`, the old `b` stayed registered with its labels. The next deploy placed `global` replicas on `b`, which never answered, and the deployment stayed `rolling_out` until cancelled. Label and `global` placement, and `tug scale`, now skip nodes not seen within `TUG_STALE_SECONDS`. `scale` also no longer spreads a labelled service onto nodes that do not match its labels when none match.
- **Fixed: there was no way to remove a node.** `tug node remove <node>` now deletes it (refused while a current deployment places something on it, or while its agent still reports, unless `--force`). Run on the hosts: removing the dead `b` succeeded and `a`'s WireGuard peer for it was dropped, while removing `a` was refused with the services placed on it.
- **Fixed: `control setup` could not enable the mesh.** `TUG_MESH` had to be added to the generated compose file by hand; `control setup --mesh` now does it (unit-tested only).
- **Closed by removal: NFS needed host preparation tug does not do.** The exporter needed an NFS server and `/etc/exports`, consumers `nfs-common`. The `nfs` volume type was removed rather than growing a host installer.
- **Open: `cloud-init clean` regenerates SSH host keys.** Expected, but it makes the next SSH to the host fail strict checking.

## Pull-once and backup recipe on a fresh host, 31 October 2026

A single freshly wiped Ubuntu 24.04 host (Docker 29.9.2, 1 GB RAM) with control and one agent built from `main` after PR 25.

| Check | Result |
|---|---|
| Unchanged project left alone for three minutes of agent polls | No container was recreated (same container IDs and start times) and no `service.pulling` event or pull line in the agent log appeared after the deploy finished |
| `examples/wordpress-backup` deployed with `tug deploy` | WordPress, MariaDB 11.4.8 and the backup sidecar converged and WordPress answered on its published port |
| `tug exec backup -- backup.sh once`, then `restic snapshots` | Exit 0, one `db` and one `files` snapshot, `restic check` reported no errors |
| Restore drill into a scratch project (`db` and `backup` only) | The two seeded database rows and the seeded file came back; the repository was a local path, not S3 |

### Second node and S3

The second host (a cloud-init rebuilt Ubuntu 24.04, Docker 29.9.2) was wiped and joined with `node add` from the PR 27 branch; its agent came up with `net=host`. `node add` over an already registered node name worked.

| Check | Result |
|---|---|
| `wp1` redeployed with a `backup-edge` sidecar and an `uploads` volume placed on the second node | Succeeded in 53 s; the sidecar image was built on control and downloaded by the second node's agent; the sidecar was healthy |
| Both sidecars `backup.sh once` into one S3-compatible repository | Snapshots tagged host `app` (`db`, `files`) and host `edge` (`files`) in one repository; `restic check` reported no errors |
| Restore of the `edge` snapshot from the first node into a scratch directory | The text file matched and the 3 MB random file had the same SHA-256 as the original |

The store was RustFS in a container on the second node with random credentials, because the `quay.io/minio/minio` image answers 401 and the `minio/minio` Docker Hub image can no longer be pulled. It is not a hosted provider, and the repository was reached over plain HTTP on a public address, so treat the result as a protocol check, not a production recommendation.

### Findings

- **Fixed: health checks cannot reach containers from a bridge-networked agent.** At the time, `node add` started the agent on the default bridge. On Docker 29.9.2 it could not dial the container IPs of a project's Compose network, so every TCP or HTTP health check timed out (`tcp timeout 172.19.0.2:3306`) while MariaDB was ready, and the first deploy failed. Restarting the agent with `--network host` fixed it. Earlier runs on older Docker did not hit this. Current `node add` and `node enroll` always start the agent with `--network host` for these health checks; no added network capability is required.
- **Open: `--build-local-image` builds for the CLI machine's architecture.** On an arm64 Mac it produced an arm64 image that the amd64 host could not run (`exec format error`). It should build for the target's architecture.
- **Open: a deploy that fails health leaves the project half-up.** The containers kept running after the failed deployment, which hid the real cause until the agent's view was checked.

## Generic backups, restore and `tug run` on fresh hosts, 1 November 2026

The `examples/wordpress` project on two freshly reimaged 1 GB droplets, with the runtime built from the branch (`tug:local`, amd64) and nothing else on the hosts. The hosts were Ubuntu 26.04.1 LTS, newer than the 24.04 of earlier runs. Control and node `app` ran on `tug-1` and node `app2` on `tug-2`. The same example was deployed twice: as project `blog` on `app` and as project `shop` on `app2`, each with its own database and uploads volume. Backups went to an S3-compatible server (`rustfs`) that tug itself deployed as a third project (`storage`) on `app`, reachable only on the private network. This is an operator trial, not a CI job.

### What ran, and the result

| Step | Result on both sites |
|---|---|
| `control setup --install-docker --build-local-image`, `node add` for both nodes | Worked on Ubuntu 26.04: Docker CE 29.9.2 came from Docker's own `resolute` suite, control and both agents came up, nodes registered online |
| `tug deploy` of the example | Converged with health checks passing; WordPress answered `302` to its installer, then served after a scripted install |
| `backup run` | Database dump (`mariadb-dump` run in the container, 107 KiB) and the uploads volume (14.1 MiB) both succeeded in about ten seconds |
| `backup list --check` | Exit 0 with a healthy target list |
| Damage: update the site title in the database, delete the active theme, create a stray file | The site rendered a blank page, as expected |
| `restore db --confirm` | Completed in about 17 to 19 seconds: WordPress stopped, safety backup, dump loaded, WordPress started |
| `restore wp-content --confirm` | Completed; the site title was present **immediately** when the command returned, with no sleep. The theme was back and the stray file gone |
| `restore wp-content --scratch --confirm` | New volume with the files, the live volume untouched; it restored the last real backup, not the safety snapshot taken a moment earlier |
| Scheduled runs | `shop` was redeployed with a two-minute schedule: the scheduler noticed the change within its 30-second tick and started both targets by itself at the next slot (trigger `schedule`); both succeeded. Redeploying the nightly schedule put the next run at 03:00 UTC again |
| `tug run wordpress -- ...` | Saw the service's environment (`WORDPRESS_DB_HOST=db`); exit codes 0 and 7 were returned; no helper containers were left on either node |
| Repository contents | Each project has its own repository (`tug-wp/blog`, `tug-wp/shop`), four snapshots each (two backups, two safety snapshots), hosts `app` and `app2`; `restic check` passed when run from the *other* server, a machine that never held the data |
| Memory | `tug-1` (control, agent, S3, MariaDB, WordPress) used 508 of 956 MB; `tug-2` used 420 MB; no out-of-memory events |

### Findings

- **The updater can starve a small host.** On the earlier installs Ubuntu's `unattended-upgrades` and `apt-check` had run for over an hour on `tug-1`, holding it at load 16 until Docker commands timed out. The fresh hosts had the apt timers disabled before anything else was installed. This is now noted in [Nodes](nodes.md).
- **Control and a node on one host compete for port 8080.** The example publishes `8080:80`, control publishes `8080`, so the copy for `tug-1` used `8081`. Control on a runtime node is [M15](roadmap.md#m15--flexible-node-roles).
- **Named volumes need no ownership fixing.** The S3 server runs as uid 10001. As a bind mount it failed with `Permission denied`; as a named volume deployed by tug it started cleanly.
- **Scratch-restore volumes are left behind**, as documented. They were removed by hand.

Not covered by this run: a real AWS S3 bucket (the S3 server is `rustfs`, which speaks the same protocol), a failing backup on a real host (`backup list --check` was only seen exiting 0 here; its failing path is covered by unit tests), a control restart or a long control outage, a node behind NAT, ingress and certificates (the hosts had no DNS names, so the sites were reached on their private addresses), and a project that spans both nodes.

## Recovery drill with the published 0.9.0 release, 2 November 2026

Two disposable amd64 Ubuntu hosts were used. The published npm CLI and `ghcr.io/wpelevator/tug:0.9.0` image ran control and the original agent on one host; an agent on the other host served as the replacement workload node. A dedicated RustFS container on the replacement host stored workload backups over the private network; this was an S3-protocol exercise over HTTP, not a hosted S3 or encrypted-transport validation. One host already had an unrelated control container and data, which were left in place. The release predates removal of tug’s optional mesh; no mesh was enabled.

The WordPress example deployed successfully, WordPress was initialized, and an upload sentinel was created. A manual backup produced a MariaDB dump and a `wp-content` snapshot. A separate control backup and the repository credentials were copied off the control host into private local files. The original workload agent and containers were stopped to simulate workload loss while keeping control available. The project was redeployed with placement changed to the replacement node, then the database and uploads were restored there with tug’s normal safety backups. The recovered database contained the original site title, the uploaded sentinel matched exactly, and HTTP returned 200. This tested a manual re-placement and restore, not an automatic host failover; external DNS, HTTPS and a second public request path were not tested.

Immediately after the replacement deployment succeeded, the restore plan still named the old node because backup schedules had not yet caught up. After a later scheduler tick it named the replacement; the restore was not confirmed until the target had been checked. The branch now refreshes schedules when planning and queueing a restore and has a regression test. This fix was not part of the published release used for the drill.

For control recovery, an updated control backup was copied off-host. The test control container was stopped and removed, and its data directory was moved aside intact. A new control was bootstrapped on the same machine with fresh storage and a temporary credential. The backup was copied into its mounted data directory, restored through the API and activated by restarting control. The original credential and CA worked again, the replacement agent reconnected, the recovered backup repository credentials matched the escrowed copy, and the WordPress site still returned HTTP 200. This first pass demonstrates fresh-directory recovery on the same machine, not loss of its underlying disk. The test did not verify certificate renewal, automatic off-host backup, or a restore after the backup destination itself is lost. No measured recovery time or data-loss objective is claimed from this exploratory run.

A second control backup cycle included a small tug-built image. After restoring that backup into another fresh control data directory, the disposable probe container and its local image were removed from the replacement node. Its agent downloaded the retained artifact from restored control and recreated the container; the file baked into the image contained the expected marker. An initial remote-build attempt launched from the repository directory with an absolute Compose path failed with `source context has unsafe entries or exceeds expanded limits`; running the same deployment from its own clean context directory succeeded. The cause of the first rejection was not established.

A further control recovery used the other VPS: a separate control container was bootstrapped on a distinct port and empty data directory without replacing that host’s pre-existing control instance. The off-host backup containing the built image was copied into the new data directory, restored using the temporary bootstrap credential, and activated by restart. The original test control was stopped to prevent two active authorities. The original operator credential then worked with a control URL override, and `node replace` repointed the replacement agent to the recovered control; the node reported online and the backup catalog was present. The probe’s local container and image were deleted once more, and the agent re-downloaded the restored built image from control on the new host; the image marker matched and WordPress returned HTTP 200. This confirms manual cross-host control recovery for this topology, but the replacement host also held the test object store and site, so it did not test simultaneous loss of that host or its object store. `node add` for the existing node returned 409 and required the identity-replacement command.

## 1.0.0 release candidate on QEMU VMs, 7 November 2026

A partial run of the [Road to 1.0.0](roadmap.md#road-to-100) gate on two fresh Ubuntu 24.04.5 arm64 VMs under QEMU with hardware acceleration on an Apple Silicon laptop: 2 vCPU, 3 GB RAM and a 19 GB disk each, a second NIC joining them on a private `10.0.0.0/24` link, NAT to the internet and no public IPs. vm1 ran control and the node `app1`, vm2 the node `app2`. The baseline used the published `@wpelevator/tug@0.14.0` CLI and `ghcr.io/wpelevator/tug:0.14.0` image. The candidate was the `release/1.0-prep` branch with its changesets applied (version 1.0.0), packed with `npm pack` and installed as a tarball, with the image built on the laptop and copied to the VMs by `--build-local-image`, so the published-image pipeline was not exercised. This is arm64, not the amd64 of earlier runs, and not a real VPS network: no public DNS, Let's Encrypt, NAT between hosts or latency.

**Baseline on 0.14.0.** `tug setup root@vm1 --install-docker` took about 60 seconds including the Docker install. `tug node add` took about 8 seconds on the host that had Docker and 50 seconds on the one that did not. MariaDB 11.4.8 and WordPress 6.8.3 were deployed on `app1` (about 33 seconds), WordPress was installed through its web installer, and an upload sentinel file was written. The 0.14 control database reported `PRAGMA user_version` 0. A control backup was copied off the VM.

| Check | Result |
|---|---|
| 1.0.0 CLI against the 0.14 control, read and mutation | Refused with `tug control setup <control host> --yes`, exit status 1 |
| 0.14 CLI against the 0.14 control | Works |
| `tug control setup --build-local-image` over the 0.14 control (about 77 seconds) | Control recreated, database at schema 1, `tug.db.pre-v1.bak` present at schema 0 with the same project count, workload containers not restarted |
| 0.14 agents while control restarted | A few `fetch failed` lines, then quiet; both nodes online without intervention |
| 0.14 CLI against the 1.0.0 control | Warns `update the CLI with: npm i -g @wpelevator/tug@1.0.0` and proceeds (the 0.14 code only warns about a newer control) |
| `tug doctor` and `tug doctor --nodes` on the upgraded fleet | `ok: true`, no warnings |
| Agent upgrade of both nodes | Workload containers kept running; both nodes online on the 1.0.0 image |
| Site after the upgrade, before any redeploy | Title and upload sentinel hash unchanged |
| `tug deploy` with a changed environment variable, then `tug control backup` | Succeeded on the migrated database. The container was recreated and the database volume persisted (the site title survived), but the upload sentinel was gone: the compose file declared no volume for `/var/www/html`, so the image's anonymous volume went with the old container. That is a flaw of this test compose file, not of the upgrade. |
| `tug node add` on an enrolled host | **Failed with `409 node already exists`** (below); passes after the fix: same key hash before and after, node online, workload untouched |
| `tug node add --name <other>` on an enrolled host | Refused with ``use `tug node replace app1` ``, nothing registered, no stack trace |
| `tug node replace` | Still rotates the key (key hash changed), node back online |

**Finding, fixed.** `agent identity` built its CSR from the pending key file only, so re-running `tug node add` on an enrolled host sent a new key, which control rightly refused, although [Nodes](nodes.md#image) promised an in-place upgrade. `agent identity --current <node>` now reuses the installed key when the host is enrolled as that node and refuses another name; `node add` asks for it and `node replace` and `node repair` still rotate the key. Covered by `src/agent/credential.test.ts` (reuse, rotation, refusal, fresh host), `src/cli/commands/node.test.ts` (the arguments per mode) and `src/main.process.test.ts` (the plain error through the real entrypoint), and re-verified on the VMs with a rebuilt candidate.

**Observations, fixed afterwards.** `tug node replace` and `tug node repair` now accept `-y` like `tug node add` (they never ask, and `--all` still needs the nodes declared in `tug.yml`). `--build-local-image` now runs the build on the host under `<tag>-<image id>` (for example `tug:local-a17ed756592c`) as well as `tug:local`, so rebuilding `tug:local` no longer leaves the running control or agent container showing an image ID.

### Rollback lane

Before the rollback the 0.14.0 control image was tagged `tug:rollback` on vm1, as the upgrade docs recommend, and a fresh control backup was taken. Then `tug control setup root@vm1 --image tug:rollback --yes` ran with the 1.0.0 CLI, followed by `tug control setup --build-local-image` to go forward again.

| Check | Result |
|---|---|
| Rollback command | About 11 seconds; the 0.14.0 control started on the schema-1 database without complaint. `user_version` stayed 1 and no project data was lost, because schema 1 is the schema every release from 0.8 shares and 0.14 ignores `user_version`. |
| Writes by the 0.14 control on that database | A secret created through the 0.14 CLI persisted and was still there after going forward again |
| 1.0.0 agents against the 0.14 control | Refused on every poll (8 times in a minute) with the control's message plus the agent's remedy: `this client (1.0.0) is newer than the control running 0.14.0 … its containers keep running, and it resumes once the control is upgraded or the agent is rolled back to the control's version` |
| Workloads during the refusal | MariaDB and WordPress kept running and the site answered HTTP 200 |
| Status while agents were refused | `tug status` showed both nodes `stale` after 60 seconds, but `tug node list` kept showing them `online` with an old last-seen time |
| 1.0.0 CLI against the rolled-back control | Refused with `tug control setup <control host> --yes`, as designed; the 0.14 CLI worked |
| Going forward again with `--build-local-image` | About 17 seconds; no migration ran (`user_version` already 1) and `tug.db.pre-v1.bak` was not rewritten (same timestamp as the first upgrade); both agents resumed within the poll interval with nothing logged and both nodes online |
| A database from a newer tug (`user_version` set to 2 on the stopped control) | The 1.0.0 control refused to start with ``the control database is at schema version 2, newer than the 1 this tug supports; upgrade tug, or restore a backup taken by this version``, left the file untouched (still version 2, same project count) and the container restarted in a loop. Setting the version back to 1 and starting it recovered everything. |

**Observations, fixed afterwards.** The refusal to open a newer database used to print a stack trace in the control's log. The control and the agent now print one `error:` line with the remedy and exit 1; Docker's restart policy still restarts the container until the operator acts, so the log holds that single line repeated. `tug node list` reported a node `online` from its stored status while `tug status` correctly said `stale`; the list now judges staleness itself, so the two agree.

### Quick start on a fresh host

A third fresh Ubuntu 24.04.5 arm64 VM (no Docker, no private link, forwarded ports 9443 and 9080) followed [Deploy your first service](getting-started.md) with the 1.0.0 candidate, driving the prompts through a pseudo-terminal so they behaved as in an interactive shell. Three deviations from the text were forced by the setup, not by tug: the candidate CLI came from the packed tarball instead of `npm install -g`, the image was built locally (`--build-local-image`, the 1.0.0 image is not published), and the VM sits behind NAT, so `--control-url https://127.0.0.1:9443` told the CLI where to connect and `--agent-control-url https://127.0.0.1:8443` told the agent.

| Step | Result |
|---|---|
| `tug setup root@vm3` | Asked once whether to install Docker with the Compose plugin, showed the control plan (host, control URL, mTLS port, image, Docker, credential) and asked to confirm; installed Docker, built and copied the image, started control, wrote `tug.yml` and `tug.local.yml` and imported the credential |
| `tug status` | `No projects`, no nodes |
| `tug node add root@vm3 --name app1` | Docker already present, so no Docker question; asked for the address other nodes should use, whether the node handles ingress, then showed the node plan and asked to confirm; the node reported online |
| `tug deploy` with the guide's nginx `compose.yaml` | `succeeded` in about 8 seconds, `web` serving; `tug logs web` worked and `curl` through the forwarded port returned HTTP 200 and the nginx welcome page |

**Finding, fixed.** The address question offered `docker0` and Docker's `br-<id>` network bridge next to the real interface (`1) 10.0.2.15 (nic0, private)`, `2) 172.17.0.1 (docker0, private)`, `3) 172.18.0.1 (br-…, private)`). Those addresses only reach containers on the host, so `tug node add` now leaves out Docker and CNI bridge interfaces (`docker0`, `br-<12 hex>`, `veth*`, `cni*`) and keeps operator bridges such as `br-lan`.

### Recovery drill

The same VMs, rebuilt from `main` at the 1.0.0 candidate (the merged release preparation, the lifecycle and image-reuse changes, and the changesets applied, so version 1.0.0), ran the control and workload recovery drill. vm1 held control and `app1`, vm2 `app2`, and vm3 (re-provisioned as a standalone host, so the quick start above no longer exists on disk) held a RustFS S3 store (`rustfs/rustfs:latest`, digest `sha256:ed9210d6…`). The QEMU socket link joins only two VMs, so vm1 and vm2 reached the store through the laptop at `http://10.0.2.2:9000`: an S3-protocol exercise over plain HTTP, not a hosted S3 or TLS validation. The control on vm1 was the one upgraded from 0.14, so its database had been migrated. The project was the WordPress example with MariaDB 11.4.8 and WordPress 6.8.3, placed on `app1` with the `db-data` and `wp-content` named volumes and no ingress (port 8090). It was initialized through the web installer, a table with a marker row was added to the database, and two files (1 MiB of random data and a token file) were written to `wp-content/uploads`; their SHA-256 sums and the marker were recorded before any backup. Both targets were backed up with `tug backup run` (database 108 KiB, `wp-content` 15 MiB), the repository password and the control archive (24 MiB, including a built image) were copied off the VMs, and the original root credential was kept next to them.

**Phase A: the workload node is lost, control survives.** `app1`'s agent and containers were stopped (the fence) and the project was re-placed on `app2`.

| Step | Result |
|---|---|
| `tug deploy` with the new placement | Refused with `409`: `db, wordpress would start empty on a different node`, naming `--move db --move wordpress` |
| Same deploy with both `--move` flags | `succeeded` in about 30 seconds; `app2` started a fresh database and WordPress |
| `tug restore run db` and `wp-content` without `--confirm` | Both plans named `app2` and the pre-loss snapshots, and said nothing was changed |
| The same with `--confirm` | Database restore 21 seconds, uploads restore 14 seconds, each with a safety backup tagged `pre-restore` |
| Verification | The marker row and site title matched, both upload files matched their SHA-256 sums byte for byte, `GET /` returned 200; about three minutes from fence to verified, including the finding below |
| `tug backup run` from `app2` | Both targets succeeded into the same repository, so the recovered node received the credentials from control |

**Finding, fixed.** After the `--move` deploy WordPress on `app2` was running and redirecting to `/wp-admin/install.php` against the empty database: the hold that should have stopped it did not exist. The deploy held only the writers of a moved service that were not themselves acknowledged moves, but WordPress mounts a volume, so the refusal asked for it to be acknowledged too, and acknowledging it exempted it from the hold. Following tug's own instruction therefore exposed a fresh installer. The data was never at risk, because the in-place restore replaced everything. Every writer of a moved service is now held, whether or not it moved too, with a regression test, and the replacement-node procedure now says to deploy with `--move`.

**Phase B: the control plane is lost.** The control container on vm1 was removed and its data directory moved aside. The site on `app2` kept returning 200 and the agent logged `fetch failed`. Recovery followed [Recover control on another host](control-plane.md#recover-control-on-another-host) onto vm2, with the laptop reaching the new control through an SSH tunnel because the forwarded port belonged to vm1.

| Step | Result |
|---|---|
| `tug control setup root@vm2 --no-import --credential-out …` | A temporary control and bootstrap credential in about 8 seconds |
| Copy the archive to `/var/lib/tug-control`, `tug control restore /data/restore-input.tar.gz --confirm`, restart control | Restore in about a second; the control listened again after the restart |
| The bootstrap credential | Refused after the restart: its CA was replaced by the restored one |
| The original root credential | Worked: projects, nodes, secrets, operator credentials, the backup destination and the events up to the archive (1,204) came back; `LATE_SECRET`, set after the archive was taken, was absent, as documented |
| Node status | `app2` showed `stale` until `tug node replace app2 root@vm2 --agent-control-url https://10.0.0.12:8443`, then `online` within about ten seconds |
| Verification | The site returned 200 with the original title; `tug backup password` returned the escrowed repository password and URL; the catalog held the original snapshots and the safety backups; a new `tug backup run` succeeded; a redeploy through the recovered control succeeded; a scratch restore of `wp-content` read the old snapshot back with matching SHA-256 sums; the built image archive was present in the restored image directory; about a minute and a half from the lost control to verified |

**What this does not show.** Loss of the S3 store, or of control and a workload node at once; TLS or a hosted object store; amd64 or a real network; a changed control host name (the public host stayed the same and only the connect address moved, so DNS repointing was not exercised); recovery of `app1`, which stayed stale. The timings are scripted runs on local VMs with small data, not recovery-time claims. The published image was not used, as the 1.0.0 image does not exist yet.

### Published 1.0.0 smoke test

After the release workflow finished (the npm package, the GitHub release and both image jobs succeeded), the published artifacts were tested with nothing built locally. npm carries `@wpelevator/tug@1.0.0` as `latest`, and `ghcr.io/wpelevator/tug:1.0.0` and `:latest` are the same multi-arch index (amd64 and arm64, digest `sha256:a11a92e8…`). The VMs are arm64, so the amd64 variant was not run. The CLI came from `npm install @wpelevator/tug@1.0.0` into a clean directory instead of `-g`, because the laptop is shared, and the prompts were driven through a pseudo-terminal. The NAT deviations are the same as in the quick start above (`--control-url https://127.0.0.1:9443` for the CLI, `--agent-control-url https://127.0.0.1:8443` for the agent).

| Step | Result |
|---|---|
| `tug --version` after the install | `1.0.0` |
| `tug setup root@vm3 --control-url …` on a freshly provisioned VM with no Docker | Installed Docker and the Compose plugin, pulled `ghcr.io/wpelevator/tug:1.0.0`, started control and imported the credential; about 37 seconds. The image on the host carries the registry's index digest |
| `tug node add root@vm3 --name app1 …` | Offered only the real interface (`nic0`) and `none` as the address, asked about ingress, showed the plan with the published image and confirmed; the node was online within about nine seconds, running the published image |
| `tug deploy` with the guide's nginx `compose.yaml` | `succeeded` in about seven seconds, `web` serving, `tug logs web` worked and the forwarded port returned HTTP 200 and the nginx welcome page |
| The control and agent of the recovery drill (an existing, migrated and restored data directory, running the candidate build) switched with `tug control setup root@vm2 --yes` and `tug node add root@vm2 --name app2 …` | Control opened the existing data with the same root credential, the projects, nodes and secrets were intact, `node add` upgraded the agent in place (same key, no 409) and it was online within seconds, and the recovered WordPress still returned its original title |

**Finding, fixed.** CI on the release commit itself failed in all three Node jobs with five tests, although the release and the published artifacts were fine. Four install tests asked the real registry whether the default image exists, which is false on the commit that cuts a release because its image builds minutes later, and one skew test still assumed that a newer minor is refused, which stopped being true at 1.0 and had never failed because the package version only became 1.0.0 in that commit. The tests now use a stub `docker` and the 1.0 rule. I had not run the suite on the version-bumped tree before the release.

**Not yet run:** amd64, real NAT, certificate renewal and an upgrade straight from the published 0.14.0 to the published 1.0.0 image (the upgrade above started from the candidate build).

## Quiet remote steps and keyboard menus on fresh VMs, 7 November 2026

Two fresh Ubuntu 24.04 arm64 VMs under QEMU (the official cloud image, checksum verified; 2 vCPU and 3 GB each, NAT plus a private `10.0.0.0/24` link), driven by the CLI from source. `tug setup root@vm1 --install-docker -y` installed Docker and control in 52 seconds and printed twelve progress lines, with no per-layer pull output. In a pseudo-terminal, `tug node add root@vm2` offered Docker, showed the address menu (arrow key to the private link address, enter), asked about ingress and confirmed; the node came online and reported over the private link. A failing step (unresolvable SSH host) printed its error as the last lines, `--verbose` streamed the preflight output, and a multi-choice menu refused an empty confirmation and accepted space then enter. The published-image pull was exercised on both VMs (`ghcr.io/wpelevator/tug:1.0.0`); a TTY run of `tug setup` itself and arm64-only hosts were not repeated.


## Cloud-init first boot and the bootstrap retries on QEMU VMs, 7 November 2026

`tools/scripts/qemu-first-boot.js` booted the official arm64 cloud images with HVF (2 vCPU, 2 GB, QEMU user networking), each image checksum verified against its publisher's file, with the user-data from `tug node enroll --install-docker` as a NoCloud seed beside an operator part that adds an SSH key. Control ran on the laptop with its certificate naming `10.0.2.2`. Every run was a real first boot of a fresh copy-on-write disk, not a `cloud-init clean` replay, and the guest pulled `ghcr.io/wpelevator/tug:1.0.0` from the registry. The repository's main branch at that point was `92d85eb` plus the bootstrap retry change.

| Image | Condition | Result |
|---|---|---|
| Ubuntu 24.04 (noble) arm64 | Clean | Node enrolled and online in 66 seconds, agent running (Docker 29.9.3) |
| Ubuntu 24.04 arm64 | `download.docker.com` unreachable for about 40 seconds | Three retries, then Docker installed; enrolled in 104 seconds |
| Ubuntu 24.04 arm64 | `download.docker.com` unreachable for 900 seconds | Gave up after five attempts and logged `tug-bootstrap: failed during: adding the Docker apt repository (exit 1)`; the harness saw cloud-init's error state after 88 seconds |
| Fedora Cloud Base 44 arm64 | Clean | Enrolled in 58 seconds through the dnf path, agent running |
| Fedora Cloud Base 44 arm64 | `download.docker.com` unreachable for about 45 seconds | Four retries, then the repository file was fetched and Docker installed; enrolled in 108 seconds |
| Alpine 3.24.2 arm64 (cloud-init image) | Clean | Refused as designed: `Unsupported Docker bootstrap OS: alpine; install Docker Engine and Compose manually.`, exit 20; no agent started and the harness saw cloud-init's error state 34 seconds in |

**Findings.**

- The retry window is about 50 seconds. Fedora's outage of 45 seconds from early boot recovered only on the fifth and last attempt, so a longer outage fails. That is the intended bound, not slack.
- A first version of the outage simulation hung the guest at boot (a `systemd-run` call inside cloud-init's `bootcmd`); this was the harness, not the bootstrap, and a detached background sleeper replaced it.
- The Alpine refusal reached `/var/log/cloud-init-output.log` but not the serial console, unlike Ubuntu and Fedora, so a user without SSH access to such an image sees nothing. Whether a manual Docker install on Alpine (plain `node enroll` without `--install-docker`) works was not tried.
- The join key remains in `/var/lib/cloud/instance/user-data.txt` and `scripts/runcmd` on the guest after enrollment (readable by root only, and the key is single-use) and in the agent container's environment.

**Not run:** Debian, Rocky or AlmaLinux, RHEL, amd64 guests, Ubuntu 26.04, a real provider's user-data and metadata service, or a distribution that needs the manual path with a working Docker.

## Operator workflows on merged main, QEMU VM, 9 November 2026

Setup: merged `main` at `322cb38` (PR 119), one Ubuntu 24.04 arm64 VM under QEMU (4 GB, user networking, hardware acceleration) running control and one node, an S3-compatible RustFS on the laptop over plain HTTP, the `examples/wordpress` project, and a throwaway "legacy" WordPress 6.8.3 site on the laptop as the migration source (a SQL dump of 88 KB and a `wp-content` tarball of 14 MB with a 1 MiB sentinel file). Control and agent were first installed from the pre-merge branch tree and then upgraded in place to merged `main`; the failure-reporting results below are from `main`.

| Workflow | Result |
| --- | --- |
| Install control and node, deploy WordPress and MariaDB | Works: about 40 s from a fresh VM for the deploy |
| Migrate an existing site: import SQL | Works for a small dump (`tug exec -i db -- mariadb …`, under 1 s) |
| Migrate an existing site: import uploads | **Fails.** `tug exec -i` rejects more than 1 MiB of stdin (`stdin exceeded the live session buffer limit`, `src/cli/live.ts`). Worked only when split into 28 chunks of 512 KiB appended with repeated calls (10 s), after which the file hash matched. Any real database dump fails the same way |
| Migrate: rewrite URLs | Not possible with the stock `wordpress` image (no WP-CLI); the docs say to bake it into your image but no example does |
| Staging as a second project (`--project shop-staging`, own secrets, port) | Works: 12 s to deploy beside production. Copying the small database through a pipe between two `tug exec` calls works (0.6 s) |
| Staging: copy production uploads | **Fails.** `tug exec` stdout is cut at 6 MiB (`operator buffer limit exceeded`) and the receiving side dies with `ECONNRESET`. A restic snapshot cannot be restored into another project's services (repository per project), and there is no `tug project delete` |
| Backup and scratch restore of a volume | Works: 15 MiB in 12 s, scratch restore in 6 s, sentinel hash verified. The scratch volume is invisible to `tug volume list` (known gap) |
| Backup destination down | Detected in 8 s: `backup.failed` events, `backup list --check` exits 1 |
| **Backup repository damaged** (4 KiB overwritten in a stored data pack) | **Not detected.** The next `backup run` succeeded (`0 KiB added`), `--check` exited 0, and a scratch restore stayed in `restoring` for more than 15 minutes with no error until control was restarted. There is no `restic check`. The RustFS server may have turned the damage into read errors that restic retries, so a different store could fail faster; the lack of any verification is the finding |
| Crash and crash loop on merged `main` | Works: `container.exited` (`warn`) on the first exit 1, `container.crashloop` (`error`) after three in five minutes. A signal-killed container (137) is ignored by design |
| What `tug status` says in those cases | **Misleading.** A crash-looping service and a site whose home page returns 500 (health path `wp-includes/version.php` still 200) both show `serving`, and the deployment stays `succeeded` |

Not exercised: the operator watch channel and `tug tui` push over a real network (covered by unit tests only), public DNS, Let's Encrypt, NAT, a second node, multi-hundred-megabyte data, AWS S3, amd64, and outbound alerts (none exist).

### Job queue on the same VM, branch build, 9 November 2026

The VM was upgraded to the branch (control and agent, `--build-local-image`); it reports 4 GB, so the agent ran two jobs at a time. The RustFS store was paused with `docker pause` so connections hang instead of failing.

| Check | Result |
| --- | --- |
| Hung backup of `shop` `wp-content`, then a manual backup of `shop` `db`, then a manual backup of project `shop-staging` | The first showed `running (checking)`, the second `queued behind bkr_…` (same project, so it shares the repository), and staging's ran at the same time in the second slot |
| `tug backup cancel` of the queued run | `failed`, error `cancelled by an operator`, a `backup.cancelled` warning, nothing queued as a retry |
| `tug backup cancel` of the running run | Same result within 15 s, and its restic helper container was gone |
| Cancelling a run that already finished | `409 already failed` |
| In-place restore of `shop` with the store paused, then `tug restore cancel` while it waited on its safety backup | The safety backup was cancelled, the restore ended `failed … nothing was changed`, and the held `wordpress` container was running again |
| Staging's hung backup left alone | After 600 s it failed on its own with `restic made no progress for 600s (0 bytes so far); the repository may be unreadable or the backup store unreachable`, a `backup.failed` event, and no helper containers left |

Not run: lane order on a real node (a restore ahead of a manual backup ahead of a scheduled one is covered by tests with a fake Docker), cancelling a restore that is already restoring, and a host with under 3 GiB of memory (one job at a time).



## 3.0.0 on Vultr with five frameworks, 15 November 2026

The published `@wpelevator/tug@3.0.0` CLI and `ghcr.io/wpelevator/tug:3.0.0` image on three fresh Vultr VMs in Amsterdam, with Vultr Object Storage (Standard tier, `ams1`) for backups and for a chop media bucket. Every operator step went through `tug`. Direct SSH was used only for the host firewalls, for the Caddy log (which `tug logs` does not read), and for the benchmark load generator and `docker stats` sampling, because tug exposes none of them.

| Host | Role | OS | Size |
|---|---|---|---|
| ctl | control | Ubuntu 24.04 | 1 vCPU, 2 GB |
| n1 | node and ingress | Debian 12 | 2 vCPU, 2 GB |
| n2 | node and ingress | Rocky Linux 9.8, SELinux enforcing, firewalld | 2 vCPU, 2 GB |

The three VMs share one private network (10.50.0.0/24) and the nodes registered with their private addresses. Public hostnames are `<name>.<ip-with-dashes>.sslip.io` with Let's Encrypt certificates.

### What ran

| Project | Node | What it exercised | Result |
|---|---|---|---|
| `phpdb` | n1 | `php:8.3-apache` built on control, MariaDB 11.4.8 with a volume, a MariaDB dump backup to S3, restore | Served, backed up and restored |
| `chop` | n2 | `ghcr.io/wpelevator/chop:latest`, `read_only`, `cap_drop: [ALL]`, originals read from an S3 bucket with `CHOP_ORIGIN=s3://…`, secrets from control | Served resized AVIF (`?w=640`, 13 KB from a 322 KB JPEG) |
| `express` | n2 | Node 22 build on control, a secret, a redeploy | Served |
| `laravel` | n1 | `examples/laravel`: MariaDB, Redis, `tug run web -- php artisan migrate --force` | Migration ran, `/health` 200 |
| `django` | n2 | `examples/django`: PostgreSQL, Redis, gunicorn | `/health` 200 |
| `nextjs` | n1 | Next.js 15 standalone, built on the 1 vCPU, 2 GB control | Served, build and deploy took 2 min 27 s |

Install times from a bare VM: control 66 s including Docker, and a Debian node and a Rocky node each took under two minutes with Docker installed by tug (Rocky was the slower, its Docker package step ran for about 90 s). Deploys that built an image on control took 55 to 150 s. A deploy of an unchanged image with a changed secret took 14.8 s. `backup run` of the MariaDB dump finished in about 10 s. `restore run db --confirm` passed through `holding`, `safety_backup`, `restoring` and `verifying` to `succeeded` within seconds. The page's hit counter was the same after the restore as before, which does not prove the data went back, so this checks the workflow and not the content.

### Overhead of tug on the machines

All numbers are `docker stats` samples on the running hosts, after the six projects were deployed (about 940 MB of the 1.96 GB in use on each node, most of it the applications and the page cache).

| Component | Idle CPU (average) | Memory | Under load or deploy |
|---|---|---|---|
| Control (ctl, six projects, two nodes) | 0.1 to 1.4 % | 55 MiB | 64 MiB and a 13.9 % CPU peak during a deploy |
| Agent (n1, n2) | 0.15 to 0.6 % | 49 to 54 MiB | Average 2.2 % at 4,700 requests per second through the node, 5.6 % peak during a redeploy |
| Caddy ingress | 0.07 to 0.45 % | 23 to 27 MiB | 44 MiB, and about 115 % of one core (of two) at 4,700 requests per second over HTTPS |

The control and agent together are about 105 MiB and well under 1 % of a CPU on an idle node. The agent's cost does not grow with application traffic, since traffic goes through Caddy and the application containers, not through the agent.

### Ingress overhead

ApacheBench from the control VM (same datacenter, keep-alive, 20,000 requests): the first column hits the published port on the node's private address, the second goes through Caddy on the public HTTPS name.

| Target | Concurrency | Direct | Through Caddy | Mean latency, direct → Caddy | p99, direct → Caddy |
|---|---|---|---|---|---|
| Express `/health` (single Node thread) | 10 | 3,177 rps | 3,142 rps | 3.1 → 3.2 ms | 11 → 11 ms |
| Express `/health` | 50 | 3,370 rps | 3,087 rps | 14.8 → 16.2 ms | 34 → 47 ms |
| Apache and PHP `/?health=1` | 10 | 6,194 rps | 2,741 rps | 1.6 → 3.6 ms | 7 → 12 ms |
| Apache and PHP `/?health=1` | 50 | 3,817 rps | 2,791 rps | 13.1 → 17.9 ms | 528 → 72 ms |
| chop `/healthz` | 10 | 9,600 rps | 5,019 rps | 1.0 → 2.0 ms | 3 → 7 ms |
| chop `/healthz` | 50 | 11,631 rps | 4,614 rps | 4.3 → 10.8 ms | 10 → 39 ms |

An application that is itself the bottleneck (Express) loses under 10 % through the ingress. A fast backend (chop) loses more than half its throughput, because Caddy terminating TLS on two vCPUs is then the limit. The ingress adds roughly 1 to 6 ms at the median. One direct PHP run had a 528 ms p99 that the proxied run did not, which is noise from a single run and not a conclusion.

### Redeploy without a gap

With the default `recreate` strategy, a redeploy of Express (a rotated secret, no rebuild) while a probe requested the public HTTPS name every 50 ms from the control VM: 492 probes, no failed or non-200 response, and a 1.07 s maximum latency. Caddy held the requests while the container was replaced. That is a measurement of a short, stateless container, so it does not contradict the documented advice to use `rollout: rolling` where an interruption is not acceptable.

### Papercuts found

None of these blocked the run. Each is listed with its fix in `plan-real-host-papercuts.md`.

1. **`docs/backups.md` MariaDB and PostgreSQL recipes make `tug deploy` fail.** `restore: mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"` has a single `$`, so control demands a value named `MARIADB_ROOT_PASSWORD` (`compose.yaml needs values that are not set on control`). The `examples/` files already use `$$`.
2. **tug does not touch the host firewall.** Debian's default `ufw` blocked 80 and 443. Rocky's `firewalld` also had to allow 80 and 443, and both needed a rule for the private network before the control VM could reach published ports directly. `tug node add --ingress` and `tug doctor` reported everything `ok` while the sites were unreachable from outside.
3. **Opening the ports late costs about 9 minutes.** Caddy's first ACME attempts failed with the ports closed, and Let's Encrypt then refused the same names for the rest of the hour after five failed authorizations (`retry after …`). Nothing in tug's output mentioned it.
4. **`tug logs` cannot read the managed Caddy** (`service caddy not found in project chop`), so the ACME failure was only visible over SSH.
5. **Every ingress node requests certificates for every project's hosts.** The Caddy on n2 kept trying (and failing) to validate `php.95-179-141-193.sslip.io`, a name that resolves to n1, and logged errors for it.
6. **A host-port clash is only found when the agent applies the deployment.** `laravel` and `phpdb` both published host port 8080 on n1. `tug lint` and `deploy --dry-run` passed, the deployment ran for 2 min 18 s of building and then failed on `Bind for 10.50.0.4:8080 failed: port is already allocated`.
7. **The first failed health deploy gives only the node's message.** The PHP project failed on `web: http 404` because the example path had no route. That is correct, but the message does not name the URL requested.
8. **The deploy summary label does not change for a secret-only change.** `express git-bdf4dabe325f` was printed for both the original and the secret rotation, which are different deployments.
9. **`tug doctor` fails the whole check on a machine without Docker.** The laptop had no Docker daemon, so the `docker` check printed `FAIL` and the command said `Problems found`, although Docker is needed on the laptop only for `--build-local`.
10. **A stale `known_hosts` entry for a reused provider IP blocks the first SSH** (`Host key verification failed`). That is OpenSSH and not tug, but `tug node add` showed it as a connection failure. tug explains the refusal and prints the `ssh-keygen -R <host>` remedy, see [Troubleshooting](troubleshooting.md#find-the-message).
11. **tug exposes no host metrics.** The overhead above came from `docker stats` over SSH. `tug doctor --node` reports Docker and Caddy state but not CPU, memory or disk.

### Rolling, rollback, upgrade and recovery

Run on the same VMs, two extra 1 vCPU, 2 GB Ubuntu hosts for the upgrade and the recovery target.

| Check | Setup | Result |
|---|---|---|
| Rolling rollout under load | Express with `rollout: { strategy: rolling, drain: 15s }`, a rebuilt v2 image deployed while ApacheBench held 20 connections (267,129 requests at 2,968 rps) and a probe requested the page every 50 ms | The deploy took 38 s. Of 424 probes none failed, 243 saw v1 and 181 saw v2. ApacheBench counted 10 failed requests of 267,129 (0.004 %) and no non-2xx responses. Its breakdown of the 10 was lost, so they are not classified |
| Automatic rollback | v3 whose `/health` returns 500, `x-tug: { rollback: auto }`, the same load | The deploy failed after 10 health attempts (`web: http 500`) and took 66 s. All 564 probes returned 200 from v2 throughout, and control recorded a `rollback-git-…` deployment that ended `succeeded` with the node serving the previous version |
| Upgrade from 2.0.0 | `@wpelevator/tug@2.0.0` installed control and a node on one VM, an nginx service with a secret and a volume file. `tug upgrade -y` from the 3.0.0 CLI | 36 s in total. Control and the agent moved to `ghcr.io/wpelevator/tug:3.0.0`, 168 of 168 probes every 200 ms returned 200, the volume file and the secret survived and `status` showed the service `serving`. A second `tug upgrade -y` printed `nothing to do` and `skipped` |
| v3 value rules after the upgrade | A `.env` beside the file, then a `${UNSET_NAME}` | `deploy --dry-run` printed `Ignored .env next to compose.yaml (Tug reads values only from control)`, and the unset name was refused with the three ways to set it |
| Control recovery on another host | A manual `tug control backup` to the Vultr bucket, the old control stopped, a new 3.0.0 control on a second VM, `control restore --from-destination … --password-stdin` (a dry run first, then `--confirm`), a restart, then `node replace` for each node | The dry run reported 6 projects, 2 nodes and 17 secrets. After the restart the restored control listed all six projects and the backup catalog, both nodes showed `stale` and then `online` after `node replace`, and a deploy through it built an image and updated Express. The sites served throughout, and the PHP hit counter kept growing |

Two more findings from these runs:

12. **There is no `tug` command to stop or restart control.** Isolating the old control needed `docker stop` over SSH, and the restart that `control restore` asks for (`restartRequired: true`) was done with `tug control upgrade <host> --force -y`, which works but is not what the restore output suggests. `tug control stop` and `tug control restart` now cover both, see [`tug control stop` and `tug control restart`](cli.md#tug-control-stop-and-tug-control-restart).
13. **The default version label comes from the Compose file only.** A source change under `build:` (v1, v2, v3, v4 of the Express app) printed `git-25bdc82f8359` every time, so the deploy summary and `status` cannot tell the builds apart. It is documented for `--version` but easy to misread in a rollback line.

### Merged main on the same hosts, 16 November 2026

The image built from `ca456aa` (the merge of the papercut fixes) replaced control and both agents with `tug control upgrade --image` and `tug node upgrade --image`. There was no Docker daemon on the operator machine for `--build-local-image`, so the image was built with `docker build` on the control VM and copied to the nodes with `docker save | docker load` over SSH. Control was the restored one from the recovery drill, and the nodes had been repointed to it.

| Check | What was done | Result |
|---|---|---|
| `tug doctor --nodes` | Healthy hosts | The local Docker check printed `skip  docker  needed only for --build-local`. `ingress_ports` printed `80, 443 open on n1, n2`. Control and each node listed load, memory, disk under `/var/lib/docker` and agent, Caddy and control container CPU and memory (agent 46 to 54 MiB, Caddy 30 to 36 MiB, control 60 MiB, matching the `docker stats` samples above) |
| Port probe | `ufw` rules for 80, 443 and the private subnet removed on n1 | `doctor` failed with `port 80 on ingress node n1 (10.50.0.4) did not answer`, named `ufw` and gave the `ufw` and `firewalld` commands. Control's probe uses the node's inter-node address, so a firewall that filters only the public address is not caught, as the docs say. This run removed the subnet rule too, so it tested the host firewall case only |
| `tug ingress tls` and `tug ingress logs` | A new hostname mapped with `tug domain add` while ports were blocked | The host showed `failed` with Let's Encrypt's text `Timeout during connect (likely firewall problem)`, and `tug ingress logs n1 --tail 5` returned Caddy's ACME lines through the agent. With the ports open `doctor` reported no problems again |
| `tug control stop` and `restart` | On the control VM | Control stopped (`status` timed out), the Express site kept answering 200, and after `restart` both nodes were `online` |
| Host key refusal | `known_hosts` entry for n1 swapped for a bogus key (file restored byte for byte afterwards) | `tug node upgrade` printed `Host key verification failed.` followed by tug's explanation, the `ssh-keygen -R <host>` remedy and `tug never edits known_hosts or turns off host key checking for you` |
| Duplicate host port | A project publishing 8080 on n1, where `phpdb` already did | Both `deploy --dry-run` and `deploy` returned `409 … host port 8080 on node n1 (10.50.0.4) is already published by web in project phpdb` in under a second, where the same mistake earlier failed after a 2 min 18 s build |
| Cross-node names | `client` on n1 and `api` (nginx, published 8090) on n2 in one project | `getent hosts api` on n1 gave `10.50.0.5` and `wget http://api:8090/` returned the nginx page. Rocky's `firewalld` needed the private subnet in its `trusted` zone, set by hand |
| Reboot of both nodes | `reboot` on n1 and n2 at once | Express answered 200 again 55 s after the command, and after a few minutes all seven sites, all seven projects (`serving`) and the nodes were back with no tug command. The MariaDB hit counter had kept its data (72) |
| Reboot of control | `reboot` on the control VM | The sites kept serving, control answered again about 1.5 minutes later, both nodes were `online` and the backup catalog was intact |

Two things the run showed that the unit tests could not:

14. **Every ingress node reports `failed` for the other node's hosts.** `tug ingress tls` listed `django.108-61-164-220.sslip.io` as `failed` on n1 and `php.95-179-141-193.sslip.io` as `failed` on n2, because each Caddy requests certificates for every project's host. On a healthy two-ingress setup `tug status` keeps saying `3 hosts have no certificate yet (tug ingress tls)` on both nodes, although `doctor` reports no problems. This is the P7 behavior, now visible in tug's own output. `x-tug.ingress.nodes` now names the ingress nodes that serve a route, and the other nodes render nothing for it ([Several ingress nodes](ingress.md#several-ingress-nodes)). With the key set on all six projects, `tug ingress tls` listed three `issued` hosts per node and none of the other node's, `tug status` no longer printed the certificate count, `tug doctor --nodes` reported no problems and all six sites answered 200. A first attempt set the wrong node on every project through a shell mistake: control rendered each host only on the node named, so those hosts stopped answering until the key was corrected, which is the documented effect of naming a node the DNS does not point at.
15. **Nothing in tug sets or checks the firewall rules that cross-node traffic needs.** The rules for 80, 443 and the private subnet on the Debian and Rocky nodes were added by hand over SSH, and a node that blocks the subnet gives no tug message until a service on another node cannot connect.

### Not covered

- All sites share two small nodes, so the Caddy figures show how the ingress behaves on 2 vCPUs, not how it scales.
- ARM hosts, Fedora and Debian 13 were not provisioned.
- The direct-port numbers needed `ufw allow from 10.50.0.0/24` on Debian and the `trusted` zone for that subnet on Rocky, set by hand over SSH.

## Local QEMU acceptance checks, 15 November 2026

Disposable Ubuntu 24.04.5 arm64 guests ran under QEMU 11.1.3 with HVF on Apple Silicon. The base cloud image matched its publisher's SHA-256 checksum file; the checksum file was not signature-verified. Recovery used a runtime built from checkout `75d8a354` inside a guest because the host Docker daemon was unavailable. These checks used local virtual networks and storage, with outbound access for packages and images.

| Check | Result | Evidence and limits |
| --- | --- | --- |
| First-boot enrollment | Passed in 63 seconds | `qemu-first-boot.js` ran control from the checkout and enrolled an agent using published `ghcr.io/wpelevator/tug:3.0.0`. Cloud-init finished and the node reported online. This did not test a candidate-built agent. |
| Legacy 1.2.0 migration and candidate deploy | Passed in resumed stages | The initial run completed ten checks before a stale harness probe used the v3 CLI against v1.2 control. The matching v1.2 CLI confirmed the migrated control was healthy. After correcting that probe and upgrading control before the node, nine continuation checks passed: candidate images ran without Compose, the CA and node key survived, and service data and the secret remained. A stale `env_file: []` fixture then blocked deploy. Removing it allowed four final checks to pass, including delivery of a control variable, ignoring `.env`, refusal of a required value present only in `.env`, and retained volume data. The corrected runner was not rerun uninterrupted from a fresh disk; this was a split rehearsal on the same guest state. |
| Named-volume backup and in-place restore | Passed | A named volume was backed up to a disposable RustFS S3 destination, then its marker file was overwritten. `restore run site --confirm` completed its safety backup, restore and verification. The marker's SHA-256 changed from `88c91602…` to `089d71c5…` after overwriting, then returned to `88c91602…` after restore. This checked file content, not a database restore or replacement workload host. |
| Control recovery onto fresh storage | Passed; fresh-VM runner completed in 86 seconds | The original guest was stopped. A fresh independent disk received the candidate runtime image, the downloaded control archive and separately retained operator credential. Restore preview verified one project, one node and two secrets. After restore and restart, the original credential read the restored project and node, the backup catalog retained the workload snapshot, and the temporary bootstrap credential was rejected. Workload data and agent reconnection were not part of this check. |
| Truncated control archive | Rejected without replacing active state | Restoring a truncated archive with `--confirm` returned HTTP 400, `zlib: unexpected end of file`, and `restartRequired: false`. The original credential still read the same project state afterwards. This tests archive validation, not restic repository corruption or interrupted activation. |
| Unrelated rollback during a held build | Contention reproduced in a local control test | A scratch test held a fake image build for project A while requesting project B's rollback. Rollback remained pending for the 503 ms observation window and completed after release. This demonstrates shared-writer queueing; it is not a real Docker build measurement or a production latency bound. |
| Local regression suite | 1,132 tests passed | The initial run had two keyboard-menu test timeouts under `TERM=dumb`. Their child-process environments were made explicit with `TERM=xterm-256color`; both targeted tests and the full suite then passed with the parent still using `TERM=dumb`. |

The empty `env_file: []` fixture exposed a diagnostic defect: the rejection suggests `tug secret import undefined`. The fixture was removed from the upgrade runner because v3 refuses `env_file`; the product diagnostic was not changed.

Interrupted control activation, corrupted repositories, workload recovery on a replacement node, database content recovery, network partitions, migration into staging, monitoring-system integration and public DNS/ACME were not exercised in this run. The recovery drivers were scratch scripts; only first boot and the upgrade rehearsal have committed QEMU runners. Keep these results separate from automated coverage of those missing scenarios.

## Reliability control smoke on QEMU, 16 November 2026

A disposable Ubuntu 24.04 arm64 cloud guest enrolled through cloud-init against the current source control process with JSON logging. The official image matched its published SHA256SUMS; the checksum file was not independently signature-verified. The harness reported enrollment and successful authenticated readiness and node-report metrics over mTLS at 115 seconds. The guest used the published agent image, so this run establishes current control behavior and enrollment compatibility, not validation of the modified agent logger or a workload restore. The harness cleans up the guest and control processes by default.

```sh
TUG_LOG_FORMAT=json node tools/scripts/qemu-first-boot.js --image /tmp/tug-sre-vm/ubuntu-24.04-server-cloudimg-arm64.img --work /tmp/tug-sre-vm/final --port 18444 --ssh-port 12223 --timeout 600 --verify-reliability
```

```text
[ 115s] SUCCESS: first-boot cloud-init enrolled the node
[ 115s] SUCCESS: authenticated readiness and node-report metrics verified over mTLS
```

The new damaged-repository backup drill was not executed: this host has a Docker client but no daemon socket. Unit-level injected disk exhaustion and interrupted activation tests supply narrower failure evidence; they do not substitute for a Docker or physically full-host exercise.

## Source-built agent logging on QEMU, 16 November 2026

A second disposable Ubuntu 24.04.5 arm64 guest ran Docker 29.10.0. After published-agent enrollment and readiness/metrics checks, the current source was packaged from explicit Dockerfile inputs, built inside the guest, and used to replace only its agent while preserving the state volume, socket bind, networking and restart policy. The source-built agent emitted valid JSON startup records and remained online and connected to the throwaway control. Debug failure checks inside that image confirmed that synthetic bearer/basic credentials, cookie/token values, URL credentials/query strings and control characters were excluded from the diagnostic cause. These checks exercise known patterns, not arbitrary application-secret recognition.

The built image was `sha256:863017764465b231d38e770ac53ed9fef625d711da4f9d86f3f4f190ce6b3b29`. Its logger SHA-256, `5f6be459cf42d4dcfd6d760e57d1e3ef7d3daae603a5d905792cc4e0abfd38a5`, matched the pushed logger source. The source archive SHA-256 was `e4e8f8f3afc1cdabc10ce83e44c750928e52d6894a7b639ff7032ccdaea212e8`. The guest, throwaway control, rollback container, temporary credentials and build artifacts were removed after verification.

The damaged-repository backup drill also [passed in CI](https://github.com/wpelevator/tug/actions/runs/43955052052) after its root-owned config fixture was corrected. That run passed the complete Node and integration matrix; it supplies Docker evidence in addition to the local injected-failure tests.

## 4.0 reliability on QEMU VMs with rest and append-only destinations, 22 November 2026

A restore drill of the 4.0 backup changes (destination check, retention contract, `backup unlock`, weekly maintenance, restore cleanup) against restic's `rest-server`, plain and `--append-only`, plus an in-place upgrade from the published 3.1.0. Everything ran from commit `d314948` (`feat/4.0-reliability`, PR 157) with one addition: the harness `tools/scripts/qemu-drill-vm.js` was untracked in the working tree when the images were built, and the Dockerfile copies `tools/scripts`, so the images carry that file, which neither control nor the agent loads. The CLI ran from the same checkout as `node src/cli.ts` (`src/main.ts` is the runtime entry, not the CLI). Control and agent images were built with `--build-local-image` and report version `3.1.0`, because the version bump from the changesets has not been applied on the branch.

| Part | Setup |
|---|---|
| Host | macOS 27.2.1 on Apple Silicon, QEMU 11.1.3 with HVF, Docker Desktop on the laptop |
| VMs | Ubuntu 24.04.5 arm64 (official cloud image, SHA-256 checked against the publisher's `SHA256SUMS`, which is not signature-checked), kernel 6.8.0-147, Docker 29.10.0, QEMU user networking. `vm1`: 2 vCPU, 4 GB, control and node `app1` for part A and the lock and weekly-maintenance rows of part B. `vm2`: 2 vCPU, 3 GB, control and node `app1` for part C and the rest of part B |
| Destination | `restic/rest-server:latest` (0.14.0, `sha256:d2aff06f…`, arm64) on the laptop's Docker with basic authentication from an `.htpasswd` file, reached by the VMs at `http://10.0.2.2:18000`. Plain for part A, restarted with `--append-only` for part B (the data directory persists across restarts), so this is HTTP over a private link, not TLS |
| restic | `restic/restic:0.19.1`, `sha256:136600b6…`, the same digest on the laptop and on both VMs |
| Project | A MariaDB 11.4 service with a `command` backup (`mariadb-dump`, `verify: "-- Dump completed"`, a `restore` command) and a named volume `uploads` mounted by an Alpine service, retention `last: 3`. Before the first backup the database held marker rows and the volume held files (1 MiB of random data, a token file and a nested file on `vm1`), whose SHA-256 sums were recorded. The `vm1` project is named after the worktree directory (`agent-a2582ec0…`) because `tug setup` ran from the checkout; on `vm2` it is `drillc` |
| Published 3.1.0 | `@wpelevator/tug@3.1.0` from npm in a clean directory and `ghcr.io/wpelevator/tug:3.1.0` (`sha256:1dac2a70…`) |

The images came from the checkout: control on `vm1` `tug:local-4124f424a798`, its agent `tug:local-a638639e9187`, and on `vm2` control `tug:local-c6e794e5ea38` and agent `tug:local-265a2aa0ce3b` (two builds of the same tree have different image IDs).

### Part A: plain `rest:` destination

| Step | Result |
|---|---|
| `tug backup destination set rest:http://10.0.2.2:18000/tug --env RESTIC_REST_USERNAME --env RESTIC_REST_PASSWORD` | Saved and checked in one run: `_control` and the project repository `initialized` (which also shows the credentials can write), node `app1` `missing` (the first backup creates it), exit 0 |
| `tug backup destination check` | Exit 0: `ok` for `_control` and the project from control's host, and `reaches the destination` for the node |
| `tug backup run` (database dump and volume) | Both succeeded in about 6 seconds (volume 1.0 MiB added, dump 3 KiB) |
| `tug control backup`, `tug control backup list` | Succeeded (a 12 KiB snapshot in `_control`) and the list read the snapshot from the destination |
| `tug backup list --check` | Exit 0 |
| `tug backup verify` and `--control` | Both finished within 20 seconds. `list` then showed `verified` on both targets and `verify ok (…, manual)` on the repository and control |
| Database restore: `tug restore run db` | Refused by the plan: `no services were found that write to service:db … pass --writers … or --no-writers`, as the docs describe. With `--no-writers` the plan named `service:db on app1` and the snapshot and changed nothing, and `--confirm` succeeded. The database had been changed (rows deleted, another inserted) and the three marker rows matched the recorded ones afterwards |
| Volume restore: `tug restore run uploads --confirm` | Went through `holding`, `safety_backup` and `restoring` to `succeeded` after the volume had been changed (a file removed, one overwritten, a directory removed); the three SHA-256 sums matched the recorded ones |
| `tug restore run uploads --scratch --confirm` | `succeeded` into `tug_r23_…_r_<id>`. A read-only container on the VM mounting that volume produced the same three SHA-256 sums, and `restore list` showed the volume |
| `tug restore remove` of the scratch restore and of the database restore | Removed the scratch volume (gone from `docker volume ls`) and forgot the database safety snapshot on the plain server; `restore list` then showed only the volume's safety snapshot |
| Retention on the plain server | After several more manual backups `restic snapshots` listed only the newest three manual database snapshots, with the volume's `trigger:pre-restore` snapshot kept, and `list --check` exited 0 |
| Weekly maintenance | The scheduler first picks a repository a week after seeing it, so the next-due record in control's `meta` table (`backup_maintenance_next:<project>`) was set to the past inside the VM. Within one 30-second tick the job ran with `trigger: schedule` and `list` showed `verify ok (…, pruned)` (`prune: ok`, `check: ok`) |

**Stale lock, created by killing a restic mid-forget.** tug has no restic passthrough, so a helper script started `restic forget --keep-last 1 --prune` (restic 0.19.1) in a container on the laptop's Docker against the project repository, paused the rest-server the moment a file appeared in the repository's `locks/` directory, sent restic SIGKILL and unpaused the server. The repository then held one exclusive lock from a restic that could not release it. The same was done to `_control`.

| Step | Result |
|---|---|
| `tug backup run db` | Failed after about 5 seconds, not after the documented ten-minute lock wait: `repository check failed: unable to create lock in backend: repository is already locked exclusively by PID 1 on <container id> … lock was created at … (10.736905644s ago) … (run tug backup unlock to remove stale locks)`. The `backup.failed` event had `cause: "locked"`, `backup list --json` had `cause: "locked"` and a `lock` object on the target, `backup list` printed `REPOSITORY LOCKED`, and `backup list --check` exited 1 with `PROBLEM service:db: the last run failed: the repository is locked, run tug backup unlock to remove stale locks` |
| `tug control backup` against the locked `_control` | Exit 1, `502 … repository check failed: unable to create lock in backend: …`. The `control` object in `backup list --json` had `cause: null` and `lock: null`, the problem line carried no `tug backup unlock --control` hint (see Findings), and `list --check` exited 1 |
| `tug backup unlock` at 49 seconds | `502 … repository check failed: unable to create lock in backend: …` |
| `tug backup unlock` and `tug backup unlock --control` at 31 minutes 21 seconds and 30 minutes 53 seconds | **Both failed the same way**: `502 … repository check failed: unable to create lock in backend: repository is already locked exclusively … (31m21.433993222s ago)`. restic's own `restic unlock` on the laptop then removed the lock at about 32 minutes with `successfully removed 1 locks` (see Findings) |
| After the manual `restic unlock` | The next `tug backup run` and `tug control backup` succeeded and `list --check` returned to 0 |

### Part B: append-only

Run on `vm2` (project `drillc`) with the server restarted as `rest-server --append-only`, after part C. The weekly-maintenance rows ran on `vm1`.

| Step | Result |
|---|---|
| `tug backup run` with the default `managed` retention | Both targets succeeded and `list` showed `retention failed (1 run)`; after one failure `list --check` still exited 0, and after the second run (`retention failed (2 runs)`) it exited 1 with `PROBLEM … retention is failing, so old snapshots are not removed (it failed in 2 runs in a row)`. `backup list --json` had `retention: {state: "failed", failures: 2, message: …}` on targets and on the run, and one `backup.retention_failed` event per target, on the first failure only. restic's own output for the failed delete is `Remove(<snapshot/…>) failed: unexpected HTTP response (403): 403 Forbidden` (see Findings for what tug shows) |
| `tug control backup` the same way | Retention stayed `ok` for the first three runs (the repository held few snapshots, so nothing needed forgetting). The fourth run, which made five snapshots, showed `retention failed (1 run)` with `backup.retention_failed` on `_control`, the next run made it two failures, and every backup itself succeeded |
| A command backup that fails after output (`echo partial-output; exit 3`) | `service:db: failed (the command exited with code 3 (the partial snapshot could not be forgotten): )`, as documented for an append-only server |
| `tug backup destination set rest:http://10.0.2.2:18000/tugc --retention external` (no `--env`) | Saved, the check passed and `show` kept `envNames` (`RESTIC_REST_PASSWORD`, `RESTIC_REST_USERNAME`) and printed `retention: external` |
| `list --check` right after that | Still exit 1 with `retention failed (2 runs)` on the targets and control, until the next backup (see Findings) |
| After `tug backup run` and `tug control backup` | `list` showed `retention external` on control and both targets, `--json` had `retention: {state: "external"}`, `--check` exited 0 |
| Restore on the append-only server | Database in-place restore, volume in-place restore and a scratch restore all `succeeded`, with the marker rows and SHA-256 sums matching; each in-place restore left its safety snapshot |
| `tug restore remove --expire-safety 1m` and `tug restore remove <in-place restore>` | Both exit 1 with `409 {"error":"the destination is append-only (retention external), which refuses deletes, so tug cannot forget a safety snapshot; remove it from the storage side with restic forget, with credentials that may delete (the repository and password come from tug backup password)"}`. `restore remove` of a scratch volume still worked |
| Weekly maintenance, `managed` and append-only (`vm1`) | With nothing to free, the prune succeeded (no delete was attempted). After two snapshots were forgotten by hand on the plain server so that a prune had files to remove, and the server was restarted append-only, the scheduled job failed: `backup.verify_failed` with `prune failed: Remove(<index/…>) failed: unexpected HTTP response (403): 403 Forbidden`, `list` showing `verify FAILED`, and `--check` exit 1 |
| `destination set … --retention external` then `tug backup verify` (`vm1`) | `--check` stayed 1 until the verify ran, then returned to 0 with `backup.verify_recovered`. With `external` the scheduled job on `vm2` ran with `prune: skipped` and `check: ok`, and `backup verify --read-data-subset 5%` finished `ok` with `subset: 5%` |

### Part C: upgrade from 3.1.0

`vm2` first ran control and the node from the published 3.1.0 CLI and image (`tug setup`, `node add`, a deploy, a `rest:` destination, a `backup run`). `tug backup destination set` on 3.1.0 printed no check. `tug backup run` succeeded for both targets, while `tug control backup` failed with `repository check failed: Fatal: repository does not exist: unable to open config file: <config/> does not exist` for `…/_control/`, so `backup list --check` exited 1 on 3.1.0 before any upgrade. Two marker rows and two files (a token and 512 KiB of random data) were recorded. The upgrade was `tug control upgrade --build-local-image -y`, then `tug node upgrade app1 --build-local-image`.

| Check | Result |
|---|---|
| Control upgraded, agent still the published 3.1.0 | The node stayed online, the deployment `serving`, and `backup list` and `--check` worked from the new control (still with the `_control` failure) |
| Agent upgraded | Reported within seconds, `status` unchanged, containers kept running |
| `backup password --json` | Same password as before the upgrade (the new response adds `deployed`) |
| Control database | `PRAGMA user_version` 3 and 22 tables on both the upgraded `vm2` control and the fresh `vm1` control. Not compared with a copy taken before the upgrade |
| `tug backup destination check` | Created the `_control` repository (`initialized`) that 3.1.0 had failed on, `ok` for the project, exit 0 |
| `tug control backup`, `tug backup run`, `list --check` | Succeeded, exit 0, retention `ok`, schedules and next-run times intact |
| Restores | In-place restores of the newest snapshots matched the recorded SHA-256 sums and marker rows. `restore run db --from <3.1.0 run>` brought the marker rows back, and a scratch restore of the 3.1.0 volume snapshot `succeeded` (its contents were not hashed) |
| The published 3.1.0 CLI against the branch control | `status` and `backup list` worked. Run JSON no longer carries `metadata_json` and has `retention`, `cause` and `warnings` instead, as the upgrade note says. The note's claim that a 3.x CLI is refused by a 4.0 control could not be tested: both report `3.1.0` |

### Findings

The original run is of commit `d314948`. Findings 1 to 5 were defects and are fixed on the branch (the rerun below shows each on the fixed head); finding 6 is the 3.1.0 behavior that 4.0 already corrects.

| Finding | Status |
|---|---|
| 1. `backup unlock` cannot remove an exclusive stale lock | Fixed: every repository probe reads the config with `--no-lock`, and `unlock` runs plain `restic unlock` |
| 2. A locked control repository is not reported as locked | Fixed: the probe failures carry restic's exit code, and the probe no longer meets the lock first |
| 3. The retention message is a stack tail | Fixed: restic's meaningful lines are kept, stack frames are dropped, and a 403 or append-only refusal names `--retention external` |
| 4. The probe does not wait for a lock | Fixed: the probe takes no lock, and `snapshots`, `dump`, `restore` and the partial-snapshot `forget` wait with `--retry-lock 10m` like `backup` |
| 5. Old retention failures stay after `--retention external` | Fixed: switching clears them for projects and control and records one `backup.retention_recovered` each |

1. **`tug backup unlock` and `tug backup unlock --control` cannot remove an exclusive stale lock.** Reproduce: kill a restic during `forget --prune` as above, wait more than 30 minutes, run `tug backup unlock`. It exits 1 with `502 {"error":"repository check failed: unable to create lock in backend: repository is already locked exclusively by PID 1 on … | lock was created at … (31m21.433993222s ago) …"}`, and `--control` with `cannot read the control repository: unable to create lock in backend …`. `restic unlock` run directly about 30 seconds later removed the lock (`successfully removed 1 locks`). The job runs `restic cat config` before `restic unlock` (`src/backup/job.ts`, and `src/backup/control-backup.ts` for control), and restic takes a repository lock for `cat config` that an existing exclusive lock refuses, even a stale one, so the documented fix in [Unlock a repository](backups.md#unlock-a-repository) cannot work for the lock a killed forget or prune leaves. The unlock job should skip the probe or open the repository with `--no-lock`.
2. **A control backup that fails on a lock is not reported as locked.** In the same state the project reported `cause: "locked"`, a `lock` object and the `tug backup unlock` hint, but `control` reported `cause: null`, `lock: null` and a problem line without a remedy, and the `backup.failed` event for `_control` had no `cause`. The `ControlBackupError` thrown for the failed probe in `src/backup/control-backup.ts` carries no exit code, so `jobCause` is never set. The docs say the same fields apply to control.
3. **The retention failure on an append-only server shows the tail of a Go stack trace, not the cause.** The stored message is the last 300 characters of restic's output (`.slice(-300)` in `src/backup/job.ts`), and restic ends the output of a failed forget with a stack. For a project the message and the `PROBLEM` line read `to remove one or more snapshots`, then `main.init`, `/restic/cmd/restic/cmd_forget.go:67`, `runtime.doInit1` and the rest of the stack on separate lines (the word `failed` before `to remove` is cut off); for control it was `runtime.main | /usr/local/go/src/runtime/proc.go:258 | runtime.goexit | …`. The line that explains it, `Remove(<snapshot/…>) failed: unexpected HTTP response (403): 403 Forbidden`, is dropped, and nothing points at `--retention external`, although the docs call the failure "the signal to set it". The weekly job's `backup.verify_failed` message keeps the 403 line and reads clearly.
4. **The 10-minute lock wait does not apply to the repository probe.** `restic cat config` runs without `--retry-lock`, so a backup against a repository whose exclusive lock was 10.7 seconds old failed after about 5 seconds with `cause: "locked"`, where [Jobs on a node](backups.md#jobs-on-a-node) says it waits up to ten minutes. This run used a dead lock, not a live prune, so whether a backup that meets the weekly prune of another node fails the same way, turning `list --check` red on one overlap, was not exercised.
5. **After `destination set --retention external` the old failures stay until the next backup.** `list --check` exited 1 with `retention failed (2 runs)` on control and both targets until the next backup of each, and no `backup.retention_recovered` event appeared in `tug events` when the state became `external`. The docs say an `external` destination "never reports one". It is cosmetic if the next backup follows soon, but the first `--check` after the switch fails.
6. **3.1.0 could not create `_control` on a `rest:` destination** (part C). That is the behavior the exit-code detection in 4.0 fixes, and the 4.0 `destination check` created the repository after the upgrade. It is listed so a 3.1.0 installation on `rest:` is not read as already protected.

### Rerun on the fixed head

Rerun on 22 November 2026 from commit `ede9541` (`fix/pr157-drill-defects`, pushed to `feat/4.0-reliability`), with a clean working tree: `git rev-parse HEAD` printed that commit before the images were built and after the run. One Ubuntu 24.04 arm64 VM (the same cloud image, 2 vCPU, 4 GB), control and node `app1` on it, both images built with `--build-local-image`, driven by `node src/cli.ts` from the checkout with a private `XDG_CONFIG_HOME`. The destination was `restic/rest-server:0.14.0` started with `--no-auth` on the laptop (plain, restarted with `--append-only` for the retention rows), so this run did not use the `.htpasswd` authentication of the original. restic was 0.19.1. The project was a MariaDB `command` backup and a volume with `retention: last: 3`. The VM, the server and the helper containers were removed afterwards.

| Defect | What was observed on the fixed head |
|---|---|
| 1. Unlock of an exclusive stale lock | A helper container on the laptop ran `restic prune` against each repository and was killed right after its lock file appeared (the server was paused for that instant), leaving an exclusive lock in `_control` and in the project repository. `tug backup unlock` and `tug backup unlock --control` at 49 seconds answered `removed: 0, remaining: 1` with the note that the lock has not gone stale yet, where the original run answered `502`. At 32 minutes 49 seconds both answered `removed: 1, remaining: 0`, the `locks/` directories on the server were empty, and the next `tug backup run`, `tug control backup` and `tug backup list --check` succeeded (exit 0). The lock was made stale by waiting out restic's 30 minutes, as in the original run |
| 2. Control lock classification | With the same exclusive lock in `_control`, `tug control backup` waited for the lock and then failed. `backup list --json` had `control.cause: "locked"`, `backup list` printed `REPOSITORY LOCKED` for control, the problem line ended with `(run tug backup unlock --control to remove stale locks)`, and `--check` exited 1 with that line. The CLI call itself gave up after 300 seconds with `could not reach control … UND_ERR_HEADERS_TIMEOUT` while control kept waiting for the lock (about ten minutes), so the failure was read from `backup list` afterwards. Found in this drill and handled afterwards in the CLI: it now waits up to 35 minutes for the answer and, past that, says the backup may still be running or waiting for the lock and points at `tug backup list`. That change is covered by a CLI test with a control that never answers; it was not rerun in a VM |
| 3. Append-only retention message | Against `rest-server --append-only`, after five backup runs of each target and five control backups (the first runs had nothing to forget), `backup list --check` exited 1 and the `PROBLEM` lines for the project and for control contained `Remove(<snapshot/…>) failed: unexpected HTTP response (403): 403 Forbidden` and ended with `(if the destination is append-only, run tug backup destination set --retention external, …)`, with no stack frames. The line is kept with the other lines restic printed before the stack, so a message can start mid-sentence with `unable to remove snapshot/…` |
| 4. Backup waiting for a short-lived lock | An exclusive lock was left in the project repository and removed from the server's data directory 25 seconds later while `tug backup run service:db` was running. The run stayed `running`, then succeeded and returned after 43 seconds (the original failed after about 5). A run against the lock that was never removed failed after 10 minutes 14 seconds with `cause: "locked"` and the `tug backup unlock` hint, so the documented ten-minute wait applies |
| 5. `--check` after `--retention external` | After the retention failures above (`retention failed (4 runs)` on both targets, `(3 runs)` on control), `tug backup destination set <url> --retention external` made `backup list` show `retention external` for all three and `--check` exit 0 at once, with no backup in between. `tug events` had one `backup.retention_recovered` for each target and, with `--project _control`, one for control |
| Regression, plain `rest:` | `destination set` (check: `_control` and the project `initialized`), `backup run` and `control backup` succeeded, `--check` exit 0. After a file was removed and another overwritten, `tug restore run uploads --confirm` brought back both with the recorded SHA-256 sums, and after the three marker rows were deleted `tug restore run db --no-writers --confirm` brought back the three rows |

Not rerun: the upgrade from 3.1.0, the weekly maintenance and `backup verify`, the scratch restore, `restore remove` on an append-only server, TLS or authenticated servers, and a lock held by a live prune or forget overlapping another node's backup (the locks here were left by killed restics, and the short-lived one was removed by hand). The unit and real-restic tests added with the fixes are the checks for the paths the rerun did not drive, for example that the `restore`, `snapshots` and `dump` commands carry `--retry-lock`.

### What this does not show

- TLS, a `rest-server` with bcrypt users or `--private-repos`, a remote or hosted server, or `rest:` reached through a VPN. The authentication was an `.htpasswd` file with a SHA hash (an `apr1` hash was rejected with 401 for the correct password, which was not investigated).
- One node per control and small data (a 1 MiB volume, a dump of a few KiB), so no timing here is a recovery-time claim. No second node, no amd64, no control restore from the destination and no restore of `_control`.
- A live prune or forget overlapping another backup (finding 4), `backup cancel`, the interactive pickers, `TUG_RESTIC_IMAGE` overrides, an append-only server holding many snapshots, and pruning from the storage side with credentials that may delete (only a `restic forget` of two snapshots on the plain server was done by hand).
- The upgrade note's claim that a 3.x CLI is refused by a 4.0 control, because the branch is not yet versioned 4.0, and a database comparison before and after the upgrade.
- The published 4.0 image and CLI, which do not exist yet.

The drill used its own VMs and a rest-server on the laptop, all removed afterwards, and nothing in the main checkout. `git rev-parse HEAD` printed `d314948bf889a3b56f61a6f900b588202704ef52` before and after the run.
