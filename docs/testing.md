# Testing

Tug changes running systems, so many of its bugs only appear when real Docker, real networks and real certificates are involved. This page describes the layers tests run in, the numbers deployments are held to, and the backlog of tests that should exist because something already went wrong. Two rules apply throughout. Every surprise found on a real host or in a slow suite becomes a test at the cheapest layer that can reproduce it. Anything that can be measured is a number with a threshold, not something watched by eye.

Commands to run each suite are in [Development](development.md). Entries marked **proposed** do not exist yet.

## Layers

| Tier | What runs | Needs | Status |
|---|---|---|---|
| 1. Mocked | Unit tests: control API on SQLite, agent logic against a fake Docker runner, install scripts against fake executables, synthetic image archives | Node only, seconds | Exists; metric assertions and the backlog below are proposed |
| 2. Docker integration | Control plus fake VPSes (privileged containers with their own Docker daemon), plain-address cross-node networking and Caddy, registry-free image delivery, the built `dist/` CLI and the shipped runtime image | Docker, minutes | Exists and runs in CI; a shared load probe and more scenarios are proposed |
| 3. Real hosts | Two disposable VPSes: SSH installation, an operator-provided private network, Let's Encrypt, real latency | Two cloud hosts | Run by hand so far; an on-demand automated run is proposed |

Managed-ingress convergence tests exercise current and outdated configuration hashes, failed ingress application, ingress-only acknowledgements, upstream changes and route removal. These control-level tests do not prove external DNS, TLS issuance or public reachability.

## What the layers have found

| Finding | Found by | Guarded by |
|---|---|---|
| The runtime image shipped without the Compose plugin, so every real deploy failed (the former runtime ran Compose on nodes; agents now use the Docker Engine API and the plugin is no longer part of the image) | Real hosts | Tier 2: `npm run test:smoke:image` runs the shipped image's binaries, database code and mTLS dependencies without any host plugins, on Alpine |
| `deploy --build-local` was rejected on containerd image stores, where `docker save` lists a build attestation as an extra top-level entry | Local integration run on Docker Desktop | Tier 1: `src/artifacts.test.ts` builds synthetic archives, including the rejected variants |
| `secret set` printed success but stayed running with stdin open; auditing prompts also found stale readline listeners that echoed later hidden answers | CLI bug report and subprocess reproduction | Tier 1: `src/commands/secret.test.ts` and `src/cli-prompt.test.ts` check exit with open input, listener cleanup, hidden answers and EOF errors |
| The first rolling deploy started two revisions of the same image | Real hosts | Not guarded yet, see backlog item 1 |
| A control database from before scoped credentials lacks columns the current control writes | Real hosts | Tier 1: `src/db-migrate.test.ts` upgrades the committed `v0.2.0` and `v0.14.0` schemas (`tests/fixtures/db/`) and requires them to match a fresh database column for column |
| The earlier Compose-based agent failed `depends_on.condition: service_healthy` when the image had no Docker `HEALTHCHECK`, and the deploy error omitted the Compose message | Historical real-host evaluation | The Engine API agent now falls back to checking that the dependency is running; `src/agent.test.ts` covers this and `src/control.rollout.test.ts` checks apply errors are reported |

## Tier 1: mocked tests

### Conventions that exist

- **Control** runs in-process on a random port with a temporary data directory and real SQLite, so tests exercise the HTTP API without Docker. Agent endpoints are driven directly, with the test acting as the agent (`src/control.rollback.test.ts`, `src/control.network.test.ts`). These in-process tests skip TLS: a test identity shim (`tests/helpers.ts`) supplies the principal a certificate would, and it still resolves against the database. Real certificates, handshakes, key authorization, enrollment, renewal and node IDs are covered by `src/pki.test.ts` and `src/control.mtls.test.ts`, and by the subprocess CLI tests that start a real mTLS control (`startMtlsControl`).
- **The agent** takes its Docker Engine API client (`DockerApi`; the in-memory Engine in `tests/fake-docker.ts`) and HTTP client as injectable dependencies, so tests assert the exact Engine calls issued for a reconcile (`src/agent.test.ts`, `src/agent.images.test.ts`, `src/agent.network.test.ts`).
- **Shell scripts** are tested by running the generated text against fake executables placed first on `PATH`, instead of asserting on strings (`src/cli-install.test.ts`).
- **Image archives** are built in the test, so malformed and hostile layouts can be checked without Docker (`src/artifacts.test.ts`).
- **The CLI** is run against a stub `ssh` that records its arguments (`src/cli.templates.test.ts`). Subprocess exit tests leave stdin open after secret entry, repeated visible/hidden prompts, prompted command failure, HTTP responses, and interactive exec success, nonzero exit, remote error, disconnect and SIGINT cancellation (`src/commands/secret.test.ts`, `src/cli-prompt.test.ts`, `src/cli.stdin.test.ts`, `src/cli-live-transport.test.ts`). Each subprocess has a deadline so a leaked handle fails the test. Whole-document readers (`init -`, `node register --csr -`, backup destination credentials and runtime `agent install-cert`) receive EOF and must then exit; they intentionally wait for the complete document before producing a result.

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

