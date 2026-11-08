# Real-host evaluation, 31 October 2026

Two WordPress sites on the existing test hosts, using the current CLI against the control plane already running there. This is an operator trial, not a passing CI job. The roadmap's WordPress picture was the target. What the tool can deploy today is a smaller thing, and the gap shows up as soon as you follow a normal Compose file.

## Result

Both sites are installed and serving over public HTTPS.

**Version context.** The trial ran on the earlier runtime. Its control API was plain HTTP on port 8080 with bearer tokens, `/healthz` was unauthenticated, agents applied each project by running `docker compose up` on the node, and cross-node names were called service DNS. The current implementation differs: control serves a single mutual-TLS port (`8443`) with certificates from its own CA and no unauthenticated route, agents use the Docker Engine API with no Compose plugin on nodes, and the feature is called cross-node service names (hosts-file entries). Statements below about HTTP, port 8080, tokens, Compose behavior and `/healthz` describe the trial hosts, not the current product; [Control plane](control-plane.md), [Nodes](nodes.md) and [Architecture](architecture.md) describe the current one. All references to WireGuard, mesh membership, overlay addresses, `--mesh`, `TUG_MESH` and `node-rotate-wg-key` likewise describe the removed Tug-owned mesh implementation, retained only as historical evidence; they are not current capabilities or tests that still apply. Findings are kept as evidence, not rewritten.

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

### Cross-node service names (then called service DNS) do not get you a remote database

Names injected with `extra_hosts` point at the node address, and the client must use the published host port. A MariaDB that is not published is reachable only on the Compose network, which means the same node. Publishing `3306` so WordPress on the other node can use the name puts the database on an address the mesh can route to. Binding it to the overlay IP only is the same undocumented trick as the app port. The generated `wp2` compose file had no `extra_hosts`, which is correct: both of its services are on `edge`.

So the deployable WordPress shape is app and database on one node, one project per site. The original specification's shape, app nodes talking to a database node over a service name, is not the shape this tool deploys. Copying that example fails for more than missing nodes. It uses `domains`, `upstream`, `upstreamProtocol`, `sticky`, and `type: shared` / `driver: nfs`. Current validation accepts `placement`, `replicas` (must equal the node count), `health`, `ingress`, and `rollout`. The rest is either ignored or not implemented. At the time of this evaluation M6 (label placement, `replicas: N` spread) and M7 (NFS docroot) were not built; both are implemented now but unvalidated on real hosts. Ingress is an HTTP reverse proxy, not FastCGI.

Rolling the WordPress container would be the wrong next step. A rolling revision publishes a different host port and shares the named volume with the old revision. Two PHP processes on one `wp-content` is how you corrupt uploads. The rollout docs say volumes are shared and that databases should stay on `recreate`. They do not say that about a PHP docroot. I left both sites on recreate.

### Secrets and environment are easy to get half-right

A value that is not exactly `${NAME}` makes Tug treat the environment key as a secret name. `WORDPRESS_DB_HOST: db` does not require a secret, and the literal is what the container gets. A project secret with that same name would also be released to the node and written into `.env`. The `.env` writer does not quote values. A password containing `#`, `$`, a space, or a newline breaks interpolation. Nothing in the secrets section says "use a substitution for the password, a literal for the hostname, and keep the password free of compose metacharacters." I used hex passwords because I had read `writeEnv`, not because the docs told me to.

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
5. Say in the README that the plan.md WordPress stack is not deployable yet, and point at the example that is. (Done differently: plan.md was removed and the roadmap describes the topology Tug targets.)

I would not treat this run as evidence for rolling deploys, image build, or rollback. Those were not on this path. I would treat it as evidence that a person can get two real sites up, and that the first failure still requires SSH.


## M6, M7 and enrollment on fresh hosts

**Removed mesh implementation:** the commands, flags, environment variables, overlay addresses and packet-path results in this section are historical. Tug no longer provides that mesh, and these mesh checks are not a current validation baseline.

31 October 2026, on the same two Ubuntu 24.04 droplets (1 vCPU, 1 GB, amd64, a shared VPC), after wiping both: containers, volumes, images, `wg0` and all Tug state. Control ran on 142.93.140.20 with `TUG_MESH=true`. The Tug image was built for amd64 from the branch and loaded with `docker save`.

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
- **Closed by removal: NFS needed host preparation Tug does not do.** The exporter needed an NFS server and `/etc/exports`, consumers `nfs-common`. The `nfs` volume type was removed rather than growing a host installer.
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

The `examples/wordpress` project on two freshly reimaged 1 GB droplets, with the runtime built from the branch (`tug:local`, amd64) and nothing else on the hosts. The hosts were Ubuntu 26.04.1 LTS, newer than the 24.04 of earlier runs. Control and node `app` ran on `tug-1` and node `app2` on `tug-2`. The same example was deployed twice: as project `blog` on `app` and as project `shop` on `app2`, each with its own database and uploads volume. Backups went to an S3-compatible server (`rustfs`) that Tug itself deployed as a third project (`storage`) on `app`, reachable only on the private network. This is an operator trial, not a CI job.

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
- **Named volumes need no ownership fixing.** The S3 server runs as uid 10001. As a bind mount it failed with `Permission denied`; as a named volume deployed by Tug it started cleanly.
- **Scratch-restore volumes are left behind**, as documented. They were removed by hand.

