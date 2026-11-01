# Testing

Tug changes running systems, so many of its bugs only appear when real Docker, real networks and real certificates are involved. This page describes the layers tests run in, the numbers deployments are held to, and the backlog of tests that should exist because something already went wrong. Two rules apply throughout. Every surprise found on a real host or in a slow suite becomes a test at the cheapest layer that can reproduce it. Anything that can be measured is a number with a threshold, not something watched by eye.

Commands to run each suite are in [Development](development.md). Entries marked **proposed** do not exist yet.

## Layers

| Tier | What runs | Needs | Status |
|---|---|---|---|
| 1. Mocked | Unit tests: control API on SQLite, agent logic against a fake Docker runner, install scripts against fake executables, synthetic image archives | Node only, seconds | Exists; metric assertions and the backlog below are proposed |
| 2. Docker integration | Control plus fake VPSes (privileged containers with their own Docker daemon), real WireGuard and Caddy, registry-free image delivery, the built `dist/` CLI and the shipped runtime image | Docker, minutes | Exists and runs in CI; a shared load probe and more scenarios are proposed |
| 3. Real hosts | Two disposable VPSes: SSH installation, WireGuard between machines, Let's Encrypt, real latency | Two cloud hosts | Run by hand so far; an on-demand automated run is proposed |

## What the layers have found

| Finding | Found by | Guarded by |
|---|---|---|
| The runtime image shipped without the Compose plugin, so every real deploy failed (the former runtime ran Compose on nodes; agents now use the Docker Engine API and the plugin is no longer part of the image) | Real hosts | Tier 2: `npm run test:smoke:image` runs the shipped image's binaries, database code and mTLS dependencies without any host plugins, for Debian and Alpine |
| Reinstalling a mesh node failed the UDP preflight because Tug's own agent holds the WireGuard port | Real hosts | Tier 1: `src/cli-install.test.ts` runs the generated script against fake `ss`, `docker` and `wg` |
| `deploy --build-local` was rejected on containerd image stores, where `docker save` lists a build attestation as an extra top-level entry | Local integration run on Docker Desktop | Tier 1: `src/artifacts.test.ts` builds synthetic archives, including the rejected variants |
| The first rolling deploy started two revisions of the same image | Real hosts | Not guarded yet, see backlog item 1 |
| After control loses its data, agents would not re-report their WireGuard keys | Reading the code while resetting control for the real-host run; worked around, not reproduced | Not guarded yet, see backlog item 2 |
| A control database from before scoped credentials lacks columns the current control writes | Real hosts | Not guarded yet, see backlog item 3 |
| `depends_on.condition: service_healthy` fails the deploy when the image has no Docker `HEALTHCHECK`, and the deploy error omitted the compose message | Real hosts | Tier 1: `src/control.rollout.test.ts` asserts the deployment error includes the node apply error |

## Tier 1: mocked tests

### Conventions that exist

- **Control** runs in-process on a random port with a temporary data directory and real SQLite, so tests exercise the HTTP API without Docker. Agent endpoints are driven directly, with the test acting as the agent (`src/control.rollback.test.ts`, `src/control.network.test.ts`). These in-process tests skip TLS: a test identity shim (`tests/helpers.ts`) supplies the principal a certificate would, and it still resolves against the database. Real certificates, handshakes, key authorization, enrollment, renewal and node IDs are covered by `src/pki.test.ts` and `src/control.mtls.test.ts`, and by the subprocess CLI tests that start a real mTLS control (`startMtlsControl`).
- **The agent** takes its Docker Engine API client (`DockerApi`; the in-memory Engine in `tests/fake-docker.ts`), host runner and HTTP client as injectable dependencies, so tests assert the exact Engine calls issued for a reconcile (`src/agent.test.ts`, `src/agent.images.test.ts`, `src/agent.network.test.ts`).
- **Shell scripts** are tested by running the generated text against fake executables placed first on `PATH`, instead of asserting on strings (`src/cli-install.test.ts`).
- **Image archives** are built in the test, so malformed and hostile layouts can be checked without Docker (`src/artifacts.test.ts`).
- **The CLI** is run against a stub `ssh` that records its arguments (`src/cli.templates.test.ts`).

### SQLite contract and blocking measurements

