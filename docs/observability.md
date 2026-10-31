# Observability

**Status: mostly proposed.** Tug today has an audit trail, a few read commands and a liveness endpoint, and nothing that measures CPU, memory, requests or latency. Sections marked **Proposed** describe a setup that is not built; the milestone is [M9](roadmap.md#m9--observability). Nothing marked proposed works yet, and none of the names, flags or environment variables in those sections exist in the code.

The aim is the smallest setup that answers the day-to-day questions: is every node reporting, did the last deployment succeed, did an automatic rollback happen, will a certificate expire, is the control database growing. It follows the shape of the rest of Tug: one central control plane, agents that only dial out, and no required extra services.

## What exists today

Verified against the code on `main`.

| Capability | What it does | Limits |
| --- | --- | --- |
| Audit trail | Deployments and events record the acting token, and `system:auto-rollback` for automatic rollbacks. See [Access control](access-control.md). | Answers who acted, not how the system behaves |
| `tug status` | Prints `GET /api/v1/status` as JSON: projects, the 20 latest deployments, nodes with `status` and `last_seen_at`, and per-node project status including health, rollout state, port and rollout error. | Raw JSON. A node is marked `stale` only when this endpoint is called, using `TUG_STALE_SECONDS` (default 60) |
| `tug events` | Lists events from `GET /api/v1/events`, newest first, at most 500 per call, 100 by default. | See [Event volume](#event-volume) |
| `tug doctor` | Local checks, control checks (SQLite, operator token, master key, Docker, Compose, mesh keys, ingress state) and, with `--nodes`, diagnostics queued on agents. | A point-in-time check, not a time series |
| `tug logs <service>` | Queues a `logs.fetch` command on the service's node and prints the tail. | A tail through the poll-based command queue; no follow mode |
| `GET /healthz` | Returns `{"ok":true}` without authentication. | Checks nothing: it answers even if the database or the writer queue is stuck |
| Process logs | Control and agent write plain `console.log` and `console.error` text. | No timestamps, levels, structure or request ids |

What does not exist: a `/metrics` endpoint, CPU, memory, disk or restart data, request, build or poll metrics, structured or leveled logs, alerting, outbound webhooks (M8, unchecked) and a dashboard (M8, unchecked). The managed Caddy ingress does not enable Caddy's metrics: the generated Caddyfile has no global options beyond the optional ACME email.

### Event volume

Agents currently emit four `service.*` events (`pulling`, `starting`, `health_checking`, `serving`) for every non-rolling service on every reconcile, whether or not anything changed. On a real control plane with nothing deploying this was about 71 events a minute, roughly 100,000 a day. Nothing deletes events, so the default `tug events` view (the last 100) covered about a minute and a half and hid real events such as an automatic rollback. Event hygiene, below, addresses this.

## Proposed

Everything below is **Proposed** unless a status line says otherwise.

| Piece | Section | Status |
| --- | --- | --- |
| Event hygiene | [Event hygiene](#event-hygiene) | In progress, not yet merged |
| Structured logs | [Structured logs](#structured-logs) | Proposed |
| Metrics on control | [Metrics on control](#metrics-on-control) | Proposed |
| Node and service stats from agents | [Node and service stats reported by agents](#node-and-service-stats-reported-by-agents) | Proposed |
| Readiness endpoint | [Health endpoints](#health-endpoints) | Proposed |
| Ingress metrics | [Ingress metrics](#ingress-metrics) | Proposed, with open questions |
| Sample alerts and webhooks | [Alerting](#alerting) | Proposed |
| Live commands | [Live commands](#live-commands) | Proposed, depends on M5 |
| Metrics test gate | [Test gate](#test-gate) | Proposed |

### Event hygiene

Status: in progress, not yet merged. A separate change makes agents emit lifecycle events only when something changes (a new revision, changed secrets or rendered configuration, a failure or a recovery), and makes control delete events older than `TUG_EVENT_RETENTION_DAYS` (default 30) and keep at most `TUG_EVENT_MAX_ROWS` (default 100000). It comes first because every later piece, including webhooks, assumes that an event means something happened.

### Structured logs

Status: proposed.

Control and agent would write one JSON object per line with `time`, `level`, `component`, `msg` and context fields where they apply: `requestId`, `node`, `project`, `service`, `deploymentId`. Two environment variables would select the output: `TUG_LOG_FORMAT=json|text` and `TUG_LOG_LEVEL` (`debug`, `info`, `warn`, `error`). Text would stay the default so existing installs read the same, and JSON is meant for `docker logs` piped to whatever the operator already uses.

Token values, join keys, secret values and `Authorization` headers are never logged, and the logger would redact known field names as a second line of defence. The CLI keeps its human-readable output; only the long-running processes change. Every existing `console.log` and `console.error` in `src/control.ts` and `src/agent.ts` would move to the logger.

### Metrics on control

Status: proposed.

Control would serve `GET /metrics` in the Prometheus text format. It needs the `read` role from [Access control](access-control.md#roles), so Prometheus authenticates with `authorization: Bearer <read token>`; a token limited to projects would see only those projects' series. Adding the route means adding it to `ROUTE_ROLES` in `src/tokens.ts` and to the endpoint table, which the existing test already requires.

Naming follows the Prometheus conventions: a `tug_` prefix, base units (`_seconds`, `_bytes`), `_total` for counters. Labels are bounded: project, node and service names are operator-defined and few; route labels use the route pattern (`/api/v1/deployments/:id`), never the raw path; deployment IDs, command IDs, versions and error messages are never labels.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `tug_build_info` | gauge | `version` | Constant 1; the running control version |
| `tug_deployments` | gauge | `project`, `state` | Deployments currently in each state (`uploading`, `building`, `pending_dependencies`, `rolling_out`, `succeeded`, `failed`, `build_failed`, `cancelled`) |
| `tug_deployment_duration_seconds` | histogram | `project`, `outcome` | Time from creation to a terminal state |
| `tug_rollout_outcomes_total` | counter | `project`, `outcome` | Rollout results: `rolled_out`, `rejected` (a candidate failed its health check while the old revision kept serving), `auto_rollback` |
| `tug_nodes` | gauge | `status` | Registered nodes by `online` or `stale`, computed from `last_seen_at` at scrape time rather than stored |
| `tug_node_poll_age_seconds` | gauge | `node` | Seconds since the node last reported |
| `tug_api_requests_total` | counter | `route`, `method`, `status_class` | API requests by route pattern and status class (`2xx`, `4xx`, `5xx`) |
| `tug_api_request_duration_seconds` | histogram | `route` | API request latency |
| `tug_builds_total` | counter | `outcome` | Builds by result (`complete`, `failed`) |
| `tug_build_duration_seconds` | histogram | none | Remote build duration |
| `tug_image_archive_bytes` | gauge | none | Total size of retained image archives under the data directory |
| `tug_db_size_bytes` | gauge | none | Size of the control SQLite database file |
| `tug_events_rows` | gauge | none | Rows in the `events` table |
| `tug_project_locks` | gauge | none | Project operation locks currently held |
| `tug_writer_queue_depth` | gauge | none | Operations waiting for the single writer |

Gauges that describe state (`tug_deployments`, `tug_nodes`, `tug_events_rows`, `tug_project_locks`) would be computed from the database at scrape time, so they stay correct across control restarts. Counters and histograms live in process memory and reset on restart, which Prometheus handles as a counter reset.

### Node and service stats reported by agents

Status: proposed.

Agents already send a status report on every poll. The proposal adds a `stats` block to that report and has control expose it on the same `/metrics` endpoint, so one scrape target covers everything:

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `tug_service_cpu_seconds_total` | counter | `node`, `project`, `service` | CPU time used by the service's containers |
| `tug_service_memory_bytes` | gauge | `node`, `project`, `service` | Memory in use |
| `tug_service_up` | gauge | `node`, `project`, `service` | 1 when the container is running, 0 otherwise |
| `tug_service_restarts_total` | counter | `node`, `project`, `service` | Container restarts since the container was created |
| `tug_node_disk_free_bytes` | gauge | `node`, `path` | Free space on the Docker data and Tug state paths |
| `tug_node_load1` | gauge | `node` | One-minute load average |

The agent would read these from `docker stats --no-stream` and `docker inspect`, and control would drop series for services that no longer exist. A node that stops reporting keeps its last values, so alerts use `tug_node_poll_age_seconds` to tell fresh data from stale data.

Why report through control: agents sit behind NAT and only dial out, so Prometheus often cannot reach them. Reporting through the existing authenticated channel needs no inbound port, no extra token and no firewall change, and adds one scrape target regardless of node count. The cost is resolution: values are as fresh as the poll interval (`TUG_POLL_INTERVAL_MS`), and the status report grows with the number of services.

The alternative is scraping an exporter on each agent directly over the WireGuard mesh from [Networking](networking.md). It gives finer resolution and keeps control out of the data path, but it requires the mesh, a listener on every node, a firewall rule on the mesh interface and a service-discovery list for Prometheus, and it does not work for nodes without the mesh or behind NAT. If both are ever wanted, the metric names above can be reused so dashboards do not change.

### Health endpoints

Status: proposed.

`GET /healthz` stays as it is: liveness, unauthenticated, always `{"ok":true}` while the process answers. A new unauthenticated `GET /readyz` would return 200 only when control can do its job: it can read the database, and the writer queue is not stuck (the operation at the head of the queue has not been running longer than a limit). Otherwise it returns 503 with the names of the failing checks and nothing more. Use `/healthz` for the container restart policy and `/readyz` for an external uptime check.

### Ingress metrics

Status: proposed, with open questions.

The managed Caddy would enable its metrics with the global option `servers { metrics }` in the generated Caddyfile (see `renderCaddyfile` in `src/ingress.ts`), served by Caddy's admin endpoint, which listens on `localhost:2019` inside the container by default. That gives request counts by status class and request duration histograms. To reach the same scrape target, the agent on the ingress node would read the admin metrics and include a filtered subset (request counts, status classes, latency buckets, certificate expiry per host) in its status report, and control would re-export it as `tug_ingress_*` series labelled by `node` and `host`.

Open questions:

- Whether re-exporting parsed Caddy metrics through the status report is worth the complexity, compared with publishing Caddy's admin metrics port on the mesh and scraping it directly.
- Which certificate expiry signal Caddy exposes reliably across versions; the alert below assumes a `tug_ingress_certificate_expiry_timestamp_seconds` gauge that may have to be derived from the certificate files.
- Label cardinality: one `host` label per route is bounded by the number of routes, but per-upstream labels are not planned.

### Alerting

Status: proposed.

Tug would not bundle Prometheus or Alertmanager. A sample scrape configuration:

```yaml
scrape_configs:
  - job_name: tug
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/tug-read-token
    static_configs:
      - targets: ['control.example.com']
```

Sample alert rules, written against the proposed metric names:

```yaml
groups:
  - name: tug
    rules:
      - alert: TugNodeStale
        expr: tug_node_poll_age_seconds > 120
        for: 2m
        annotations: { summary: "Node {{ $labels.node }} has not reported for over two minutes" }
      - alert: TugDeploymentFailed
        expr: increase(tug_deployment_duration_seconds_count{outcome=~"failed|build_failed"}[10m]) > 0
        annotations: { summary: "A deployment of {{ $labels.project }} failed" }
      - alert: TugAutomaticRollback
        expr: increase(tug_rollout_outcomes_total{outcome="auto_rollback"}[10m]) > 0
        annotations: { summary: "{{ $labels.project }} was rolled back automatically" }
      - alert: TugCertificateExpiresSoon
        expr: tug_ingress_certificate_expiry_timestamp_seconds - time() < 14 * 86400
        annotations: { summary: "Certificate for {{ $labels.host }} expires in under 14 days" }
      - alert: TugDatabaseGrowing
        expr: predict_linear(tug_db_size_bytes[6h], 7 * 86400) > 5 * 1024 ^ 3
        annotations: { summary: "Control database is on track to pass 5 GiB within a week" }
      - alert: TugAgentPollAgeHigh
        expr: tug_node_poll_age_seconds > 30
        for: 10m
        annotations: { summary: "Node {{ $labels.node }} polls much slower than its interval" }
```

Thresholds are starting points. The last rule assumes the default poll interval and should be set from `TUG_POLL_INTERVAL_MS`.

Outbound webhooks (M8) are the lightweight alternative for operators without Prometheus: control would POST a signed JSON body to configured URLs. The events worth sending are a deployment reaching `succeeded`, `failed`, `build_failed` or `cancelled`, a rollout candidate rejected, an automatic rollback, a node going stale and recovering, and an ingress node reporting `failed`. Webhooks send state changes, never metrics, and depend on event hygiene so that an event always means something happened.

### Live commands

Status: proposed, depends on M5.

Today's `tug logs` is a tail through the command queue. The M5 streaming channel would add `tug logs <service> -f`, agent and daemon logs for troubleshooting, and `tug ps` and `tug inspect <service>` with per-container state. These answer what is happening right now on a node and complement metrics, which answer what has been happening. An optional `tug top` would render the agent-reported stats as a refreshing table of CPU, memory and restarts per service, reading `GET /metrics` or a read-only JSON view rather than a new data path.

### Test gate

Status: proposed.

Modelled on madplay's `@magplay/observability` package: metrics sit behind a small injectable interface whose default is a no-op, so unit tests of control and agent logic need no registry; a small closed outcome taxonomy (`success`, `failure`, `timeout`, `rejected`, `cancelled`) with one helper that maps an error to an outcome; and a CI check (`test:observability`) that fails when the code and the documentation disagree.

For Tug the equivalent check would assert:

- every metric registered in code appears in this page's metric tables with the same name, type and label set, and every row in the tables is registered in code;
- every label name is on an allow-list, and none is `id`, `version`, `error`, `path` or `message`, so cardinality stays bounded;
- `GET /metrics` without a token returns 401 and with a `read` token returns 200, and `ROUTE_ROLES` lists the route;
- a scrape after a token is created and used contains no token value, join key or secret value;
- with the no-op default, the existing control and agent tests behave unchanged.

## Rollout order

1. Event hygiene (in progress). Independent of everything else.
2. Structured logs and the `/metrics` endpoint on control with the control-side metrics and the readiness endpoint, plus the test gate so later metrics cannot ship undocumented.
3. Agent-reported node and service stats, then ingress metrics once the open questions are settled.
4. Sample alert rules (they need steps 2 and 3) and outbound webhooks.

Dependencies: the live commands need M5 (the streaming channel), and webhooks and the dashboard are M8 items. Steps 1 to 3 need neither.

## Open questions and non-goals

Open questions:

- Where the first dashboard JSON would live: in this repository (for example a `dashboards/` directory) or published separately, and whether the M8 read-only web dashboard makes it unnecessary.
- Whether agents should send stats on every poll or on a slower interval of their own.
- Whether `/metrics` should accept the operator token as well as named `read` tokens (the operator token passes every role check today).
- How the ingress metrics reach control (see [Ingress metrics](#ingress-metrics)).
- Whether control should keep a short history of stats for `tug top` and a dashboard without Prometheus.

Non-goals: a log aggregation system (JSON on stdout is the interface), distributed tracing, and a bundled Prometheus, Alertmanager or Grafana. Tug would expose metrics and document how to scrape them; running the monitoring stack is the operator's choice.

See also [Architecture](architecture.md), [Control plane](control-plane.md), [Networking](networking.md), [Testing](testing.md) and the [Roadmap](roadmap.md).