1. **One revision per deployment as endpoints settle.** A rolling service on one node gets an `extra_hosts` entry in its container definition for every service on another node that is serving. Those entries are part of the revision's identity, so when the other node's service becomes ready between two polls, the agent starts a second revision of the same image. On the real hosts the first deploy ended with two revisions of the same image, and the surviving one carries such an entry, which points to this cause. The old revision drained and no request failed, but the app was started twice. Decide whether those entries should be excluded from the identity, and pin the decision with a test that counts the revisions started.
2. **Rollout metrics from the fakes**: at most two revisions of a service at once, host ports released after the drain, unchanged services never stopped, a failed candidate removed while the previous revision keeps serving, and exactly one automatic rollback.

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

Exists: the fake VPS suite with pinned published images, the registry-free image delivery suite (remote and local builds, rollback, agent restart, backup and restore), the plain-address networking suite (cross-node service names, ingress and private published-port binding), and the packaging smoke tests for the built CLI and the runtime image. The rolling-deploy suite added with M3 already sends continuous requests through the ingress during a rollout and fails on any error.

Proposed:

- A shared load probe that produces the report above instead of a pass or fail.
- App and ingress on different fake VPSes, like the real topology.
- The upgrade from a recreated service to a rolling one, which worked on real hosts without a test.
- Control restarting in the middle of a rollout.
- Latency and packet loss between ingress and app, using `tc netem` inside the privileged containers if the host kernel provides it.
- A Pebble server, Let's Encrypt's own test ACME server, with Caddy pointed at it, so automatic certificates are covered without the internet or rate limits.

The language stack examples have a separate Docker check: `node --test tests/integration/language-stacks.test.ts`. It builds each application, migrates a real database, uploads and downloads a file through a minimal S3 HTTP fixture, runs the configured database dump and restore, and clears Redis to verify recovered metadata. The fixture does not verify S3 signatures and does not replace a test against an actual object storage provider or a Tug deployment.

## Tier 3: real hosts

Real hosts are the only place that shows routing between separate machines on an operator-provided private network, real certificate issuance, real network latency and the state a previous install leaves behind. Proposed: a manually triggered GitHub workflow that creates two throwaway DigitalOcean droplets, runs the scenarios, writes the report and always destroys the droplets, even on failure. A run should cost cents. It needs a DigitalOcean token and an SSH key as repository secrets, and should use Let's Encrypt's staging CA to stay clear of production rate limits.

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

## Example stack benchmarks