Not covered by this run: a real AWS S3 bucket (the S3 server is `rustfs`, which speaks the same protocol), a failing backup on a real host (`backup list --check` was only seen exiting 0 here; its failing path is covered by unit tests), a control restart or a long control outage, a node behind NAT, ingress and certificates (the hosts had no DNS names, so the sites were reached on their private addresses), and a project that spans both nodes.

## Recovery drill with the published 0.9.0 release, 2 November 2026

Two disposable amd64 Ubuntu hosts were used. The published npm CLI and `ghcr.io/wpelevator/tug:0.9.0` image ran control and the original agent on one host; an agent on the other host served as the replacement workload node. A dedicated RustFS container on the replacement host stored workload backups over the private network; this was an S3-protocol exercise over HTTP, not a hosted S3 or encrypted-transport validation. One host already had an unrelated control container and data, which were left in place. The release predates removal of Tug’s optional mesh; no mesh was enabled.

The WordPress example deployed successfully, WordPress was initialized, and an upload sentinel was created. A manual backup produced a MariaDB dump and a `wp-content` snapshot. A separate control backup and the repository credentials were copied off the control host into private local files. The original workload agent and containers were stopped to simulate workload loss while keeping control available. The project was redeployed with placement changed to the replacement node, then the database and uploads were restored there with Tug’s normal safety backups. The recovered database contained the original site title, the uploaded sentinel matched exactly, and HTTP returned 200. This tested a manual re-placement and restore, not an automatic host failover; external DNS, HTTPS and a second public request path were not tested.

Immediately after the replacement deployment succeeded, the restore plan still named the old node because backup schedules had not yet caught up. After a later scheduler tick it named the replacement; the restore was not confirmed until the target had been checked. The branch now refreshes schedules when planning and queueing a restore and has a regression test. This fix was not part of the published release used for the drill.

For control recovery, an updated control backup was copied off-host. The test control container was stopped and removed, and its data directory was moved aside intact. A new control was bootstrapped on the same machine with fresh storage and a temporary credential. The backup was copied into its mounted data directory, restored through the API and activated by restarting control. The original credential and CA worked again, the replacement agent reconnected, the recovered backup repository credentials matched the escrowed copy, and the WordPress site still returned HTTP 200. This first pass demonstrates fresh-directory recovery on the same machine, not loss of its underlying disk. The test did not verify certificate renewal, automatic off-host backup, or a restore after the backup destination itself is lost. No measured recovery time or data-loss objective is claimed from this exploratory run.

A second control backup cycle included a small Tug-built image. After restoring that backup into another fresh control data directory, the disposable probe container and its local image were removed from the replacement node. Its agent downloaded the retained artifact from restored control and recreated the container; the file baked into the image contained the expected marker. An initial remote-build attempt launched from the repository directory with an absolute Compose path failed with `source context has unsafe entries or exceeds expanded limits`; running the same deployment from its own clean context directory succeeded. The cause of the first rejection was not established.

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

**Finding, fixed.** `agent identity` built its CSR from the pending key file only, so re-running `tug node add` on an enrolled host sent a new key, which control rightly refused, although [Nodes](nodes.md#image) promised an in-place upgrade. `agent identity --current <node>` now reuses the installed key when the host is enrolled as that node and refuses another name; `node add` asks for it and `node replace` and `node repair` still rotate the key. Covered by `src/agent/credential.test.ts` (reuse, rotation, refusal, fresh host), `src/cli/commands/node.test.ts` (the arguments per mode) and `src/main.test.ts` (the plain error through the real entrypoint), and re-verified on the VMs with a rebuilt candidate.

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
| A database from a newer Tug (`user_version` set to 2 on the stopped control) | The 1.0.0 control refused to start with ``the control database is at schema version 2, newer than the 1 this Tug supports; upgrade Tug, or restore a backup taken by this version``, left the file untouched (still version 2, same project count) and the container restarted in a loop. Setting the version back to 1 and starting it recovered everything. |

**Observations, fixed afterwards.** The refusal to open a newer database used to print a stack trace in the control's log. The control and the agent now print one `error:` line with the remedy and exit 1; Docker's restart policy still restarts the container until the operator acts, so the log holds that single line repeated. `tug node list` reported a node `online` from its stored status while `tug status` correctly said `stale`; the list now judges staleness itself, so the two agree.

### Quick start on a fresh host

A third fresh Ubuntu 24.04.5 arm64 VM (no Docker, no private link, forwarded ports 9443 and 9080) followed [Deploy your first service](getting-started.md) with the 1.0.0 candidate, driving the prompts through a pseudo-terminal so they behaved as in an interactive shell. Three deviations from the text were forced by the setup, not by Tug: the candidate CLI came from the packed tarball instead of `npm install -g`, the image was built locally (`--build-local-image`, the 1.0.0 image is not published), and the VM sits behind NAT, so `--control-url https://127.0.0.1:9443` told the CLI where to connect and `--agent-control-url https://127.0.0.1:8443` told the agent.

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

**Finding, fixed.** After the `--move` deploy WordPress on `app2` was running and redirecting to `/wp-admin/install.php` against the empty database: the hold that should have stopped it did not exist. The deploy held only the writers of a moved service that were not themselves acknowledged moves, but WordPress mounts a volume, so the refusal asked for it to be acknowledged too, and acknowledging it exempted it from the hold. Following Tug's own instruction therefore exposed a fresh installer. The data was never at risk, because the in-place restore replaced everything. Every writer of a moved service is now held, whether or not it moved too, with a regression test, and the replacement-node procedure now says to deploy with `--move`.

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
