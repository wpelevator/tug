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
| The runtime image shipped without the Compose plugin, so every real deploy failed | Real hosts | Tier 2: `npm run test:smoke:image` runs the shipped image's binaries without any host plugins |
| Reinstalling a mesh node failed the UDP preflight because Tug's own agent holds the WireGuard port | Real hosts | Tier 1: `src/cli-install.test.ts` runs the generated script against fake `ss`, `docker` and `wg` |
| `deploy --build-local` was rejected on containerd image stores, where `docker save` lists a build attestation as an extra top-level entry | Local integration run on Docker Desktop | Tier 1: `src/artifacts.test.ts` builds synthetic archives, including the rejected variants |
| The first rolling deploy started two revisions of the same image | Real hosts | Not guarded yet, see backlog item 1 |
| After control loses its data, agents would not re-report their WireGuard keys | Reading the code while resetting control for the real-host run; worked around, not reproduced | Not guarded yet, see backlog item 2 |
| A control database from before scoped tokens lacks columns the current control writes | Real hosts | Not guarded yet, see backlog item 3 |
| `depends_on.condition: service_healthy` fails the deploy when the image has no Docker `HEALTHCHECK`, and the deploy error omitted the compose message | Real hosts | Tier 1: `src/control.rollout.test.ts` asserts the deployment error includes the node apply error |

## Tier 1: mocked tests

### Conventions that exist

- **Control** runs in-process on a random port with a temporary data directory and real SQLite, so tests exercise the HTTP API without Docker. Agent endpoints are driven directly, with the test acting as the agent (`src/control.rollback.test.ts`, `src/control.network.test.ts`).
- **The agent** takes its Docker and HTTP access as injectable runners (`src/runners.ts`), so tests assert the exact Docker commands issued for a reconcile (`src/agent.test.ts`, `src/agent.images.test.ts`, `src/agent.network.test.ts`).
- **Shell scripts** are tested by running the generated text against fake executables placed first on `PATH`, instead of asserting on strings (`src/cli-install.test.ts`).
- **Image archives** are built in the test, so malformed and hostile layouts can be checked without Docker (`src/artifacts.test.ts`).
- **The CLI** is run against a stub `ssh` that records its arguments (`src/cli.templates.test.ts`).

### SQLite contract and blocking measurements

`src/db.test.ts` runs the reusable factory-driven suite in `tests/db-contract.ts` against the Node adapter. It checks bindings and injection resistance, NULL and missing rows, ordinary object results, numeric change counts, integer boundaries, classified errors, transactions, busy waits, read-only/no-create behavior and connection cleanup. Shared-policy tests cover schemas, persisted agent state, foreign keys, WAL and the 1,000 ms timeout. A future Bun adapter must pass the same suite before it can replace the Node adapter.

Control tests cover duplicate locks/tokens, failed publication rollback, backup validation and restart-required responses. Restore race tests pause actual filesystem I/O; synchronous SQL has no suspension point inside a transaction. The runtime image smoke test executes compiled database code inside the production image and checks that neither SQLite npm addon is present. CI exercises the exact Node 22.18.0 minimum alongside current Node 22 and 24 releases.

Run `node tools/scripts/benchmark-database.js` for a synthetic reference workload of 100,000 events and 1,000 metadata reads. It reports operation duration, timer delay, snapshot size and maximum event-loop delay. On a local Node 24.21.0 run, the reads took 9 ms, the 75 MiB snapshot 218 ms and read-only integrity checking 123 ms; the maximum observed event-loop delay was 219 ms. These are reference measurements, not portable performance guarantees or CI thresholds. Recheck representative production data before relying on backup latency or lease timing.

### Measuring with mocks (proposed)

Today the fakes record commands and return canned output. Extend the fake Docker runner to keep a model of what is running (containers, their Compose project and service, published host ports) and a log of every call. A test can then compute numbers from the log and assert on them, for example:

```ts
assert.deepEqual(metrics(fake), { revisionsStarted: 1, peakRevisions: 2, unchangedServiceStops: 0, leakedPorts: 0 });
```

Inject the clock and sleep into the rollout code so drain and poll timing is tested without real waits.

### Backlog of mocked tests (proposed)

1. **One revision per deployment as endpoints settle.** A rolling service on one node gets an entry in its Compose file for every service on another node that is serving. Those entries are part of the revision's identity, so when the other node's service becomes ready between two polls, the agent starts a second revision of the same image. On the real hosts the first deploy ended with two revisions of the same image, and the surviving one carries such an entry, which points to this cause. The old revision drained and no request failed, but the app was started twice. Decide whether those entries should be excluded from the identity, and pin the decision with a test that counts the revisions started. This applies once rolling deploys (M3) are merged.
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

Exists: the fake VPS suite with registry authentication, the registry-free image delivery suite (remote and local builds, rollback, agent restart, backup and restore), the WireGuard mesh suite, and the packaging smoke tests for the built CLI and the runtime image. The rolling-deploy suite added with M3 already sends continuous requests through the ingress during a rollout and fails on any error.

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