`src/db.test.ts` runs the reusable factory-driven suite in `tests/db-contract.ts` against the Node adapter. It checks bindings and injection resistance, NULL and missing rows, ordinary object results, numeric change counts, integer boundaries, classified errors, transactions, busy waits, read-only/no-create behavior and connection cleanup. Shared-policy tests cover schemas, persisted agent state, foreign keys, WAL and the 1,000 ms timeout. A future Bun adapter must pass the same suite before it can replace the Node adapter.

Control tests cover duplicate locks and operator credentials, failed publication rollback, backup validation and restart-required responses. Restore race tests pause actual filesystem I/O; synchronous SQL has no suspension point inside a transaction. The runtime image smoke test executes compiled database code inside the production image and checks that neither SQLite npm addon is present. CI exercises the exact Node 22.18.0 minimum alongside current Node 22 and 24 releases.

Run `node tools/scripts/benchmark-database.js` for a synthetic reference workload of 100,000 events and 1,000 metadata reads. It reports operation duration, timer delay, snapshot size and maximum event-loop delay. On a local Node 24.21.0 run, the reads took 9 ms, the 75 MiB snapshot 218 ms and read-only integrity checking 123 ms; the maximum observed event-loop delay was 219 ms. These are reference measurements, not portable performance guarantees or CI thresholds. Recheck representative production data before relying on backup latency or lease timing.

### Measuring with mocks (proposed)

Today the fakes record commands and return canned output. Extend the in-memory Docker Engine to keep a model of what is running (containers, their `tug.project` and `tug.service` labels, published host ports) and a log of every call. A test can then compute numbers from the log and assert on them, for example:

```ts
assert.deepEqual(metrics(fake), { revisionsStarted: 1, peakRevisions: 2, unchangedServiceStops: 0, leakedPorts: 0 });
```

Inject the clock and sleep into the rollout code so drain and poll timing is tested without real waits.

### Backlog of mocked tests (proposed)

1. **One revision per deployment as endpoints settle.** A rolling service on one node gets an `extra_hosts` entry in its container definition for every service on another node that is serving. Those entries are part of the revision's identity, so when the other node's service becomes ready between two polls, the agent starts a second revision of the same image. On the real hosts the first deploy ended with two revisions of the same image, and the surviving one carries such an entry, which points to this cause. The old revision drained and no request failed, but the app was started twice. Decide whether those entries should be excluded from the identity, and pin the decision with a test that counts the revisions started. This applies once rolling deploys (M3) are merged.
2. **The agent re-reports its WireGuard key when control does not know it.** The agent skips reporting when its local record matches its live key. By reading the code, after control loses data, for example a restore from an older backup, the agent never relearns its key and the node would not join the mesh. This has not been reproduced yet, and the test would confirm it. Test with a fake control that has no overlay address for a node whose key the agent has already recorded.
3. **Control on a database from an earlier version.** Tug has no migrations by design, but control should say so clearly instead of failing on the first write. Decide between refusing to start with a message that names the fix and another behavior, then test it.
4. **Preflight messages name the remedy.** When the mesh port check refuses because the agent's state is incomplete, the message should say how to start clean: stop the old agent and delete the `wg0` interface that still holds the port. Assert the message contains it.
5. **Rollout metrics from the fakes**, once M3 is merged: at most two revisions of a service at once, host ports released after the drain, unchanged services never stopped, a failed candidate removed while the previous revision keeps serving, and exactly one automatic rollback.

### Adding a tier 1 test

Reproduce the failure first with the smallest fake that shows it. Assert numbers where there are numbers. Write assertion messages that state the expected behavior, since they are what a failure prints.

## Metrics

Rolling deploys are held to these numbers. The reference column is the first real-host run on two Ubuntu 24.04 droplets in October 2026, with requests sent every 100 ms from a developer machine through the public HTTPS endpoint and every 50 ms from the ingress host. Thresholds other than zero are proposals to be tuned after more runs.

| Metric | Reference run | Threshold | Tiers |
|---|---|---|---|
| Failed requests during a rollout | 0 of 378 public and 0 of 638 from the ingress host | 0 | 2, 3 |
| Switchover gap, from the last old response to the first new one | 0.2 s | at most one poll interval | 2, 3 |
| Latency during a rollout (p95 / max, public) | 61 ms / 219 ms | p95 within 1.5 times the p95 before the rollout | 2, 3 |
| Revisions started per deployment | 1 for a change, 2 for the first deploy | 1 | 1 |
| Containers of unchanged services restarted | 0 | 0 | 1, 2, 3 |
| Old revision removed after the drain | yes | within the drain plus two polls | 1, 2, 3 |
| Most revisions of one service at the same time | 2 | 2 | 1, 2 |
| Share of requests served by the previous revision while a bad version is rejected | not measured, the run was interrupted | 100% | 1, 2, 3 |
| Time from a failed health check to the automatic rollback | not measured | set after the first measurement | 2, 3 |

