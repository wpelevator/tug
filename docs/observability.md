# Observability

**Status: minimal operational telemetry implemented.** Metrics, readiness, structured logs and best-effort webhooks cover control operations. Continuous resource and ingress request telemetry remain external.

The aim is the smallest setup that answers the day-to-day questions: is every node reporting, did the last deployment succeed, did an automatic rollback happen, will a certificate expire, is the control database growing. It follows the shape of the rest of tug: one central control plane, agents that only dial out, and no required extra services.

## What exists today

Verified against the code on `main`.

| Capability | What it does | Limits |
| --- | --- | --- |
| Audit trail | Deployments and events record the acting credential, and `system:auto-rollback` for automatic rollbacks. See [Access control](access-control.md). | Answers who acted, not how the system behaves |
| `tug status` | Summarizes deployments, errors and node reports; `--json` prints `GET /api/v1/status` as JSON: projects, the 20 latest deployments, nodes with `status` and `last_seen_at`, and per-node project status including health, rollout state, port and rollout error. | Node health is a last observation, not a live probe; a node is marked `stale` only when this endpoint is called, using `TUG_STALE_SECONDS` (default 60). The current deployment can be outside the 20 returned rows. |
| `tug tui` | A live full-screen view of status, events, backups and restores with a ranked attention list, logs, inspect and a shell; `--once` prints the attention list and exits nonzero when something is wrong, for cron. See [Terminal UI](tui.md). | Same polling as `status`; no CPU or memory until M9 |
| Watch channel | `GET /api/v1/watch` (WebSocket, `read` role) pushes change hints and new events as they happen, filtered to the credential's projects; `GET /api/v1/events?after=<seq>` follows the log. See [Architecture](architecture.md#operator-watch-channel). | Hints, not state: clients refetch, and polling stays the backstop |
| `tug events` | Lists events from `GET /api/v1/events`, newest first, at most 500 per call, 100 by default. | Agents report on change only, see [Events](#events) |
| `tug doctor` | Local checks (Node.js and Docker), control checks (SQLite, CA and server certificate expiry, each node's certificate expiry and connectivity, each online node's observed clock skew, master key, Docker, ingress state, ports 80 and 443 on ingress nodes, and control's load, memory, disk and container CPU and memory) and, with `--nodes` or `--node`, host diagnostics through each agent, including the node's load, memory, free disk and the CPU and memory of the agent and Caddy containers. A local Docker daemon is checked only for `--build-local` and prints `skip` when absent. See [`tug doctor`](cli.md#tug-doctor). It waits for those results, prints one line per check (the full document with `--json`) and exits nonzero when a check fails. Clock skew is unknown, not zero, for a node that is offline. | A point-in-time check, not a time series. Resource values are one sample (CPU is measured over about a second) and have no thresholds |
| `tug logs <service>` | Prints a service log tail; `--follow` streams logs through the live channel. | Following logs requires an active WebSocket session. |
| `tug ingress logs <node>`, `tug ingress tls` | The ingress node's Caddy output, and per-host certificate state from a TLS handshake against that Caddy, shown also in `domain list`, `status` and `doctor`. See [Certificate status](ingress.md#certificate-status). | `admin` only. State is a probe every twenty seconds to an hour, not a stream |
| Reachability | Control has no unauthenticated route, not even a health check: every request needs a client certificate. Monitor TCP reachability of the mTLS port for liveness, and use authenticated `GET /api/v1/readyz` for control readiness ([Health endpoints](#health-endpoints)). | A TCP check proves the listener accepts connections, not that the database works |
| Process logs | Text or JSON records with levels and available operation context. | No integrated log retention or search |

Continuous resource history, application request metrics and an integrated dashboard are not collected by tug. Managed Caddy enables its own loopback metrics; see [Ingress metrics](#ingress-metrics).

### Events

Agents report lifecycle events for the recreated services of a project (`service.pulling`, `starting`, `health_checking` and `serving`) only when something about the project changes: a new desired revision, a different Compose file rendered for the node, or different secret versions. A failed apply produces one `service.failed` event (level `error`) naming the service whose check failed and why, retries of the same failure add nothing, and recovery produces one `service.serving` event. Agents still apply and health-check the project on every poll, so only the events are quiet. After each pass the agent also looks at the containers: a service Docker keeps restarting, or that exited with an error (not 0, 137 or 143) and stays down, is reported with `unstable` set to the reason, and `tug status` and `tug tui` show it as `unstable` rather than `serving`. The deployment itself stays `succeeded`, because it did converge. A `ports.public` event (level `warn`) says published ports were bound to a public node address ([Networking](networking.md#published-ports-private-by-default)); it is sent once per change, not per poll. Control deletes events older than `TUG_EVENT_RETENTION_DAYS` (default 30) and keeps at most `TUG_EVENT_MAX_ROWS` (default 100000), at startup and then at most once an hour while agents report; `0` turns a limit off. See [Architecture](architecture.md#events) and [Configuration](configuration.md#control-plane).

Before [PR #13](https://github.com/wpelevator/tug/pull/13) agents emitted those four events for every non-rolling service on every poll, whether or not anything changed. On a real control plane with nothing deploying that was about 71 events a minute, roughly 100,000 a day, nothing deleted them, and the default `tug events` view (the last 100) covered about a minute and a half and hid real events such as an automatic rollback.

Containers that crash, are killed for memory or report unhealthy produce `container.exited`, `container.oom`, `container.unhealthy` and, for repeated crashes, one `container.crashloop` event, from the Docker daemon's event stream rather than from the next poll ([Architecture](architecture.md#container-events-from-the-docker-daemon)). Restart counts and a restart-rate metric are still proposed under [node and service stats](#node-and-service-stats-reported-by-agents).

## Structured logs

Control and agents write text logs by default at level `info`. Set `TUG_LOG_FORMAT=json` for one JSON object per line, or `TUG_LOG_LEVEL=debug|info|warn|error` to select the minimum level. JSON records include timestamp, level, component and a fixed message, with available project, deployment and node context. Control responses include `x-request-id`; the matching completion record includes that ID, method, route pattern, status and duration. Request bodies, query strings and raw error details are excluded. Allowlisted failure classes and codes, HTTP status and numeric SQLite codes retain diagnostic categories without arbitrary exception messages. Sensitive context keys are redacted, but a secret deliberately included in an arbitrary message or resource name is outside that protection. Logs are process output for your existing collector; tug does not store another log database.

## Metrics on control

Scrape authenticated `GET /api/v1/metrics` using a `read` credential over mTLS. Scoped credentials see only their projects' deployment and backup series; unscoped credentials also see nodes, control writer and webhook delivery. No deployment IDs, command IDs, error messages or raw URLs are metric labels. State counts come from SQLite and survive restarts; webhook delivery counters reset on restart; pending delivery is a gauge.

| Metric | Meaning |
|---|---|
| `tug_node_reported` | Whether the node has ever reported; check this before interpreting poll age |
| `tug_node_poll_age_seconds` | Age of its last report, zero when absent |
| `tug_deployments` | Recorded deployments grouped by project and state, including retained history |
| `tug_backup_targets` | Enabled backup targets grouped by project and latest run state |
| `tug_backup_has_success` | Whether a configured target has a successful snapshot; zero means protection has not been established |
| `tug_backup_success_age_seconds` | Age of the target's last success; use with `has_success` |
| `tug_writer_queue_depth` | Operations waiting for the single control writer |
| `tug_writer_active_age_seconds` | Age of active writer work, zero when idle |
| `tug_webhook_delivered_total`, `tug_webhook_failed_total`, `tug_webhook_dropped_total`, `tug_webhook_pending` | Delivery outcomes, overflow and current backlog |

Prometheus needs the CA, certificate and key from a read credential:

```yaml
scrape_configs:
  - job_name: tug
    metrics_path: /api/v1/metrics
    scheme: https
    tls_config:
      ca_file: /etc/prometheus/tug-ca.pem
      cert_file: /etc/prometheus/tug-read.crt
      key_file: /etc/prometheus/tug-read.key
    static_configs:
      - targets: ['control.example.com:8443']
```

### Health endpoints

Authenticated `GET /api/v1/readyz` returns 200 when the persisted projects table can be read and active writer work has not exceeded 35 minutes. This gives default 30-minute operation deadlines a five-minute margin. It returns 503 with sanitized check states when those checks fail, without waiting behind the writer. The read probe does not establish database writeability. After control restore closes the database, the existing generic restart-required 503 takes precedence until restart. Monitor this endpoint externally: a dead control cannot notify you of its own failure. A TCP connection to the mTLS port establishes listener liveness only.

## Alerting

Set both `TUG_WEBHOOK_URL` (an HTTPS receiver) and `TUG_WEBHOOK_SECRET` on control to enable notifications. Leaving both unset disables delivery; setting only one fails startup. Control checks committed events and deployment/node transitions every five seconds, independently of operator views. It sends actionable generic descriptions and resource identifiers for supported failures, backup results and stale/recovered nodes; raw event messages, commands and metadata are excluded. The observer processes up to 100 new events each tick and the latest 1000 deployment records; this is sized for tug’s small-server scope and is not a durable incident ledger.

Delivery runs outside the writer, with at most 100 pending/in-flight events, three attempts, a five-second timeout per attempt and exponential delays starting at 250 milliseconds capped at two seconds. Redirects are not followed. Shutdown aborts active delivery and discards queued work. Retries reuse the event ID; receivers should deduplicate it. An exhausted attempt or queue overflow is visible in metrics and delivery exhaustion is logged. The queue and event cursor are in memory: restart drops queued work and does not replay historical events. This is best-effort notification, so retain an independent availability check and schedule `tug backup list --check` as a protection backstop.

Each POST body is JSON with `timestamp` and `event`. Verify `x-tug-webhook-signature` against `sha256=` followed by the hex HMAC-SHA256 of `<x-tug-webhook-timestamp>.<exact request body>`, using the configured secret. Reject timestamps outside your replay window and compare signatures in constant time. `x-tug-webhook-id` identifies the event. Treat this as a control-wide integration: the receiver sees identifiers across projects.

For an external reachability check from a source checkout:

```sh
node tools/scripts/check-reachability.mjs https://blog.example.com/health
```

Run it outside the workload host on a schedule and route a nonzero exit to your notification system. The script accepts URLs as arguments or comma/newline-separated `TUG_PROBE_URLS`; `TUG_PROBE_TIMEOUT_MS` defaults to 5000. It requires a 2xx response without following redirects, removes credentials and query strings from output, and exits 1 for a failed probe or 2 when no URLs are configured. Choose an application endpoint that exercises important dependencies; an HTTP success alone cannot establish business correctness.

## Node and service stats reported by agents

Continuous CPU, memory, disk and restart series remain outside this minimal slice. `tug doctor --nodes` supplies point-in-time resource diagnostics. Use node_exporter or cAdvisor when you need resource history. Agent-reported aggregation through control remains a possible extension for nodes behind NAT.

## Ingress metrics

Caddy exposes per-host metrics on its loopback admin endpoint; tug does not collect or re-export them. Use a collector on the ingress host or private network. Keep Caddy's admin endpoint private. Request latency, traffic and error-rate objectives belong at this application boundary, separately from tug's deployment state.

## Live commands

`tug logs`, `logs -f`, `exec`, `run`, `ps` and `inspect` supply current evidence. Streaming stdin/stdout has end-to-end flow control. Agent/daemon log streaming through the control API and a `top` view remain proposed; process logs are available through Docker today.

## Test gate

Renderer tests cover finite states, label escaping, missing observations and success history. HTTP authorization tests verify project filtering and exclusion of global node/writer state. Notification tests cover signing, sanitization, queue bounds, deduplication and retries. Readiness is tested with a blocked real deployment, an injected clock, database failure and recovery. Fault-test evidence and remaining runtime coverage are in [Testing](testing.md).
