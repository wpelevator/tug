# Capabilities

**Status: proposed.** Nothing on this page is built. Today a credential has one of three cumulative roles and an optional project list ([Access control](access-control.md)); every name, flag, route and field below is a design, not an interface. The work is [M16](roadmap.md#m16--capabilities-and-delegated-authority).

The problem is that the `root` credential `tug control setup` imports is an admin, so every consumer of the controller gets either everything or one of two coarser presets: CI, a teammate, a monitor, a script, a dashboard or an AI agent driving the CLI. This page designs a small capability engine so each consumer holds exactly the authority its job needs, and so the CLI stops being root by default.

AI agents can already use the CLI. The engine therefore lives in the controller, where a client cannot bypass it: `TUG_CREDENTIAL=<narrow session> claude ...` is safe because control enforces the limits, not the client. The CLI is an unprivileged client of the engine like any other.

## Threat model

In scope, because they are the real failures of the current model:

1. **Injected or confused automation.** An agent or script does something its author did not intend, driven by untrusted text it read (container logs, event messages, versions, commit text).
2. **Leaked narrow credentials.** A CI or dashboard credential is stolen; the loss should be bounded to what that consumer needed.
3. **Accidental overreach by humans.** Root is the daily driver, so a typo is a root typo.
4. **Unattributable delegation.** A tool acting for a person records only the tool.

Out of scope, consistent with the [product decisions](roadmap.md#product-decisions-and-reasoning): isolating mutually untrusted tenants. Shared kernels, builds on control and the host-level reach of deployers are unchanged, and [Security](security.md) still applies. The engine reduces blast radius and makes authority explicit and reviewable; it is not a sandbox against a hostile deployer. Where a grant is secretly root-equivalent, the engine says so ([Root-equivalence analysis](#root-equivalence-analysis)).

## Where authorization sits today

- A client certificate resolves to an `Actor { name, role, projects }`. The credential row holds the role and project list; the certificate carries only an ID and authorization follows the key hash.
- `ROUTE_ROLES` in `src/credentials.ts` maps each `METHOD path` to a role, `createGuard` checks the role and then a project resolver, and handlers call `assertProject` and `projectScope` for what is known only after parsing. A test ties the table, the router and [the endpoint table](access-control.md#endpoint-table) together.
- Revocation, expiry and key replacement are database state read on every request. The design keeps that property.

The design below evolves this shape; it does not replace it.

## Design

### Operations and resources

Replace "route → role" with "route → operation". An **operation** is a stable name for what a request does, decoupled from the HTTP path so a route can change without breaking grants. A **resource** is the tuple of dimensions the request touches, taken from the places the project check already reads (path, query, body, stored record):

```text
resource = { project?, service?, node?, secret?, volume?, deployment? }
```

The table that is `ROUTE_ROLES` becomes a `ROUTES` table:

```ts
'POST /api/v1/rollback': { op: 'deployment.rollback', on: ['project'], preset: 'deploy', effect: 'mutate' }
'POST /api/v1/restart':  { op: 'service.restart',     on: ['project', 'service'], preset: 'deploy', effect: 'mutate' }
'POST /api/v1/secrets':  { op: 'secret.set',          on: ['secret'], preset: 'admin', effect: 'mutate' }
```

`preset` is the role that includes the operation, so the three roles keep their meaning and are still defined by the table. `effect` is one of `read`, `mutate`, `destructive`, `reads-workload` (logs, inspect), `exposes-secrets` (exec, run, the repository password) and `escalates` (credential and node enrollment). The live channel is authorized per request frame, so `exec`, `run`, `logs.follow`, `ps` and `inspect` become separate operations instead of one `deploy` route.

| Group | Operations (draft vocabulary, derived from the routes) |
| --- | --- |
| read | `status.read`, `project.read`, `deployment.read`, `service.read`, `event.read`, `volume.read`, `secret.list`, `backup.read`, `restore.read`, `version.read` |
| operate | `project.create`, `deployment.create`, `deployment.cancel`, `deployment.rollback`, `service.scale`, `service.restart`, `service.logs`, `command.read`, `backup.run` |
| workload | `service.logs.follow`, `service.ps`, `service.inspect`, `service.exec`, `service.run` |
| admin | `secret.set`, `secret.delete`, `volume.delete`, `restore.run`, `restore.resume`, `restore.release`, `hold.release`, `image.prune`, `diagnostics.run`, `control.backup`, `control.restore`, `backup.destination.*`, `backup.repository-password.read`, `node.*`, `credential.*` |

The presets stay as they are: `read` is the read group, `deploy` is read, operate and workload (so nothing widens or narrows), `admin` is everything. A new operation joins the preset its table row names, as a new route does today.

### Grants

A credential carries a list of grants. Evaluation is default deny and additive within one credential:

```json
{ "ops": ["deployment.rollback", "service.restart"], "on": { "project": ["site"] } }
{ "ops": ["deployment.create"], "on": { "project": ["site"] },
  "where": { "denyRisks": ["host-bind", "privileged", "cap-add", "docker-sock", "build"], "images": ["ghcr.io/acme/*"] },
  "gate": "approval" }
```

- `ops`: exact names or `group.*`.
- `on`: per dimension, exact names or a trailing-`*` prefix. An absent dimension means any value. A request whose dimension cannot be resolved is denied when a grant constrains that dimension, the rule that stops scoped credentials probing for IDs today. The `secret` dimension is project-qualified (`project/NAME`).
- `where`: typed caveats from a closed set, not a policy language: `denyRisks` and `images` (deployments), `expires` and `notBefore`. There is no rate limit; expiry and gates bound a misbehaving consumer.
- `gate`: `approval` turns the operation into a proposal ([Approvals](#approvals-and-the-plan-apply-split)).

A role-only credential has an implicit grant list equal to its preset, and today's `--project` scope becomes `on: { project: [...] }`, so existing credentials behave as before. The compact CLI form maps one to one: `--grant 'service.restart project=site service=web'` and `--grant 'deployment.create project=site deny=host-bind,privileged,build gate=approval'`.

**Explicit grant lists never widen across upgrades; presets may.** Build an agent credential from explicit grants and a human admin from a preset.

### One decision function

```ts
decide(chain: Grant[][], request: { op: string; on: Resource; context?: { risks?: string[]; images?: string[] } })
  → { allow: true; gates: string[]; via: number[] } | { allow: false; reason: string }
```

It does no I/O, so it is exhaustively testable and replaceable by another engine later. Input and output are shaped like principal, action, resource and context, so a swap to Cedar would be mechanical. Enforcement stays at the three places that exist now:

1. **The route guard**, with the operation and every dimension resolvable from the request (the project resolver, generalized to return a resource).
2. **Handlers**, for what only the content shows. `deployment.create` calls `decide` again with the computed `risks` and `images` once the Compose file is parsed.
3. **The live channel**, per request frame.

Listings filter to what the actor may see (`projectScope` generalizes to a visibility filter per dimension).

### Sessions: delegation with attenuation

A credential holding `credential.delegate` can mint a **session**: a child credential with its own key, a short expiry and a grant list, recorded with a parent. The CLI uses this to stop being root: `tug session --grant ... --ttl 1h` prints a `TUG_CREDENTIAL` for an agent, a CI job or a dashboard.

- **Effective authority is the intersection along the lineage, evaluated on every request.** A request is allowed only if every credential from the session up to its root allows it. No subset algebra over patterns is needed at mint time, and narrowing a parent narrows every descendant immediately. A child granted more than its parent is simply ineffective, and minting warns about it.
- Gates and denied risks are the union along the chain; expiry is the earliest.
- Revoking a credential revokes its descendants. A session cannot outlive its parent. Depth is limited to three.
- `credential.delegate` and anything with effect `escalates` are never inherited implicitly: a grant list must name them, and a parent can cap depth.
- Attribution: events and deployments keep `actor` (the credential name), add a `lineage` (`root > console > alice > run-42`) and an optional `on_behalf_of` and `via` that a proxy credential may set. Attribution is cheap and ships first; intersection enforcement is what makes it safe to hand a session to something untrusted.

Control generates the key and returns the credential once, as `credential create` does today. There is no new bearer-token surface and the port stays certificate-only.

### Approvals and the plan/apply split

For an operation a grant marks `gate: approval` (or any grant along the chain does):

1. The caller sends the request as a plan and gets effect-free review material. For a deploy that is the diff against the current desired state, the risk tags, the images, data moves and ingress changes, and a `planId` hashing exactly that content.
2. A **proposal** is stored, with the lifecycle `pending → approved → executed` and `rejected`, `expired` and `cancelled` as other exits. It is another lifecycle declared in `src/lifecycles.ts`, so the transition guard and its tests apply.
3. An approver holding `proposal.approve` on that resource approves it. The approver must not be in the requester's lineage, so an agent cannot approve itself.
4. The requester repeats the call with `approval: <proposalId>`. Control recomputes the hash from the request content and refuses a mismatch, an expired proposal or a changed base state; a proposal is single use. The approved call runs the same code path as an ungated call with `approved_by` added to the audit record, so there is one implementation.

An approval binds to the plan, not to an upload, so a large build context is not stored. Small operations bind to a hash of the operation and its arguments. Gating applies to operations whose request is complete and hashable: `service.run` (the command line is bound), `service.restart`, `deployment.*` and `secret.*`. It does not apply to interactive `service.exec`, `logs.follow` or `inspect`: a live PTY cannot be approved before it starts without a one-off session mechanism, so those are granted or not, and agent presets omit them.

A plan is required only when a grant is gated. `denyRisks` and `images` need no plan: control computes the risks on apply and refuses, naming the offending tags. The plan route is open to anyone holding the operation, as a dry run.

### Introspection and explainable denials

- `GET /api/v1/whoami` returns name, preset, grants, lineage and expiry, so a consumer can discover what it may do and hide the rest.
- `POST /api/v1/authz/check { op, on }` returns `{ allow, via, requires: ['approval'] }`, the equivalent of Kubernetes' SelfSubjectAccessReview.
- A denial says what was missing for the requested thing (`deployment.create on project=blog`) and never whether it exists, keeping [the no-probing rule](access-control.md#failures).
- Allowed mutations record the matched grant and lineage in event metadata. Denials are recorded as `authz.deny`, aggregated per credential and operation so a looping agent cannot flood the table.
- The CLI gains `tug whoami`, `tug can <op> [k=v...]` and `tug credential explain <name>`.

### Root-equivalence analysis

`credential create` and `session` run the grants through a fixed analysis and print warnings, because several narrow-looking grants are not:

| Grant | Why it is root-equivalent on the nodes |
| --- | --- |
| `deployment.create` without `host-bind` denied | A host bind mount reads or writes any file on the node |
| without `docker-sock`, `privileged` and `cap-add` denied | Container escape or Docker control |
| without `build` denied | `build:` runs a Dockerfile on the control host |
| `service.exec` or `service.run` | Reads every secret the workload has |
| `secret.set` with `deployment.create` | Chooses what code receives which secret |
| `backup.destination.*` | Redirects every backup to a destination the caller picks |
| `node.*`, `credential.*`, `control.restore` | Control of the platform itself |

The same risk vocabulary drives the plan output and the `denyRisks` caveat. It is computed by the code that already validates the Compose allowlist, so there is one definition.

## Consumers as grant sets

| Consumer | Grants |
| --- | --- |
| Human daily driver | `tug login` session from root with read, operate and workload but no admin; `tug sudo` mints a short admin session |
| CI for one site | `deployment.create` (build allowed, `images` pinned), `deployment.read`, `deployment.rollback`, project `site` |
| Prometheus | `status.read`, `event.read`, `metrics.read` |
| Backup cron | `backup.run`, `backup.read` |
| Support person | `service.logs`, `service.restart`, `deployment.read`; no workload, no exec |
| Incident bot | read plus `service.restart` with `gate: approval` |
| AI agent using the CLI | read plus `deployment.create` and `deployment.rollback` gated, all risks denied, one-hour session |
| Generated dashboard ([Consoles](consoles.md)) | The grants in its manifest, as a session per install |
| Child agent spawned by an agent | A session of the session; intersection guarantees it cannot exceed the parent |

## Existing systems considered

| System | What it gives | Decision |
| --- | --- | --- |
| Cedar, OPA/Rego, Casbin | Expressive policy languages | Not adopted. The vocabulary is about 50 operations and 6 dimensions with typed caveats; a language adds a dependency (Tug leans on built-ins and a standalone binary), analysis burden and the chance to write an unsafe policy. The data stays Cedar-shaped for a later swap. |
| OpenFGA, SpiceDB (Zanzibar) | Relationship-based access | Needs a service and a relation model Tug does not have |
| Macaroons, Biscuit | Offline attenuation by the holder | Introduce bearer tokens, against the model. Control is local and minting is a cheap call, so offline attenuation buys little. |
| Kubernetes RBAC | Verbs × resources × names, access review | Closest in shape. Copy the review endpoint and additive rules; skip roles and bindings. |
| AWS STS session policies | Effective authority is the intersection with the parent | Copied: it removes the need for a subset check |
| Vault tokens | Parent-child lifetime, cascade revoke | Copied: lineage and cascade |
| GitHub App tokens, fine-grained PATs | Mint-time narrowing by repository and permission | Copied: the mint API shape |
| Deno permissions, Android and OAuth scopes | A consumer declares what it needs up front | The dashboard manifest in [Consoles](consoles.md) |

The decision is a small closed-vocabulary engine with a pure decision function and a Cedar-shaped data model.

## Storage and compatibility

- One migration step, appended in `src/db.ts` with a previous-release fixture: `operator_credentials` gains `grants_json`, `parent_id`, `on_behalf_of` and `via`, and a `proposals` table arrives with approvals. Existing rows have NULL grants, meaning "the preset", so nothing changes for them.
- `role` stays. A grants-only credential stores `custom`, and an older control that reads it fails closed (the role rank lookup is undefined, so every check denies).
- The credential file (`v: 1`) is unchanged; grants live on control. `POST /api/v1/credentials` gains optional `grants`, `ttlSeconds` and `parent`, so the change is additive. Operations, grants and sessions are minors under [the 1.0 contracts](releases.md#what-10-freezes); the `root` default is a separate decision ([below](#decisions)).
- The endpoint table in [Access control](access-control.md#endpoint-table) gains an operation and an effect column, and the test that compares the table with the router and the page keeps it honest.

## Tests

- **Golden compatibility.** For every route and each role, the new decision equals the old guard result, derived from the old table before it is deleted. The presets reproduce today's behavior exactly.
- **Table completeness.** Every registered route has an operation, an effect class and a resource extractor, and every operation appears in the docs.
- **Properties** over generated cases: default deny; a child is never more permissive than its parent; narrowing a parent narrows the child; an unresolved dimension denies when constrained; a gate anywhere in the chain gates.
- **Lifecycle.** The proposal transitions are declared and reachable, reusing the existing lifecycle tests.
- **Live channel.** `exec` is denied to a credential holding only `service.logs.follow`.
- **Replay and drift.** Approve, execute and replay is refused; a plan whose base state changed is refused.
- **No probing.** The denial for a nonexistent project and for an existing but forbidden one is byte-identical.

## Decisions

- **No rate limits.** Expiry and gates bound a misbehaving consumer; there are no per-credential counters.
- **Gating** applies only to hashable operations, as described under [Approvals](#approvals-and-the-plan-apply-split).
- **Demoting `root` is opt-in first.** `tug control setup` keeps importing root unchanged: the quick start is frozen and root is the recovery path. `tug login` (a session with read, operate and workload but no admin) and `tug sudo` (a short admin session) are added, and interactive shells use `login` by default once it exists. A session needs its parent to renew, so while root sits on the same laptop this prevents accidents (threat 3), not theft. Changing setup is revisited only after real use, and only if root moves off the daily machine.
- **Per-secret grants are included** with the grants step: `secret.list` stays read-level, and `secret.set` and `secret.delete` become grantable per project-qualified name pattern. The root-equivalence analysis flags `secret.set` with `deployment.create`.

## Sequencing

Each step ships as a minor and starts with its tests.

1. **Operation table.** `ROUTE_ROLES` becomes `ROUTES` with operation, preset, effect and resource, and the live operations split. No behavior change; the golden test proves it.
2. **Grants.** The migration, `decide`, the guard using it for credentials with grants, `credential create --grant`, `whoami`, `authz/check`, explained denials, `authz.deny` events, the root-equivalence warnings and per-secret grants.
3. **Sessions and lineage.** `credential.delegate`, intersection, cascade revoke, expiry clamping, `on_behalf_of` and `via` in the audit trail, `tug session`, `tug login` and `tug sudo`.
4. **Plan and risks.** The `deployment.create` plan route, risk tags, the `denyRisks` and `images` caveats and `planId`.
5. **Approvals.** The proposals lifecycle, `proposal.approve`, separation of duty and gated grants.
6. **Consumers.** OpenAPI generated from `ROUTES`, `tug mcp` and the [console](consoles.md).

Steps 1 and 2 already deliver a credential that is not root and an explanation when a call fails. Steps 3 to 5 are what make it safe to hand authority to an agent.