Each tier 2 and tier 3 run should write a JSON report with these keys, keep it as a CI artifact, and compare it with the thresholds, which live in one file.

## Tier 2: Docker integration

`npm run test:integration:backups` runs the backup executor and `tug run` against the local Docker daemon, with no fake VPS: a real MariaDB is dumped through the generic `command` path into a real restic repository on disk and restored back, a volume is archived, restored in place and into a scratch volume, and a one-off container is run with a service's environment and mounts. It checks what mocks cannot: that a failed or cut-short stream leaves no snapshot, that a wrong repository password does not initialize a new repository, that retention prunes, that helper containers are removed, and that a one-off container carries none of the service's labels. It pulls `restic/restic`, `mariadb` and `alpine`, and runs as the `Integration (backups and one-off runs)` CI job. It does not use a real S3 bucket.

Exists: the fake VPS suite with pinned published images, the registry-free image delivery suite (remote and local builds, rollback, agent restart, backup and restore), the WireGuard mesh suite, and the packaging smoke tests for the built CLI and the runtime image. The rolling-deploy suite added with M3 already sends continuous requests through the ingress during a rollout and fails on any error.

Proposed:

- A shared load probe that produces the report above instead of a pass or fail.
- App and ingress on different fake VPSes, like the real topology.
- The upgrade from a recreated service to a rolling one, which worked on real hosts without a test.
- Control restarting in the middle of a rollout.
- Latency and packet loss between ingress and app, using `tc netem` inside the privileged containers if the host kernel provides it.
- A Pebble server, Let's Encrypt's own test ACME server, with Caddy pointed at it, so automatic certificates are covered without the internet or rate limits.

## Tier 3: real hosts

Real hosts are the only place that shows WireGuard between separate machines, real certificate issuance, real network latency and the state a previous install leaves behind. Proposed: a manually triggered GitHub workflow that creates two throwaway DigitalOcean droplets, runs the scenarios, writes the report and always destroys the droplets, even on failure. A run should cost cents. It needs a DigitalOcean token and an SSH key as repository secrets, and should use Let's Encrypt's staging CA to stay clear of production rate limits.

The scripts from the first run are the starting point: a request loop from a developer machine and one on the ingress host, a generator for the test application, and a driver for the CLI. They are not in the repository yet.

## Caddy proxy overhead benchmark

The benchmark compares three HTTPS server arrangements with a timestamp-only PHP document and with a static file. Four Compose files in `benchmarks/caddy-php/` define the six cases:

| Case | Compose file | Request path |
|---|---|---|
| `direct` | `compose.direct.yml` | HTTPS → nginx → PHP-FPM |
| `proxy` | `compose.proxy.yml` | HTTPS → Caddy → HTTP → nginx → PHP-FPM |
| `caddy-php` | `compose.caddy-php.yml` | HTTPS → Caddy → PHP-FPM |
| `static-nginx` | `compose.static.yml` | HTTPS → nginx → static file |
| `static-proxy` | `compose.static.yml` | HTTPS → Caddy → HTTP → nginx → static file |
| `static-caddy` | `compose.static.yml` | HTTPS → Caddy → static file |

All PHP cases use the same PHP image, 16 static PHP-FPM workers, and PHP document printing the current UTC time with microseconds. The static cases serve the same 28-byte file containing a fixed timestamp in the same format, with no PHP-FPM service running in that stack. There is no database, application response cache or response compression. Access logging is disabled in all paths. Both PHP nginx instances have the same configuration, with HTTP and HTTPS listeners; the proxy case uses only nginx's HTTP listener. The static nginx configuration changes only the content handler to serve the file and adds the same `Cache-Control: no-store` response header as PHP and direct static Caddy. No host ports are published.

Run from the repository root with Docker Compose, Node and OpenSSL installed:

```sh
node --test benchmarks/caddy-php/load.test.mjs
node benchmarks/caddy-php/run.mjs
```