Run `npm run test:benchmarks` for benchmark unit and fixture tests and `npm run benchmark:examples` for local measurements of every stack in [examples](../examples/README.md). Docker Compose v2, Node.js and OpenSSL are required. The original PHP/static [proxy microbenchmark](#caddy-proxy-overhead-benchmark) remains separate.

The fixtures in `benchmarks/examples/` build the actual Node.js, Django and Laravel example Dockerfiles and use the WordPress example's image and database settings. Each stack has Caddy HTTPS ingress and its own database. The three file APIs also have Redis and a local SeaweedFS S3-compatible server; a one-off AWS CLI container creates the bucket. The runner migrates the schema, uploads one 28-byte file through the real API, and verifies its list entry and downloaded contents before measuring traffic. WordPress is installed with a PHP 8.3 WP-CLI image and its default post. These are disposable local credentials and data; no external bucket, secrets, Tug control plane, or public host ports are used.

| Stack | Measured workloads | Application server |
|---|---|---|
| Node.js + PostgreSQL + Redis + S3 | Cached `GET /files`, `GET /files/{id}` | Example's single Node/Express process |
| Django + PostgreSQL + Redis + S3 | Cached `GET /files`, `GET /files/{id}` | Example's default single Gunicorn sync worker |
| Laravel + MariaDB + Redis + S3 | Cached `GET /files`, `GET /files/{id}` | Example's PHP development server |
| WordPress + MariaDB | Installed homepage | Example's Apache/PHP image, no page cache |

The file list contains one seeded record and uses the examples' 30-second Redis cache. Warmup primes it before every measurement, but entries retain their original expiry; expiration can cause occasional database reads during a measurement. Downloads exercise the database and S3 on every request. This small payload measures request overhead, not large-file transfer capacity. Upload correctness is checked during setup; upload throughput, cold-cache lists, growing datasets and concurrent writes are not measured. WordPress renders HTML and is a separate workload, so its throughput must not be used as a framework ranking against the file APIs. No worker counts or server defaults are tuned: Laravel's development server and Django's single worker are material limits on the tested configurations.

The driver runs one stack at a time and removes its Compose project and volumes before starting the next. Defaults are three rounds at concurrency 1 and 16 with two seconds of warmup and ten seconds of measurement per workload: 42 measured runs. Workload order reverses in alternating rounds. Select stacks or adjust the run with `BENCH_STACKS=node,django BENCH_SECONDS=20 BENCH_ROUNDS=5 BENCH_CONCURRENCY=1,16,64 npm run benchmark:examples`. Existing development containers remain running. Keep the host awake throughout a run; on macOS, prefix the command with `caffeinate -i`. S3 startup uses an explicit service address and bounded readiness retries because its master/filer election must finish before the S3 listener is ready.

The client runs inside the stack's Docker network using TLS 1.3, HTTP/1.1 and persistent connections. Certificate verification is disabled for the generated local certificate. Every response must return status 200 and pass workload validation: a seeded ID/name in the JSON list, exact download bytes, or the WordPress site title and default post marker. Errors and empty successful samples fail the run. This is closed-loop traffic: each client waits for the complete response before sending another request; latency includes reading the body and initial TLS handshakes. The client has a five-second request deadline and a 4 MiB response limit.

The separate [Example benchmarks workflow](../.github/workflows/benchmarks.yml) runs benchmark tests and actual measurements only through manual dispatch on `main`. Start it from the repository's Actions tab using **Run workflow** with the `main` branch selected. Pushes, pull requests and the main CI workflow do not run this suite. The hosted run uses three five-second rounds at concurrency 1 and 16 (42 measured runs), saves raw JSON reports for 30 days even on failure, and does not enforce throughput or latency thresholds. Hosted runner results describe that runner and should not be compared directly with the local Docker Desktop reference below.

Raw reports in `benchmarks/examples/results/` record settings, workload expectations, Docker environment, image IDs/digests, successful throughput, latency percentiles, errors, connections, client CPU and per-service cgroup CPU/memory. Reports are updated after each measurement; a failed run retains its partial results and container logs. Cleanup targets only the generated project; images, ignored certificates and reports remain. Total server CPU includes Caddy, application, database, Redis and S3 where present, including their background work during the sampling interval; it excludes the client and host networking. Snapshots bracket the load-container lifecycle and include measurement overhead. Memory is sampled near the midpoint and includes charged cache/kernel allocations; it is not peak usage or process RSS. A client near 100% CPU can limit throughput. Shared Docker Desktop resources, sequential stack order, one seeded object and short runs limit portability; these measurements are not CI thresholds or production capacity promises.

### Reference measurement: 3 November 2026

The [raw example-stack report](../benchmarks/examples/results/2026-11-03T11-16-02-061Z.json) records Docker Desktop 29.9.2 on ARM64 Linux with 6 vCPUs, 7.75 GiB RAM and 22 containers already running at invocation. The command was `BENCH_SECONDS=5 BENCH_ROUNDS=3 BENCH_CONCURRENCY=1,16,64 caffeinate -i npm run benchmark:examples`. All three API stacks completed their full matrix; WordPress completed concurrency 1 and 16. These 60 completed measurements served 459,732 successful requests with zero errors and exactly one client TLS connection per concurrent worker. The first measured WordPress run at concurrency 64 failed, so the overall report correctly has status `failed` and the final two planned rounds were not attempted.

Each table value is the median of three per-run values, including per-run latency percentiles; it is not a percentile pooled across rounds. Throughput ranges show the observed minimum and maximum. Memory sums all measured services and includes charged cache and kernel memory. Sequential warming and cache ownership affect these totals; they are not application RSS or minimum RAM requirements.

| Stack / workload | Concurrency | Req/s, median (range) | p50, ms | p95, ms | CPU, µs/request | Client CPU, % | Sampled memory, MiB |
|---|---|---|---|---|---|---|---|
| node / cached-files | 1 | 1421 (1346–1615) | 0.57 | 1.12 | 650 | 28 | 677 |
| node / download | 1 | 407 (372–521) | 2.28 | 3.45 | 2709 | 16 | 639 |
| node / cached-files | 16 | 9781 (7902–9942) | 1.37 | 3.22 | 244 | 75 | 1129 |
| node / download | 16 | 1643 (1461–1669) | 9.02 | 13.90 | 1385 | 30 | 1123 |
| node / cached-files | 64 | 9505 (9380–10061) | 5.84 | 10.22 | 253 | 78 | 1139 |
| node / download | 64 | 1492 (1473–1508) | 38.66 | 62.40 | 1552 | 32 | 1152 |
| django / cached-files | 1 | 722 (577–911) | 1.17 | 2.30 | 1462 | 23 | 318 |
| django / download | 1 | 64 (59–72) | 14.45 | 18.29 | 17724 | 5 | 314 |
| django / cached-files | 16 | 2206 (2045–2231) | 6.75 | 9.89 | 922 | 45 | 423 |
| django / download | 16 | 71 (69–73) | 217.79 | 277.17 | 17131 | 6 | 412 |
| django / cached-files | 64 | 2193 (2144–2250) | 27.37 | 34.49 | 917 | 46 | 494 |
| django / download | 64 | 73 (69–75) | 834.64 | 982.96 | 16474 | 6 | 488 |
| laravel / cached-files | 1 | 252 (83–258) | 3.64 | 5.19 | 4243 | 11 | 457 |
| laravel / download | 1 | 112 (108–124) | 8.56 | 11.17 | 9396 | 7 | 418 |
| laravel / cached-files | 16 | 316 (299–317) | 48.64 | 58.16 | 4081 | 14 | 654 |
| laravel / download | 16 | 138 (126–138) | 112.06 | 126.90 | 8352 | 8 | 652 |
| laravel / cached-files | 64 | 299 (291–313) | 203.89 | 249.29 | 4240 | 15 | 704 |
| laravel / download | 64 | 117 (114–127) | 527.96 | 620.21 | 9880 | 9 | 694 |
| wordpress / homepage | 1 | 39 (37–41) | 24.51 | 30.60 | 24768 | 5 | 460 |
| wordpress / homepage | 16 | 218 (190–220) | 71.65 | 114.91 | 24950 | 16 | 530 |

At concurrency 16, Node served 9,781 cached-list requests/sec and 1,643 downloads/sec; Django served 2,206 and 71; Laravel served 316 and 138. WordPress rendered 218 homepages/sec, a different workload with a roughly 10 KiB HTML body. The single-process client peaked at 78.9% CPU across completed runs, below the one-core saturation signal, though shared VM scheduling and networking remain confounders.

Increasing concurrency from 16 to 64 did not improve the API workloads materially. Node downloads fell from 1,643 to 1,492 requests/sec while p95 increased from 13.90 to 62.40 ms. Django downloads stayed near 71–73 requests/sec while p95 rose from 277.17 to 982.96 ms; Laravel downloads fell from 138 to 117 while p95 rose from 126.90 to 620.21 ms. At these settings, additional concurrency mostly adds queueing rather than useful throughput.

The example configurations explain useful follow-up experiments, without establishing causes by themselves. Django uses one synchronous Gunicorn worker and constructs a new boto3 client for each download; test worker counts and S3 client reuse separately. Laravel uses its development server; benchmark a production PHP server before drawing conclusions about Laravel capacity. Node reuses its database pool and S3 client and handles concurrent I/O, but its download results still show a lower-throughput storage path than its cached list. These measurements characterize the examples, not the maximum performance of their frameworks.

The first WordPress concurrency-64 measurement returned 689 validated responses and 11 errors over 7.80 seconds including in-flight completion, with successful-response p95 of 2,515 ms. It is an unsuccessful stress result, not an accepted capacity number. WordPress retains the example's 384 MiB web and database limits; the report alone does not prove whether the errors came from memory pressure, request deadlines or another failure. The default matrix and hosted workflow therefore use concurrency 1 and 16; request higher concurrency explicitly when investigating overload.

A [fresh WordPress-only repeat at concurrency 64](../benchmarks/examples/results/2026-11-03T11-29-37-492Z.json), using one five-second round, completed 325 requests with zero errors at 53 requests/sec, p50 1,092 ms and p95 2,084 ms. Its sampled web cgroup memory was 379.3 MiB against the 384 MiB limit. This shows degradation and variation rather than a reliably reproducible failure threshold; it does not establish an OOM kill. The runner now captures failed workload/phase context, container OOM/restart state and cgroup memory events before cleanup so future failures have stronger diagnostic evidence.

Variation matters: Node cached-list throughput at concurrency 16 ranged from 7,902 to 9,942 requests/sec, and Laravel at concurrency 1 ranged from 83 to 258. Repeat on an otherwise quiet dedicated host, use representative object sizes and datasets, and test uploads and cache misses before using these results for deployment sizing.

### Implications for Tug's design

These results are useful for choosing operational defaults and follow-up measurements. They do not establish a need to change Tug's control-plane, agent, networking or ingress architecture. The suite starts standalone Compose projects with a standalone Caddy instance: it does not deploy through Tug, exercise its generated ingress configuration and host-port path, run the control plane or agent, measure rollouts, or compare alternative ingress arrangements. In particular, it neither isolates Caddy overhead nor demonstrates that the managed edge is a bottleneck.

| Evidence | Design implication | Next useful validation |
|---|---|---|
| More concurrency usually adds latency after throughput plateaus; Django and Laravel retain constrained example server defaults. | Keep application worker and connection settings explicit in examples. Treat [placement and scaling](service-placement.md) as a separate decision from configuring concurrency inside a container; these results do not justify an autoscaling policy. | Compare production PHP serving and Gunicorn worker/client-reuse settings while holding application code, resource limits and data constant. |
| WordPress's fresh 64-client repeat samples 379.3 MiB against a 384 MiB web limit, while another run fails. | Resource limits need workload-specific validation. Container OOM/restart state, memory events, CPU and latency are stronger diagnostic inputs than a generic requests/sec figure. The evidence does not prove an OOM kill or justify raising everyone's memory limit. | Reproduce with memory events captured and vary memory limits and Apache worker counts independently. |
| S3 startup can lag a running process, and the API setup requires a schema, bucket and a verified upload/download. | Preserve the distinction between process liveness and [readiness](healthchecks.md). These fixtures motivate dependency-aware checks and clear migration/setup guidance, but do not test Tug's readiness implementation. | Deploy the same stacks through Tug and test cold starts, missing schema/buckets, dependency restarts and rollout admission. |
| Cached lists, S3 downloads and WordPress HTML have very different CPU, latency and memory profiles; whole-stack memory also includes storage caches. | Use per-service resource evidence for VPS sizing and troubleshooting. These isolated sequential runs cannot establish safe node packing, tenant isolation or the number of sites a VPS can host. | Run mixed workloads through one managed edge with the control plane and agent present, including backups and overlapping rolling revisions, on an otherwise quiet host. |

The most valuable next benchmark for Tug itself is an end-to-end deployment of these same workloads, comparing the standalone baseline with Tug-managed ingress under the same server settings and resource limits. Include mixed traffic and a rolling deployment to measure latency, errors and resource headroom during a change. That would separate application tuning from platform overhead and provide evidence for ingress, placement and rollout design decisions. No Tug runtime behavior is changed by this benchmark PR.
