# Consoles and agent-built control planes

**Status: proposed.** No console, MCP server or generated API description exists. This page records the design for letting users prompt an AI agent for the dashboard or control plane they want on top of the Tug controller, in the spirit of Laravel Cloud, Dokploy and Coolify but without a fixed UI. It depends on the authorization work in [Capabilities](capabilities.md), which is the part that applies to every consumer, not only dashboards. The work is tracked under [M16](roadmap.md#m16--capabilities-and-delegated-authority) and [Later](roadmap.md#later--only-if-needed).

## First principles

A prompted control plane has five parts, and only the first belongs to the controller:

1. **Capabilities**: what can be read and done (the controller API).
2. **Authority**: who may do which of those, for how long, and who is blamed ([Capabilities](capabilities.md)).
3. **A host** for the generated UI, with user login, a public TLS address and persistence.
4. **A generation loop**: a model with tools that writes and revises the UI.
5. **A safety model** for two untrusted inputs: generated code, and content the model reads (container logs, event messages, versions, commit text) that can carry prompt injection.

Tug already has the right split. The controller is a small single writer and the trust root ([Roadmap principle 4](roadmap.md#principles)); a product layer (users, teams, git, domains, templates, UI) is a client of it. Coolify and Dokploy fuse the two into one application and one database. For Tug the product layer stays out of the controller, because it would add a browser-facing surface, an LLM dependency and product state to the one process that holds the CA and master key.

## What the controller offers today

- One mTLS port, no bearer token, no unauthenticated route and no CORS. A browser cannot call it without CA trust and an imported client certificate ([Control plane](control-plane.md#authentication-and-pki)), so a browser UI always needs a server-side component holding a credential.
- Three cumulative roles and project scope, fixed at creation, created only by `admin` ([Access control](access-control.md)). `deploy` includes live `exec`, `run` and `inspect`, so it is effectively access to the workload's secrets and nodes.
- The audit `actor` is the credential name, so a dashboard acting for a person records only the dashboard.
- No machine-readable description of `/api/v1`. The types are in `src/protocol.ts`; `x-tug.schema.json` covers Compose only. The CLI has `--json` on some commands, not a global flag.
- `GET /api/v1/events` takes `project`, `limit` (at most 500, newest first) and `after=<seq>` (oldest first, to follow the log), and `GET /api/v1/watch` is a WebSocket that pushes change hints and new events ([Architecture](architecture.md#operator-watch-channel)). `status` returns the 20 latest deployments and computes `stale` when called. Webhooks (M8) and `/metrics` (M9) are not built.
- Dry-run exists for `restore` (without `confirm` it returns the plan) and `image prune --dry-run`. A deploy has no plan; `tug lint` is offline.
- `deploy` needs a normalized Compose file, which the CLI produces with its own reader (`src/compose/load.ts`, no Docker needed), so a server-side deployer needs the CLI or that module.

## Controller changes

All are additive minors and keep [the frozen contracts](releases.md#what-10-freezes). Operations, grants, sessions, attribution, plans and approvals are designed in [Capabilities](capabilities.md). The remaining controller work specific to consumers:

1. **A machine-readable API.** Generate OpenAPI 3.1 from the operation table and the `protocol.ts` types, serve it at `GET /api/v1/openapi.json` and ship it in the npm package. Each operation carries its role, project check, effect class and idempotence. An MCP server and a typed SDK are built from it.
2. **A change feed.** Built: `GET /api/v1/events?after=<seq>` and a streaming `GET /api/v1/watch` (WebSocket) for deployment, node (including `stale`, found by a once-a-second sweep), backup and restore changes and new events. It sends hints and events, not state, so a console refetches what a hint names. Webhooks (M8) are the server-to-server form of the same thing and are not built.
3. **Idempotency keys** on mutating routes, so an agent that times out and retries does not double-apply.
4. **Bounded, cheap reads**: pagination and ETag on `status`, `deployments` and `events`.
5. **Agent-reported stats and `/metrics`** (M9). "Show CPU and memory" is the first dashboard anyone asks for and nothing measures it today.
6. **Optional server-side Compose normalization**, only if shipping the CLI inside the console image proves painful. It cuts against the current design (normalize on the operator machine, allowlist on control), so it is not first.

Not the controller's job: users, SSO, teams, dashboards and their versions, chat history, templates, domain and git integration. The console keeps its own SQLite and its own backups. The controller gets generic project `labels` only if a concrete need appears.

## Existing patterns considered

| Pattern | What it teaches | Limit for Tug |
| --- | --- | --- |
| Coolify, Dokploy, Laravel Cloud, Render | A product layer covers git, environment, domains, databases and teams. Coolify has scoped API tokens with abilities (as I recall: read, read:sensitive, write, deploy, root). | The UI is fixed and product state lives with the engine. Not a model to copy. |
| Kubernetes | The API is the product and UIs (Headlamp, Backstage) are clients. Discovery and OpenAPI, watch, server-side dry-run, impersonation headers, short-lived bound tokens, admission. | Each is a gap above in miniature. Copy the ideas, not the machinery. |
| MCP | Tool discovery with JSON Schema, annotations (read-only, destructive, idempotent), elicitation for human confirmation, OAuth for remote servers. MCP Apps and Claude artifacts return UI from tools. | Needs an annotated, typed API underneath, which is the OpenAPI item above. |
| Code mode (Cloudflare style) | An agent writing code against a typed SDK composes better than dozens of tool calls and keeps bulk data out of the context. | Run it inside the console sandbox against the session's own credential, never with a shared one. |
| Declarative dashboards (Grafana JSON, Home Assistant Lovelace, Retool) | Safe, diffable, versionable and easy for an LLM to author. | Cannot express a custom workflow. Use as the default, with code as the escape hatch. |
| Claude artifacts with data connectors | Prompt, get a sandboxed page bound to live data. This is the interaction users want. | Hosted elsewhere and per user. Tug needs the always-on, team-shared, self-hosted version. |

The comparison to Coolify and Kubernetes is from general knowledge, not rechecked against current releases.

## Options

- **A. MCP server only** (`tug mcp`, generated from the OpenAPI). The user's own agent builds ad hoc dashboards as artifacts and answers questions. Needs the operation table, grants and plans from [Capabilities](capabilities.md) and the generated API description. Cheapest, and the first proof that the API is agent-ready. No hosting, sharing or persistence.
- **B. Console as a Tug project** on a node on the controller host. Caddy gives it TLS and Tug gives it rollout, rollback, secrets, logs and backups. A node on the control host is supported today, and control's port 8443 does not clash with Caddy's 80 and 443. The console deploys like any app, and its credential must exclude its own project.
- **C. Console as a sidecar** in the control compose (`tug control setup --with-console`). Tight, but unmanaged by Tug, coupled to control upgrades and invisible to its own audit. B is better.
- **D. Console embedded in `control.ts`.** Rejected: browser-facing HTTP breaks the one-mTLS-port model and puts an LLM dependency in the trust root.
- **E. A separate product that runs anywhere** (a laptop or another host) with a credential file. Zero controller blast radius, good for a demo, no team hosting.

The recommendation is A first, then a demo console developed as E and deployed as B, in its own repository and package. Never D.

## Generic AI frontends and MCP

Most users will not use a Tug-specific UI. They will use whatever AI frontend they already have, so the controller's agent surface has to be one every frontend can use. The frontends fall into five kinds, and each needs a different way in:

| Frontend | Examples | How it reaches Tug |
| --- | --- | --- |
| Agent with a shell | Claude Code, Codex | The CLI, under a [session](capabilities.md#sessions-delegation-with-attenuation) credential in `TUG_CREDENTIAL`. No MCP needed; the controller enforces the limits. |
| Desktop and IDE chat | Claude Desktop, Cursor, VS Code | `tug mcp`, a local stdio MCP server the client spawns. |
| Hosted chat products | claude.ai, ChatGPT | A remote MCP server over HTTPS with OAuth. This cannot be the controller, which is certificate-only, so it is a console component (option B). |
| Self-hosted chat UIs | Open WebUI, LibreChat | MCP, or the generated OpenAPI description directly (some consume OpenAPI tool servers). |
| The console's own UI | The [demo console](#demo-console) | An in-process client with its own agent runner. |

### What `tug mcp` exposes

- **A curated tool set, not one tool per route.** A model chooses poorly from 55 near-identical tools, so tools are task-shaped (`get_status`, `list_events`, `plan_deploy`, `rollback`, `restart`, `run_command`, `list_backups`), generated from the operation table and its effect classes, not written by hand. An escape hatch for the long tail is a code-mode tool that runs a script against the typed SDK inside a sandbox.
- **Annotations come from the effect class.** `read` maps to the read-only hint, `destructive` and `escalates` to the destructive hint, and the operation's idempotence to the idempotent hint, so clients that ask for confirmation do it where it matters.
- **The tool list follows the grants.** `whoami` decides what is advertised. A session that cannot run `exec` never sees an exec tool, so the model does not waste turns on it and a prompt cannot talk it into trying.
- **Gated operations return a proposal.** A tool for a gated grant returns "pending approval" with the plan and the risk tags. Clients that support elicitation can ask the user in place; otherwise the user approves in the console or with `tug proposals approve`. The agent then repeats the call with the approval. See [Approvals](capabilities.md#approvals-and-the-plan-apply-split).
- **Resources and prompts.** `status` and `events` are resources, with subscriptions backed by the [change feed](#controller-changes). Prompts carry runbooks such as "diagnose a failing deployment".
- **Logs and event text are untrusted.** Tool results wrap them in a marked block, which helps little against a determined injection. The real defense is server-side: the grants the session holds and the gates on anything that mutates. The frontend's model is outside Tug's control.

### Authentication

- **Local (stdio).** `tug mcp` never holds root. It mints a session at startup from the credential in the user's profile with explicit grants (`tug mcp --grant ... --ttl 8h`, defaulting to the read preset), so a stolen process or config exposes a short-lived narrow credential.
- **Remote (HTTP).** A console component acts as the OAuth authorization server for the MCP client, with login through the console's own user store or OIDC. The consent screen lists the requested grants as the dashboard manifest does. Each client connection maps to one session, and the token is not a Tug credential; control still sees only certificates.

### Dashboards built in a generic frontend

A user can say "build me a dashboard of my sites' health" in any of these frontends, and there are two ways it ends up working:

- **Ephemeral, in the frontend.** The frontend's own artifact or app mechanism renders a page that calls the MCP tools through the client under the user's session. Tug supplies only bounded JSON and the change feed for live updates. Nothing is hosted, shared or persisted; closing the chat loses it.
- **Published, in the console.** A `publish_dashboard` tool, on the console's MCP server, saves the manifest and source as a versioned dashboard. The console hosts it in the sandbox, installs it as a session with exactly the manifest's grants, and a team can open it later without the chat.

The second mode changes the demo console: the generation loop (part 4 of the [first principles](#first-principles)) can be the user's own frontend, so the console does not have to run its own agent, hold an LLM key or pay for tokens. It is host, authority and persistence only. A built-in runner is an optional extra for users with no frontend of their own.

### Use cases

| Prompt | What happens |
| --- | --- |
| "Why is the blog failing?" | The agent reads status, events and logs with a read session and explains. Nothing mutates. |
| "Roll back the blog." | `rollback` is gated for this session. The agent returns the proposal, the user approves it in the console or the CLI, and the agent applies it, attributed to the user and the agent run. |
| "Deploy this compose file to staging." | `plan_deploy` returns the diff and risk tags. A host bind or a new public port is shown to the human; denied risks are refused outright. |
| "Build me a health dashboard for all sites." | Ephemeral artifact with live tool calls, or published to the console with a read-only manifest. |
| "Send me a report every Monday." | The console schedules an agent run with a read-only session that expires after the run. |

## Demo console

The principles a demo console would demonstrate:

1. The controller stays the only writer. The console is an ordinary client, never admin.
2. Least authority by construction. A dashboard install is a [session](capabilities.md#sessions-delegation-with-attenuation) holding exactly the grants in its manifest, so the controller enforces them and the console's proxy stays thin. Generated UI never sees a credential.
3. Every agent mutation is plan, approve, apply, bound by `planId`. The human sees the diff and the risk tags.
4. Every action is attributed to the user, the console and the agent run.
5. Dashboards are versioned artifacts (manifest plus source): edit, preview, publish and roll back like a deployment.
6. Untrusted data stays data. Logs and event text are rendered, never fed to an agent that can mutate; the agent that reads logs is read-only.
7. Anything the console does can be done and audited from the CLI.

Components: a gateway (Caddy, passkey or OIDC login) in front of a console server (Node, SQLite for users, dashboards, versions, chats and approvals). The console server holds a controller client over mTLS, mints a session per dashboard install, runs a capability proxy for generated dashboards (null-origin sandboxed iframe, CSP `default-src 'none'; connect-src 'self'`, no network except the proxy) and, optionally, an agent runner with the tools `query_api`, `propose_action`, `write_dashboard` and `preview` plus a typed SDK generated from the OpenAPI. It also serves the remote MCP endpoint and OAuth described under [Generic AI frontends](#generic-ai-frontends-and-mcp), so a user's own frontend can be the generation loop instead of the built-in runner.

A dashboard manifest is approved by a human at install, like OAuth scopes, and maps directly onto grants:

```yaml
name: sites-health
capabilities:
  - read: status            # filtered to projects site, blog
  - read: events            # project: site
  - action: rollback        # project: site, needs approval each time
refresh: watch
```

| Threat | Answer |
| --- | --- |
| Prompt injection through logs makes the agent propose a bad deploy | The reader agent is read-only; mutation happens only as a plan; a human approves with the risk tags visible; the sandbox has no egress. |
| Generated JavaScript exfiltrates data | Null origin, CSP, only the proxy reachable, the manifest limits what can be read, and the proxy caps rate and size. |
| The console's credential is stolen | It is not admin, has no `exec`, is project-scoped, short-lived and revocable in one call. |
| The console is compromised | The blast radius is its credential's grants. Deploying to other projects is still node-level, which is why mutation needs approval. |
| The agent edits its own guard rails | The console's project is excluded from its own credential, and manifests and policy are read-only to the agent. |

## Open questions

- Is a mutation credential ever acceptable without per-action approval? Probably yes for `rollback` and `restart` of one project, no for `deploy`.
- Does the console deploy through the CLI subprocess (frozen, tested, needs the Compose binary) or its own client against the API (needs a normalizer)? Start with the CLI.
- Where does the LLM key live and who pays? With the user's own frontend as the generation loop there is none; the optional built-in runner needs a console-level secret in the console's own project, never on the controller.
- Does the remote MCP and OAuth endpoint belong in the first console, or in its own gateway so it can ship before the dashboard host?
- Several controllers per console (a fleet) is out of scope until one works.