The driver generates a temporary self-signed certificate shared by all stacks, pulls the official images, records their image IDs/digests and versions, and creates uniquely named Compose projects. It copies the two application files once into a shared native Docker volume, then mounts that volume read-only in application containers. Application file operations therefore stay inside the Linux VM; they do not cross macOS bind mounts. This matters particularly for the filesystem checks in Caddy's standard `php_fastcgi` handler and `file_server`. Configuration files remain read-only bind mounts loaded at startup. It runs a Node HTTPS load generator on each stack's Docker network, so requests do not traverse Docker Desktop's host port forwarding. Certificate verification is disabled only in this test client. All cases use TLS 1.3, HTTP/1.1 and persistent client connections. Caddy reuses its HTTP connections to nginx; nginx's 180-second idle timeout exceeds Caddy's default upstream idle timeout. PHP-FPM configuration is identical across PHP cases; Caddy uses its standard `php_fastcgi` handler and nginx uses its FastCGI module.

Defaults are three rounds at concurrency 1, 32 and 128, with two seconds of warmup before each ten-second measurement. Each round measures the six cases sequentially, reversing their order in the second round, for 54 measured runs. Override with `BENCH_SECONDS=30 BENCH_ROUNDS=5 BENCH_CONCURRENCY=1,16,64 node benchmarks/caddy-php/run.mjs`. Use `BENCH_CASES=direct,proxy` for the original two-case comparison, or any comma-separated selection of case names above. This is a closed-loop test: each client worker waits for a complete response before sending its next request. Reported latency includes reading the entire response; the first TLS handshakes of each measured run are included and amortized over that run. The generator checks status 200 and the timestamp body format on every request and fails the run on any error. Successful runs should show approximately one TLS connection per concurrent worker.

Raw reports are saved in `benchmarks/caddy-php/results/`. They include successful requests per second, mean/p50/p95/p99 latency, errors, client connection counts, per-service cgroup CPU time, and per-service cgroup memory sampled near the middle of each run. CPU microseconds per request sums the services on that case's request path; it excludes the load generator and host networking work. CPU snapshots bracket the load-container lifecycle and include a small amount of measurement overhead. `clientCpuPercent` measures the Node load-generator process CPU during traffic generation; 100% means roughly one CPU core. This single-process client can limit measured throughput, especially for static files, so a result approaching 100% client CPU is not a measurement of maximum server capacity. Sampled cgroup memory includes charged cache and kernel memory; it is neither process RSS nor a measured peak. The driver removes only its own Compose projects and shared asset volume in a `finally` block; images, generated local certificates and result files remain. Certificates are ignored by Git.

The nginx/Caddy-proxy comparison measures the combined effect of an extra HTTP proxy and switching TLS termination from nginx to Caddy. It does not isolate Caddy's HTTP forwarding cost from the two servers' different TLS implementations. Direct Caddy uses the standard `php_fastcgi php:9000` helper, including filesystem routing, while nginx forwards to the fixed `/app/index.php` script. Both connect to PHP-FPM over the Docker network; Unix sockets and routing optimizations need separate measurements. The tiny PHP response makes server overhead a large fraction of total request work. Docker Desktop results, a load generator sharing the server VM, existing workloads, and saturation at high concurrency limit how directly the numbers transfer to a dedicated production host. Treat these as local reference measurements rather than performance guarantees or CI thresholds. HTTP/2, HTTP/3, fresh TLS handshakes on every request, large responses, cross-host traffic, streaming, and real application workloads need separate measurements.

### Reference measurement: 31 October 2026

The [raw six-case report](../benchmarks/caddy-php/results/2026-10-31T21-03-10-626Z.json) records Docker Desktop 29.9.2 on ARM64 Linux with 6 vCPUs and 7.75 GiB RAM, nginx 1.30.6, Caddy 2.11.7, PHP 8.4.27 and Node 24.22.2. Docker reported 27 running containers at invocation startup; this was a shared development environment. Application assets were stored on the native Docker volume described above. The 54 measured runs completed 3,796,280 requests with zero errors. Each run established exactly one client TLS connection per concurrent worker. The PHP endpoint behind direct Caddy was also independently checked to return changing timestamps within milliseconds of the current time.

Each value below is the median of three per-run values, not a percentile pooled across runs. Throughput ranges show the minimum and maximum observed run. CPU is total server CPU microseconds per successful request, excluding the client and host networking work. Raw reports also include p99, mean latency and memory measurements.

PHP responses:

| Concurrency | HTTPS path | Requests/sec, median (range) | p50, ms | p95, ms | CPU, µs/request | Client CPU, % |
|---|---|---|---|---|---|---|
| 1 | nginx | 2,171 (2,148–2,230) | 0.397 | 0.645 | 292 | 44 |
| 1 | Caddy → nginx | 1,372 (609–1,377) | 0.650 | 0.998 | 661 | 34 |
| 1 | Caddy → PHP-FPM | 1,066 (976–1,146) | 0.815 | 1.340 | 854 | 29 |
| 32 | nginx | 6,470 (5,185–7,481) | 3.893 | 11.226 | 228 | 81 |
| 32 | Caddy → nginx | 4,354 (2,674–5,676) | 5.958 | 14.912 | 432 | 74 |
| 32 | Caddy → PHP-FPM | 4,297 (3,564–5,028) | 5.924 | 15.329 | 474 | 80 |
| 128 | nginx | 7,410 (7,383–7,484) | 15.834 | 28.929 | 204 | 94 |
| 128 | Caddy → nginx | 5,865 (5,146–5,939) | 19.643 | 40.223 | 385 | 86 |
| 128 | Caddy → PHP-FPM | 6,807 (6,598–7,166) | 16.428 | 34.184 | 373 | 92 |

Static file (28 bytes):

| Concurrency | HTTPS path | Requests/sec, median (range) | p50, ms | p95, ms | CPU, µs/request | Client CPU, % |
|---|---|---|---|---|---|---|
| 1 | nginx | 6,941 (6,170–7,234) | 0.119 | 0.186 | 36 | 70 |
| 1 | Caddy → nginx | 2,315 (1,969–3,380) | 0.282 | 1.017 | 286 | 42 |
| 1 | Caddy | 4,472 (3,296–4,996) | 0.167 | 0.384 | 124 | 58 |
| 32 | nginx | 11,448 (9,881–13,723) | 2.115 | 5.677 | 36 | 100 |
| 32 | Caddy → nginx | 12,394 (11,435–15,564) | 2.056 | 5.224 | 150 | 95 |
| 32 | Caddy | 9,810 (2,911–15,418) | 2.568 | 6.509 | 89 | 89 |
| 128 | nginx | 13,905 (11,964–14,132) | 8.143 | 14.112 | 32 | 104 |
| 128 | Caddy → nginx | 13,214 (13,189–13,216) | 8.543 | 15.044 | 167 | 102 |
| 128 | Caddy | 12,809 (12,649–13,456) | 8.546 | 15.035 | 90 | 104 |

At concurrency 1, adding Caddy in front of nginx increased p50 by 0.253 ms for PHP and 0.163 ms for the static file. Serving the static file directly through Caddy reduced p50 from 0.282 ms through Caddy/nginx to 0.167 ms; nginx directly measured 0.119 ms. Direct Caddy/PHP-FPM measured 0.815 ms, compared with 0.397 ms through nginx. This is the standard Caddy PHP helper over a Docker TCP hostname, including its filesystem routing, compared with nginx forwarding to a fixed script; the run does not isolate which implementation details explain the difference.

At concurrency 128, direct Caddy/PHP-FPM achieved 6,807 requests/sec compared with 7,410 through nginx and 5,865 through Caddy/nginx. Total server CPU was approximately 373, 204 and 385 µs/request respectively. Direct Caddy therefore improved on the two-server PHP path under this load, while nginx remained the cheapest measured PHP path in server CPU. These are measurements of the tested configurations, with substantial run variation at concurrency 32.

The static-file client approached one CPU core at concurrency 32 and used approximately one core at 128. The observed static throughput is client-limited and cannot rank maximum server capacities. At concurrency 128, server CPU was approximately 32 µs/request for nginx, 90 for direct Caddy and 167 for Caddy/nginx. Low-concurrency latency and server CPU distinguish these configurations more clearly than the saturated-client throughput. The static Caddy run at concurrency 32 varied from 2,911 to 15,418 requests/sec, illustrating the shared host noise; do not interpret the median as a precise capacity estimate.

Caddy's median sampled cgroup memory at concurrency 128 was 44.2 MiB in the PHP proxy, 40.1 MiB for direct PHP, 45.8 MiB in the static proxy and 31.9 MiB for direct static files. Memory includes charged cache and kernel allocations, and shared pages can be charged to different containers, so subtracting total cgroup memory across stacks would not give a reliable process-memory overhead.
