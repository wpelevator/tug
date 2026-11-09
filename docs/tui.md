# Terminal UI (`tug tui`)

**Status: phases 1 to 3 are implemented** (the read-only overview, live detail, and confirmed actions). Phases 4 and 5 are proposed; [Phasing](#phasing) says what is and is not built. This page records why the screen exists, the situations operators open it for and the information each one needs, and how the screen answers them. It is a [K9s](https://k9scli.io/)-style full-screen view of the whole setup and a client of the controller, following the split in [Consoles](consoles.md): nothing here changes where state lives or adds a listener to control.

K9s is a live, keyboard-driven table of Kubernetes resources with drill-down, a `:` command line, `/` filter and one-key actions. The Tug counterpart is smaller on purpose: a few nouns (node, project, service, deployment), one control plane, and a [`tug status`](observability.md#what-exists-today) that already answers "what is going on" as text. The screen is `tug status` kept live, ranked by what needs attention, and navigable down to a container's logs.

## Using it

```bash
tug tui                 # the overview: attention first, then projects, nodes and events
tug tui nodes           # open on a view: overview, projects, nodes, services, deployments, events, backups, restores, domains, volumes, secrets or credentials
tug tui --readonly      # hide every key that changes something, including the shell
tug tui --once          # print the attention summary and exit 1 when anything of rank 1 to 3 needs attention
tug tui --json          # the same summary as JSON (implies --once)
```

The full screen needs a terminal on stdin and stdout; without one, `tug tui` says so and points at `--once`. It uses the resolved credential, control URL and project like every other command, and needs no more than the `read` role to look: keys that need a higher role are refused with the missing role named. `--once` is the form for cron, a shell prompt or a monitor, and answers with the same ranked list as the screen (see [Attention rules](#1-is-everything-fine-the-glance)); rank 4 items are shown but do not fail the exit code.

## Verdict

Feasible with what exists, and built without a controller change beyond one small read route. Four things shaped it:

1. **Polling is the floor, push is the fast path.** `GET /api/v1/status` is one bounded read (projects, the 20 latest deployments, nodes, per-node project status), so polling it every 3 seconds is cheap and is the baseline. The screen also opens control's [watch channel](architecture.md#operator-watch-channel) and, while it is open, refetches only what a hint names, takes new events from the stream without a request, and polls a quarter as often as a backstop. The header says `● live · push` then. Without the channel (an older control, a proxy that drops WebSockets) it polls at the normal rate and nothing else changes.
2. **Live detail already has a channel.** `ps`, `inspect`, `logs --follow` and `exec -t` run through the WebSocket live channel ([CLI](cli.md#services-and-volumes), `runCliLive` in `src/cli/live.ts`), including PTY resize. The screen reuses that transport for the log view, the inspection pane and the shell, so those features are not new protocol.
3. **Two things cannot be shown honestly yet.** CPU, memory, disk and restart counts need the agent stats of [M9](observability.md#node-and-service-stats-reported-by-agents); until then the screen shows container state from `ps` on demand and nothing resembling `top`. The caller's own role is not in the credential file (`Credential` holds only url, CA, certificate and key), so control gained `GET /api/v1/whoami` (`read`), which returns the credential name, role and project scope; a control without it leaves the role unknown and the screen lets the control decide.
4. **Roles shape the screen.** `GET /api/v1/nodes`, diagnostics, credentials and backup destination are `admin`; `logs`, `exec`, `ps` and `inspect` are `deploy`; the rest is `read`. A `read` credential still gets nodes from `status`, but without address, ingress and labels, and the screen never asks for admin-only routes it cannot use.

It is a good fit for the product (one operator, a few servers, SSH-like habits) and small enough not to compete with the [console](consoles.md) work, which serves teams and agents rather than the person at a terminal.

## Who opens it, and what they need

Three people, one tool.

| Persona | Situation | Wants |
| --- | --- | --- |
| Solo operator | Runs one to four VPSs for a few sites. Opens a terminal, wants to know it is fine. | A single screen that is green or says exactly what is not. |
| Deployer | Pushed from CI or a laptop and wants to watch it land. | Rollout progress per node and service, the failure reason, rollback in one key. |
| Responder | Paged or told "the site is down". Possibly on a laptop in a hurry, over a bad link. | The failing thing first, the reason beside it, logs one key away, a shell one more. |

## User flows

Each flow lists the question, the information that answers it with its source today, and the actions that follow. Source column: `status`, `events`, `nodes` (admin), `services`, `backups`, `restores`, `holds`, `domains`, `volumes`, `diagnostics` (admin) are `/api/v1` reads; `live` is the WebSocket channel; `proposed` does not exist yet.

### 1. Is everything fine? (the glance)

Opened first, often daily, often left running on a second monitor. This is the screen's reason to exist, so everything else is built to feed it.

| Information | Source | Notes |
| --- | --- | --- |
| Control reachable, and how stale this screen is | the poll itself | Show seconds since the last good poll; never show old data as current. |
| Control version against the CLI version | `GET /api/v1/version` | Version skew between CLI and control is a known failure mode; show it in the header. |
| Nodes online, stale, disabled, last seen | `status` | `stale` means no recent contact, not that the machine is off ([Nodes](nodes.md#status-and-diagnostics)). |
| Per project: current deployment, version, state, age, who deployed | `status` | The current deployment can fall outside the 20 returned rows; show "not in recent results" rather than hide the project. |
| Services serving against expected, per node | `status` (`serviceStates`) | `serving` is a rollout state, distinct from node connectivity and deployment state. |
| Backup freshness per target, last failure | `backups` | The same signal as `tug backup list --check`: stale, failed or missed. |
| Warnings and errors since the last look | `events` | Includes `ports.public` and automatic rollbacks (`system:auto-rollback`). |
| Certificate expiry, ingress state, clock skew | `diagnostics` (admin) | Polled slowly; omitted for a `read` credential. |
| Held services, interrupted restores | `holds`, `restores` | A project left locked is an outage that looks quiet. |

The result is an **attention list**: one ranked line per thing that is wrong, each with its reason and the key that opens it. Empty means green. Rules are pure functions of the snapshot (see [Architecture](#architecture)) so they are testable and the same ranking appears in the header counters.

| Rank | Condition |
| --- | --- |
| 1 | Service failed to apply on a node; project locked by an interrupted restore; control unreachable |
| 2 | Node stale; deployment failed or in progress longer than expected; automatic rollback happened |
| 3 | Backup stale, failed or missed; certificate expiring; clock skew; version skew |
| 4 | `ports.public` warning; held services; a node registered whose agent has not connected yet. Shown, but they do not fail `--once` |

### 2. Watch a deploy

Question: is it rolling out, which node, did it stick?

- Deployment state: `building`, `rolling_out`, `succeeded`, `failed`, `build_failed`, `cancelled`, with version, actor and elapsed time (`status`).
- Per node and service rollout: `pending`, `pulling`, `starting`, `health_checking`, `serving`, `held`, and `rolloutError` (`status`). A rejected candidate keeps the old revision serving; show both revisions so "failed deploy, site still up" reads correctly.
- Recent `service.*` events for the project (`events`).
- Actions: cancel the active deployment, roll back (`deploy` role, confirm), tail logs of the service that is not coming up.

### 3. Something is broken (triage)

Question: what, where, why, what do I do?

The path is always the same, and the screen makes it a drill-down: attention line, project, service, node, detail.

- Failure reason: `rolloutError`, the agent's `error`, the failing health check ([Health checks](healthchecks.md)).
- Placement: which nodes run this service, which of them are healthy.
- Container truth: state, exit code, restarts, image digest, published port (`ps`, `inspect` through `live`; `inspect` redacts environment values).
- Timeline: events for the project, newest first, with the acting credential.
- Actions: follow logs, restart the service, open a shell (`exec -t`), run a one-off command (`run`), roll back. All `deploy`.

### 4. A node is stale or misbehaving

Question: how bad, and what is on it?

- Status, last seen, address, ingress capability, labels (`nodes`, admin), certificate expiry and clock skew (`diagnostics`, admin).
- Blast radius: every project and service placed on it, and whether another node serves them (`status`).
- Actions: run host diagnostics through its agent (admin, waits), disable (admin, confirm by typing the name). Replacing or repairing a node is an SSH flow ([Nodes](nodes.md)); the screen prints the command to run rather than doing it, so it never needs a way into the host.

### 5. Are backups working, and can I restore?

- Per project and target: schedule, last snapshot time and size, last result, stale or missed (`backups`), destination configured (`backups`), restores in flight, interrupted or released (`restores`).
- Actions: run a backup now (`deploy`), resume or release an interrupted restore (admin, destructive, confirm by typing). Starting a restore is deliberately not in the first slice: it takes a plan, a snapshot and a confirm, which the CLI already does well.

### 6. Is traffic routed and encrypted?

- Hostname to project and service routes, mapped domains, ingress node state, route count, config hash (`domains`, `status` ingress, `diagnostics`).
- Actions: add or remove a domain (`deploy`).

### 7. Who changed this?

- Events across projects with actor, filtered by actor, project, level or text (`events`). The audit trail is already the evidence; the screen only makes it searchable and time-ordered next to the state it explains.

### 8. Housekeeping (low frequency)

Volumes and their nodes, secret names with versions (never values), credential list with role, scope, last use and expiry, image archives that `image prune` would remove. Read-only in the first slice. Credentials about to expire belong on the attention list.

## Design principles

1. **Attention first.** The first screen is the ranked problems, not a menu of resources. K9s shows a resource table because Kubernetes has hundreds of objects; Tug has a dozen, so the screen can afford to judge.
2. **Never display stale data as current.** Every pane carries its data age. A failed poll turns the header to "disconnected" and shows how old the data is; it never blanks or silently freezes.
3. **Four states stay separate.** Node connectivity, project apply result, service rollout state and deployment state are different facts ([Terminology](terminology.md)). Use their own words and columns; do not collapse them into one traffic light except in the summary, where the rule is written down.
4. **Read-only is the default posture.** Mutations appear only when the role allows them, are marked, and ask before acting. `--readonly` refuses them with a stated reason.
5. **Nothing the CLI cannot do.** Every action maps to an existing command and API route, so the audit trail, project lock and role checks are the ones already tested. The screen adds no privileged path.
6. **No new infrastructure.** No daemon, no extra port, no state on disk and no new dependency.
7. **Works on a bad link.** Small polls, backoff on failure, and a `--once` mode that prints the attention list and exits nonzero when anything is wrong, usable from cron and prompts.

## Screen design

Header, body, footer, in that order. The header and footer never scroll. This is the overview at 100 columns, as `render` draws it from the fixtures in `tests/tui-fixtures.ts`:

```
 tug  control-3fa9.tug  v1.2.0  admin                                                    ● live 2s
 Nodes 3/4 online   Projects 2   Services 4/6 serving   Backups 1 problem   Events 1 error · 0 warn
─ Attention (3) ────────────────────────────────────────────────────────────────────────────────────
   WHAT              WHY                                                      AGE
✖  site/web on app2  failed to apply: health check GET /healthz returned 503  4m
▲  node app3         stale, last seen 12m ago; hosts site/db                  12m
▲  backup site       service:db: last success 31h ago, schedule daily         1d
─ Projects ─────────────────────────────────────────────────────────────────────────────────────────
PROJECT  VERSION  DEPLOYMENT  SERVICES  NODES  BACKUP   AGE  BY
blog     v7       succeeded   2/2       1/1    -        3d   kaspars
site     v42      succeeded   2/4       1/3    problem  2h   ci-github
─ Nodes ────────────────────────────────────────────────────────────────────────────────────────────
NODE  STATUS  LINK  LAST SEEN  SERVICES
app1  online  -     3s         site/db site/web
app2  online  -     2s         site/web
app3  stale   -     12m        site/db
app4  online  -     4s         blog/db blog/web
─ Events ───────────────────────────────────────────────────────────────────────────────────────────
AGE  LEVEL  PROJECT  TYPE            ACTOR      MESSAGE
4m   error  site     service.failed  -          web on app2: health check returned 503
4m   info   site     deployment      ci-github  v42 rolling_out by ci-github
 ? help  q quit  :view  / filter  enter open  e events  d describe  l logs  i inspect  p ps  s shel…
```

- **Header** shows control identity, control version (with the CLI's when they differ), the credential's role, connection state with the age of the data, and counters computed from the same list the attention pane shows, so the two cannot disagree. Services count a stale node's services as expected but not serving. `● live · push` replaces the data age while the watch channel is open. The nodes table has a `LINK` column: `stream` when the agent holds its socket to control, `poll` when it does not (or uses the long-poll fallback), `-` from a control that does not say; a stale node whose stream is still open says so in the attention list, since that agent is running and not reconciling. Before the first answer it says `○ connecting` and the panes say they are waiting, never "nothing needs attention"; after a failed poll it says `◌ disconnected · data 40s old` and keeps the last data on screen.
- **Attention rows** carry an age where one is known: a failed apply from the agent's `service.failed` event (status reports have no start time, since their timestamp changes on every poll, so with no event there is no age), a stale node from its last contact, a backup problem from the last success, an event-based note from the event. Rank 4 notes (public ports, held services, a node that never connected) are dimmed and marked `·` instead of `▲`, so they do not compete with failures.
- **Overview** is four panes (attention, projects, nodes, events). `tab` moves between panes and each pane remembers its selection by identity, so a refresh that reorders rows does not move it. `enter` opens the selected row. On a terminal too short for all four it shows the attention pane and the focused pane.
- **Resource views** are K9s-style tables with the same chrome: `:projects`, `:nodes`, `:services`, `:deployments`, `:events`, `:backups`, `:restores`, `:domains`, `:volumes`, `:secrets`, `:credentials`, each taking an optional project (`:events site`). `esc` goes up one level and the breadcrumb (`overview › site › web@app2`) shows where you are. Domains, volumes and secrets load for one project (the resolved project unless named) and credentials are control-wide (admin).
- **Drill-down** is attention row or project → the project's services by node (rollout state and error) → one placement: rollout state, error, image, port, revision, the deployment, and recent `service.*` events. A node opens its address, ingress, labels and the services on it.
- **Log view** follows `logs -f` for the selected placement over the live channel, with a 2,000-line ring buffer, follow and pause (`space` or `f`), a text filter (`/`), `c` to clear, and the connection state in the title. A project's `p` and a service on several nodes first ask which node, as `tug logs --node` requires.
- **Inspect, ps and describe** open a scrollable text screen: `i` the redacted `docker inspect` of the container, `p` the project's containers on one node, `d` the selected row as JSON.
- **Shell** leaves the alternate screen, runs `exec -t sh` on the live channel, and on exit restores the screen, flashes a nonzero exit code and redraws.
- **Footer** shows a message line (command line, filter, confirmation prompt, or a flash that expires) and the hints for the current view, listing only what the role and `--readonly` allow.

### Keys

K9s habits are kept where they carry over. Anything that mutates asks first.

| Key | Action | Needs |
| --- | --- | --- |
| `:` | Command line: jump to a view by name or unique prefix; `tab` completes | any |
| `/` | Filter the current table: a word, `!word` to exclude, `column=word` for one column | any |
| `enter`, `esc` | Open the row, go up a level (`esc` first clears a filter) | any |
| `tab`, `shift-tab` | Next or previous overview pane | any |
| `up`/`down`, `j`/`k`, `pgup`/`pgdn`, `g`/`G` | Move the selection | any |
| `e` | Events for the selected row's project | read |
| `d` | Describe: the row as JSON | read |
| `l` | Follow logs | deploy |
| `i` | Inspect the container (environment values redacted) | deploy |
| `p` | List the project's containers on a node | deploy |
| `s` | Shell in the container | deploy, not in `--readonly` |
| `r` | Restart the service on every node that runs it | deploy, confirm |
| `R` | Roll the project back (never forced, so it refuses while a deployment is active) | deploy, confirm |
| `x` | Cancel a deployment that has not finished | deploy, confirm |
| `b` | Run a backup now: the selected target, or every target of the project | deploy, confirm |
| `ctrl-r` | Poll now | any |
| `?` | Key help | any |
| `q`, `ctrl-c` | Close a screen, then quit; `ctrl-c` quits from anywhere | any |

Confirmations are a `y/N` prompt naming the project and action, and only `y` confirms. A key the role cannot use says which role it needs; an action whose selection does not fit says what to select ("select a service to restart").

## Architecture

The screen is a thin client in `src/cli/tui/`, registered as `tug tui` in `src/cli/commands/tui.ts`, using the same config resolution and `request()` as `tug status`. It imports no control or agent code ([Architecture](architecture.md#source-layout)). Everything that decides what is shown is a pure function of a snapshot, so it is tested without a terminal.

| File | Role |
| --- | --- |
| `types.ts` | The snapshot (one `Feed` per resource: data, fetch time, last error), tables and rows, attention items and counters |
| `derive.ts` | `nodeReports`, `deriveAttention` and `deriveCounters`: the ranking and the numbers, pure |
| `tables.ts` | The table or text each view shows, and the filter |
| `panes.ts` | The overview panes and how the body height is shared among them |
| `state.ts` | `reduce(state, input, env) → { state, effects }`: every key, mode (normal, command, filter, confirm, pick, help) and screen, with no I/O |
| `render.ts` | `render(state, env, options) → string[]`: one frame, exactly the terminal's size |
| `actions.ts` | Restart, rollback, cancel and backup, mapped to the routes the CLI uses, with role checks |
| `poller.ts` | Keeps the snapshot fresh, one independent loop per feed |
| `app.ts` | The terminal: alternate screen, raw keys, frame diff, live logs, inspect, the shell and actions |
| `once.ts` | The `--once` text and JSON |
| `format.ts` | `sanitize`, ages, column fitting and colour |

```
poller ──▶ snapshot ──▶ deriveAttention ──▶ render(state, frame) ──▶ line diff ──▶ stdout
  ▲                                              ▲
  │ requests                                     │
control                  stdin keys ──▶ reduce(state, key) ──▶ effects (logs, shell, action, load)
```

- **Push.** `src/cli/watch-client.ts` keeps the watch socket open (reconnecting with backoff and jitter, validating every frame) and the poller reacts to it: `watch.ready` and `watch.resync` refetch everything, `watch.changed` refetches only the feeds it names, and `watch.events` rows are merged into the event list by id with no request. While it is open the polling intervals below are four times longer; when it drops they return to normal.
- **Poller.** `status` every 3 seconds, events every 5, backups, restores and nodes every 30, diagnostics every 60, and an on-demand list every 15 while loaded, each with up to 10% jitter and backoff (to eight times the interval) after failures. `whoami` and the control version are asked once. One request per feed is in flight at a time. Nodes and diagnostics are admin-only and are not requested unless `whoami` says admin (or is unavailable, in which case one 403 turns them off for good). A failed poll keeps the last data and records the error beside it. Each request opens its own pinned mTLS connection, as every CLI call does; a long-lived connection is a possible later saving.
- **Selection** is remembered by row identity per table, so it survives a refresh that reorders rows.
- **Derivation.** `deriveAttention(snapshot, now, cliVersion)` owns the ranking and is the part to test hardest, since it is what the operator trusts. A stale, disabled or unknown node's last report is never read as current health; control is reported unreachable after 15 seconds without an answer, or at once before the first.
- **Render.** Pure and sized: `columnWidth` and `clipToColumns` from `src/cli/width.ts` keep wide characters aligned, and on a narrow terminal the other columns give way first (down to a readable floor) while the column that carries the reason (why, message or error) shrinks last. Colour is on only for a terminal without `NO_COLOR`; state is always also a word or symbol.
- **Terminal.** The alternate screen, a hidden cursor and raw mode are entered on start and restored on quit, error, `SIGTERM`, `SIGHUP` and process exit. Each frame is diffed against the last and only changed lines are written; an idle screen writes nothing but the age ticks. A resize redraws.
- **Live sessions.** Logs, `ps` and `inspect` go through `CliLiveTransport.open`; closing the screen aborts and closes the session. Log bytes are decoded as UTF-8 across chunk boundaries, split into whole lines and sanitized before they are stored.

### Dependencies

No new runtime dependency. Alternatives considered:

| Option | Verdict |
| --- | --- |
| Hand-written ANSI renderer with a line diff | **Chosen.** About a thousand lines of source, nearly all pure functions that unit-test without a terminal. Keeps the dependency list as small as it is, and keeps the [standalone binary](standalone-binary.md) free of another thing to bundle and verify under Bun. |
| Ink (React for terminals) | A familiar model, but it brings React and a layout engine, and the binary prototype already hit module-ordering failures with decorators and `reflect-metadata`; another bundler hazard for a screen drawn in lines. |
| blessed or neo-blessed | Widgets for free, but unmaintained and large; its terminal handling is the part most likely to rot. |
| terminal-kit | Maintained and capable, but it owns input and drawing together, which makes the pure-view testing above harder. |

### Prerequisites

None blocked the first three phases. In order of value, each an additive minor under [the frozen contracts](releases.md#what-10-freezes):

1. **`GET /api/v1/whoami`** (`read`): done. It lets the screen hide actions the role cannot use instead of learning from a 403, and is useful to `tug` itself.
2. **Events cursor and change feed** (`events?after=`, `GET /api/v1/watch`): done, see [Architecture](architecture.md#operator-watch-channel).
3. **Agent stats and `/metrics`** ([M9](observability.md)). Adds CPU, memory, disk, restarts and a sparkline column to services and nodes. Without it the screen does not pretend to be `top`.
4. **A single summary endpoint**, only if the multi-call poll proves heavy. `status`, `backups` and `restores` for one screen are a few small reads; measure before adding a route.

## Security

- The screen is an operator client holding an operator credential, like the CLI. It adds no listener, no cache of secrets, no state on disk and no write path other than the existing routes, each checked by control against the credential's own role and project scope. Scoped credentials see only their projects, because `status`, `events`, `backups` and `restores` are already filtered.
- Log lines, event messages, versions, error text and every name in a table come from workloads and users, so they are untrusted. `sanitize` strips escape sequences (CSI, OSC and two-character escapes) and replaces the remaining control characters before anything is stored or drawn, so a container cannot retitle the window, move the cursor or write to the clipboard through the screen. The shell is the one place raw bytes pass through, and it is the PTY of the user's own command.
- `inspect` shows environment names only, as the CLI does. Secret values are never fetched, and the secrets view lists names and versions.
- `R` never sends `force`, so a rollback during an active deployment is refused by control as it is for the CLI.
- A screen left open on a shared machine keeps a connection and the credential in memory. A lock key that blanks the screen is proposed for phase 4.

## Testing

Per [Testing](testing.md), with assertion messages that state the expected behavior. All of it runs in `npm test` without a terminal or Docker:

- `derive.test.ts`: snapshots to attention lines and counters, covering failed applies, stale nodes whose last report must not count, unreachable control, failed, stuck and rolled-back deployments, backup problems, interrupted restores, version skew, an unreadable report and a never-connected node.
- `render.test.ts`: frames at 100x26, 80x24, 60x14 and 40x8 are exactly the terminal's size and never wider than its columns; the overview order, the healthy and connecting states, a failing control, a short terminal, wide characters and escape sequences from workloads, colour and `NO_COLOR`, drill-down, placement detail, a deployment outside the returned rows, and filter syntax.
- `state.test.ts`: scripted keys through the reducer: drill and back, pane focus, selection surviving a reorder, filter, command line and completion, list loading, confirm and cancel, role and `--readonly` refusals, logs and the node picker, scrolling and the log ring buffer, describe, inspect, shell and quit.
- `actions.test.ts`, `poller.test.ts`, `format.test.ts`, `once.test.ts`: the request each action sends, a failed poll keeping data, 403 turning an admin feed off, timers cleaned on stop, `sanitize`, ages and the exit rule.
- `app.test.ts`: the whole runtime on fake terminal streams, a fake API and a fake live transport: alternate screen entered and restored, quit and `ctrl-c`, no redraw when idle, logs reassembled and sanitized and the session closed with the screen, inspect, `R` then `y` and `n`, read-only, a dropped control, and the shell hand-over and return.
- `screen.test.ts`: the same runtime with its output fed into a real terminal emulator (`@xterm/headless`, a dev dependency), so the checks are on what a terminal shows after applying the escape sequences: the alternate screen is used, many incremental updates leave exactly what a clear-and-redraw shows, a closed log screen leaves nothing behind, a resize redraws at the new size, the shell gets the normal screen and the overview returns, and quitting leaves the normal screen clean. `tests/tui-harness.ts` holds the fake terminal, API and live transport that `app.test.ts` and `screen.test.ts` share.
- `cli.tui.test.ts`: the real command against an mTLS control: `--once`, `--json` with the role and version from `whoami`, no terminal, an unknown view and an unreachable control. `credentials.test.ts` covers `whoami` and the role matrix.

Not covered by automated tests: a full run against a live agent with a real container (the log, inspect and shell paths are tested against the live transport interface, and `runCliLive` has its own suite), and rendering in specific terminal emulators beyond xterm.js (a pseudo-terminal run of the real command was done by hand, not in the suite).

## Phasing

1. **Read-only overview** (done). `tug tui`, `--once`, header, attention list, projects, nodes, events, resource tables, drill-down and filter. Answers flows 1, 4 (without diagnostics actions) and 7, and the read half of 2 and 3.
2. **Live detail** (done). Log view, `ps` and `inspect` screens, the shell. Completes flow 3.
3. **Safe actions** (done). Restart, rollback, cancel and run backup, behind confirmation, with `whoami` hiding what the role cannot use. Completes flows 2 and 5 for these actions.
4. **Admin and polish** (proposed). Run host diagnostics on a node (`D`), disable a node, and resume or release an interrupted restore, each confirmed by typing the resource name; a screen lock; preferences (default view, colour); context switching between credentials; add and remove a domain; `:secrets` and the rest of flow 8 beyond read-only lists.
5. **With M9** (proposed). Metrics columns and sparklines once agents report stats.

## Command name

The name is part of the CLI contract, so it is hard to change after release ([Releases](releases.md#what-10-freezes)). Candidates:

| Name | For | Against |
| --- | --- | --- |
| `tug tui` | Says what it is, cannot be confused with a web console, free of resource-usage expectations. | Jargon; four letters to type for a daily command. |
| `tug ui` | Short and plain. | The roadmap lists a web dashboard and a [console](consoles.md); `ui` would be ambiguous the day either ships. |
| `tug top` | The familiar idiom for a live full-screen view quit with `q`. | `top` promises CPU and memory sorted by usage; without [M9](observability.md) stats it would show none. `kubectl top` and `docker top` both mean something narrower, and this screen sorts by attention. |
| `tug watch` | Describes the behavior. | Suggests a non-interactive refresh like `watch(1)`, and would blur with the proposed `/api/v1/watch` change feed. |
| `tug status --watch` | No new command; the screen is status kept live. | Interactive drill-down, a shell and mutations do not belong on a read command, and scripts that parse `status` must stay unaffected. |
| `tug term`, `tug terminal` | Plain words. | In Tug a terminal is the interactive shell of `exec -t`, so these read as a way to open one; `term` also reads as terminology. |
| `tug dash` | Short. | Same clash as `ui` with a future web dashboard. |
| `tug console` | Matches Docker and Rails habits. | Collides with the [console](consoles.md) concept. |
| `tug k9s`-like brand names | Instantly understood by Kubernetes users. | Borrowed branding; vocabulary [Terminology](terminology.md) asks not to import. |

Decided: `tug tui`. Revisit `top` only if metrics ship and the screen gains a usage-sorted mode, which can then be `tug tui --sort cpu` or a `top` alias added without breaking anything. Adding a name later is a minor; renaming is a major.

## Open questions

- Whether one screen should span several control planes (K9s contexts). Credentials carry one URL each, so switching credential files is the natural unit; deferred to phase 4.
- Whether `tug status` and a future web dashboard should use the attention rules too. They live in `src/cli/tui/derive.ts` as pure functions of a snapshot, so moving them to a shared module is cheap when a second consumer exists.
- Whether the "stuck deployment" threshold (15 minutes) and the unreachable threshold (15 seconds) need to be configurable, or whether the deployment's own timeout is enough.
- Whether a long-lived connection (or one multi-request exchange) is worth it to cut the TLS handshake per poll.
