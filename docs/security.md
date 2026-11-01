# Security audit

Audit date: 1 November 2026. Base commit: `a80b94236402e06138e61867c527cbf07540f60f`, plus the uncommitted working tree, including the mTLS implementation. Findings describe the code observed during this review, rather than the last release or a deployed installation. This is a source review with isolated local reproductions, not a live infrastructure penetration test. Runtime behavior was not changed to address the findings.

## Assessment

The current tool should be operated as a single trust domain: every deployment author must be trusted with the nodes they can select, their co-located workloads and their secrets. Project scopes restrict API records but do not provide workload or host isolation. The mTLS implementation improves connection authentication, but authenticated node reports still cross several authorization and configuration boundaries without sufficient validation.

There are ten findings: one critical, seven high and two medium. Severity assumes a stolen or maliciously used credential, a compromised node, an untrusted application source tree, or an ordinary unprivileged account on the control host, as specified for each finding. None of the reproduced application findings establishes an unauthenticated remote takeover.

| ID | Severity | Finding | Prerequisite | Evidence |
| --- | --- | --- | --- | --- |
| SEC-01 | Critical | Project-scoped deployment can obtain node root access | A `deploy` credential | Reproduced API acceptance and rendered Engine body |
| SEC-02 | High | Node status can inject shared ingress configuration | A node identity with a placed ingress service | Reproduced status-to-Caddyfile flow |
| SEC-03 | High | Backup reports bypass ownership and command lifecycle checks | A node identity and a foreign or historical command ID | Reproduced catalog forgery and credential release |
| SEC-04 | High | Disabling a node leaves its mesh access and ingress traffic active | A compromised node being disabled | Reproduced peer and upstream retention |
| SEC-05 | High | Control backups expose secret and CA keys through permissive file modes | Local read access to the backup directory | Reproduced `0644` archive and key contents |
| SEC-06 | High | Source uploads can include the root credential and ignored secrets | Remote build from an affected source directory | Reproduced archive contents |
| SEC-07 | High | A project can take another project's ingress hostname | A project-scoped `deploy` credential | Reproduced route resolution |
| SEC-08 | High | Locked dependencies include published security vulnerabilities | Deployment upload access; YAML issues also require local input | Reproduced Multer descriptor leak; checked maintainer advisories |
| SEC-09 | Medium | An unbounded build can monopolize control's global deployment writer | A `deploy` credential | Source-confirmed; destructive exhaustion not attempted |
| SEC-10 | Medium | The documented prohibition on deploy-role secret reads is false | A `deploy` credential for the affected project | Reproduced plaintext inspect forwarding |

## Findings and required regression coverage

### SEC-01: Project scopes do not confine deployment privileges

**Evidence:** `src/tokens.ts:35` grants deployment creation to `deploy`; `src/control.ts:2086` onward uses the shared node inventory without a per-actor node allowlist. `src/compose.ts:297` accepts any absolute bind source. `src/container-spec.ts:247` copies it into Engine `HostConfig.Binds`. External volumes, local-volume `driver_opts` and `cap_add` provide additional privileged surfaces.

**Reproduction:** An operator credential limited to project `alpha` successfully submitted a deployment placed on `n2` with `volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }]`. The resulting container plan retained `/var/run/docker.sock:/var/run/docker.sock` unchanged. No real host socket was mounted during the audit.

**Impact:** The deployed process can command the host Docker daemon, create privileged containers and read or alter host files and other projects. Mounting `/` or a host-backed local volume provides other paths. If the node shares the control host, the control data directory is also exposed. API project checks and the absence of a `privileged` Compose key do not prevent this escalation.

**Remediation:** Decide whether deployment authors are host administrators. For the current unrestricted model, state this explicitly and grant `deploy` only to equally trusted operators. To make project scopes a security boundary, enforce an administrator-owned policy for node placement, bind sources, external volumes, volume drivers/options and added capabilities before publishing desired state. Use separate hosts or control planes for mutually untrusted authors. A denylist of only the Docker socket is insufficient.

**Regression coverage:** A scoped deployment must be refused when it requests an unauthorized node, host bind, foreign external volume, host-backed driver option or prohibited capability. Preserve explicitly authorized administrator use cases.

### SEC-02: Node-reported ports become Caddyfile syntax

**Status: fixed.** `src/status-report.ts` validates and normalizes every status report before storage (ports must be integers in `1..65535`), control stores only services placed on the reporting node, and `resolveServiceEndpoints` drops any non-port value. Node address validation at registration remains open. The text below describes the original finding.

**Evidence:** `src/control.ts:3062` stores request project reports without runtime schema validation. `src/ingress.ts:71` accepts `serviceState.port` as supplied, and `src/ingress.ts:152` and `src/ingress.ts:193` interpolate it into shared Caddyfile text. The enrollment/identity address fields also lack strict IP/hostname validation before being used as upstream addresses.

**Reproduction:** A node reported its placed service as serving with `port: "8080 {\n\t\theader_down X-Audit injected\n\t\t#"`. An ingress node's subsequent work response contained the injected `header_down` directive. The final `#` consumes the renderer's appended opening brace, leaving the intended block structure available to the attacker. Only configuration generation was exercised; a real Caddy process was not started.

**Impact:** A compromised application node can affect the shared ingress agent beyond its own workload. Crafted configuration can disrupt all routes or introduce additional listeners, proxy handlers or file serving under the ingress container's permissions. The ingress container uses host networking and holds TLS material. Actual execution of those broader payloads remains an inference from the configuration injection, not an observed live exploit.

**Remediation:** Validate the full status schema before any database write. Require reported ports to be integer values within `1..65535`, associated with a service currently placed on that node and an allowed active rollout. Validate node addresses at registration and enrollment and use structured upstream addresses. Prefer Caddy JSON configuration, retaining strict typed validation even with JSON.

**Regression coverage:** Reject string, object, newline-bearing and out-of-range ports and malformed addresses; reject unplaced projects/services; demonstrate that valid numeric rolling ports still reach ingress.

### SEC-03: Backup reports bypass ownership and command lifecycle checks

**Status: fixed.** The status handler resolves each command and heartbeat under the authenticated node and only while the command is `running`, before any scheduler call, and results can only be `succeeded` or `failed`, so terminal commands cannot be reopened. The text below describes the original finding.

**Evidence:** `src/control.ts:3075` passes job heartbeats to the scheduler without the calling node. `src/control.ts:3079` calls `backups.onResult` before the SQL update that checks `node_id`. `src/backup-scheduler.ts:577` and `src/backup-scheduler.ts:589` locate runs solely by command ID. The guarded command update accepts arbitrary reported states, including a transition from a terminal state back to `running`; the backup credential endpoint subsequently trusts that stored state without checking current placement.

**Reproduction:** A running `backup.run` command and catalog row belonged to `n2` and project `beta`. Node `n1` posted a successful result for that command with a fabricated snapshot ID. The response was `200`; the foreign backup run became `succeeded`, while the correctly guarded command row remained `running`.

In a second reproduction, an already-completed backup command belonged to `n1` and a project with no current placement on that node. Credential retrieval initially returned `409`. The node reported that historical command as `running`, then successfully fetched the currently configured dummy destination secret and the project's repository password. A former node can retain its own historical command IDs without discovering a foreign ID.

**Impact:** A compromised node can forge another node's backup success/failure, poison snapshot selection and monitoring, or keep a foreign job alive through forged heartbeats. The cross-node variant requires a foreign command ID; IDs are random and are not shown to be enumerable through node-only APIs. The historical-command variant can disclose newly rotated backup-destination credentials after project placement has been removed. Restore planning trusts successful catalog entries, although the backup helper also checks snapshot project/target tags before restoring.

**Remediation:** Resolve each command under the authenticated node before invoking any scheduler or restore-related side effect. Pass the node ID into scheduler methods and enforce ownership, command type, allowed transition and expected result schema there too. Nodes must not reopen terminal commands or mark commands as running through result reports. Verify current command authorization when releasing credentials. Ignore or reject foreign IDs consistently.

**Regression coverage:** A foreign command result or heartbeat must leave commands, backup runs, schedules, timeout bookkeeping and audit events unchanged. A terminal command must remain terminal, and a historical command must not release newly configured credentials. Test valid same-node results and repeated terminal results as well.

### SEC-04: Node disable revokes API identity but not network membership

**Status: fixed for the mesh, endpoints, ingress and label-based scheduling.** Disabled nodes are excluded from peer lists, service endpoints, ingress topology and label/global placement, and `node-disable` wakes healthy peers. Explicit `placement.nodes` entries are deliberately left unchanged, and expired identities are not yet withdrawn from the mesh. The text below describes the original finding.

**Evidence:** `src/control.ts:1560` sets `disabled_at` and reconciles TLS sockets. `src/control.ts:2924` still returns every stored WireGuard peer; `src/control.ts:2904` constructs endpoint views without excluding disabled nodes. Deployment and scale inventory queries likewise omit the disabled flag.

**Reproduction:** After disabling `n1`, its HTTP request was correctly denied. Node `n2` still received `n1` in `network.peers`, and the ingress node still received `n1` as an upstream while its last report was fresh. The actual WireGuard data path was not exercised.

**Impact:** A quarantined host retaining its WireGuard private key remains authorized by healthy peers, and user traffic can continue reaching it. Staleness eventually withdraws ingress endpoints, but does not remove the WireGuard peer. Explicit placement and scaling can also continue considering disabled nodes.

**Remediation:** Define disable as a consistent control, scheduling and network state. Exclude disabled nodes from peer lists, endpoint resolution, ingress and new placement; wake healthy peers immediately after a disable. Exclude expired node identities too if expiry is intended to revoke mesh access. Document that network removal cannot undo secrets already disclosed or stop a compromised host's local workloads.

**Regression coverage:** Disabling a node must immediately remove it from healthy peers' desired network configurations and ingress endpoints and prevent new scheduling. Replacing an identity should restore only the intended memberships.

### SEC-05: Control backup archives are readable beyond the control user

**Evidence:** `src/control.ts:2584` copies the master key, and `src/control.ts:2585` copies PKI material into the backup. `src/control.ts:2595` writes the gzip archive without a restrictive creation mode. The control installer creates `/var/lib/tug-control` without a private directory mode.

**Reproduction:** With the audit process's ordinary `0022` umask, the backup API produced a `0644` `.tar.gz` in a `0755` backup directory. Archive entries included `master.key` and `pki/ca.key`. The temporary audit root itself was private, so no other user actually read the test keys.

**Impact:** On the installer-created directory hierarchy, another local account with directory traversal access can copy the entire backup. Encryption at rest no longer protects project, registry and backup-destination secrets because the decryption key is packaged beside the database. CA disclosure also enables forged control-server certificates when an attacker can redirect client connections. The backup does not contain operator private keys, and CA possession alone does not bypass the live server's stored principal key-hash checks.

**Remediation:** Create control and backup directories as `0700`, staging directories as `0700` and archives as `0600` from their first write; harden already-created paths too. Encrypt exported backups with a separately held recovery key if they leave the protected host. Treat every existing archive as sensitive key material.

**Regression coverage:** Assert initial directory/archive modes under a permissive umask, including the error path, and verify that cleanup removes staging material after failed backup creation.

### SEC-06: Root credentials and ignored secrets enter source archives

**Status: fixed for source uploads.** Uploads follow `.dockerignore` glob, recursive and negation semantics and always exclude `*.credential.json`; `.gitignore` covers the default output. The default `--credential-out` location is unchanged. The text below describes the original finding.

**Evidence:** `src/cli.ts:457` defaults control installation output to `tug-root.credential.json` in the working directory. It is not covered by the repository's credential ignore rules or `src/cli-build.ts:19`. `src/cli.ts:1198` excludes only the tracked config and local overlay, omitting the resolved credential file. `src/cli-build.ts:56` reads `.dockerignore` rules, but `sourceArchiveFilter` compares literal paths instead of Docker pattern semantics.

**Reproduction:** A source directory with `.dockerignore` entries `*.pem`, `.env*` and `private/**` still uploaded `key.pem`, `.env.production` and `private/config.json`. A dummy `tug-root.credential.json` was also present in the resulting archive. Only dummy values were used.

**Impact:** An ordinary subsequent remote build can upload the full administrator credential to control. A `COPY .` Dockerfile can include it in an application image when it is not correctly excluded at build time, giving a compromised application control-wide credentials. Matching Docker ignore rules still protect the actual Docker build context, but they do not currently protect the earlier Tug source upload. The installation output is also easy to commit accidentally.

**Remediation:** Default credential output outside source trees, automatically protect explicitly selected output paths, exclude the resolved credential path and recognized credential documents as mandatory rules, and implement compatible `.dockerignore` semantics for source uploads. Keep mandatory credential exclusions effective even when a pattern attempts to re-include them. Explain how to dispose of the original imported credential file.

**Regression coverage:** Exercise the installation-output-to-deploy workflow with a dummy credential, in-tree credential overrides, glob and recursive patterns, nested ignore paths and negation. Assert credentials are absent from uploaded archives and any resulting image context.

### SEC-07: Ingress host ownership is not authorized across projects

**Evidence:** `src/compose.ts:145` validates hostname duplication only within the submitted Compose definition. `src/ingress.ts:139` sorts all project/service routes; `src/ingress.ts:144` gives a duplicate host to the first route and only warns about the skipped project.

**Reproduction:** Desired states for `victim` and the lexically earlier project `alpha` both claimed `alpha.example.com`. Route generation selected `alpha` and warned that `victim` was skipped. Input order did not preserve the earlier owner's route. This reproduction exercised route selection, not public traffic.

**Impact:** A deployment credential limited to a lexically earlier project can take a hostname already serving another project on shared ingress. The attacker does not need that project's API scope or a host mount. Automatic TLS issuance validates domain control for the shared ingress address, not authorization between projects on that same ingress.

**Remediation:** Reserve hostnames across current deployments at publication time and reject conflicting owners, including case normalization and applicable wildcard overlaps. Use an administrator-managed hostname allowlist per project if scoped deployment authors should not claim arbitrary domains. Rollbacks must obey the same ownership rules.

**Regression coverage:** A scoped project cannot take an existing hostname through deploy, scale-related regeneration or rollback; the existing route remains selected. Test normalized names, wildcard policy and explicit release/reassignment.

### SEC-08: Published dependency vulnerabilities remain in the lockfile

The attempted `npm audit --json --fetch-retries=0 --fetch-timeout=15000` could not reach `registry.npmjs.org` because DNS/network access is restricted. Maintainer advisories were checked through web retrieval instead. This is a targeted advisory review, not an exhaustive clean dependency scan.

| Locked production package | Confirmed advisory | Applicability | Required action |
| --- | --- | --- | --- |
| `multer@2.2.0` | [GHSA-qfvm-cv95-jqjf](https://github.com/expressjs/multer/security/advisories/GHSA-qfvm-cv95-jqjf), CVE-2026-77037 | Tug uses the affected disk storage path for authenticated deployment uploads | Upgrade to a patched release, at least `2.3.0` |
| `js-yaml@4.2.0` | [GHSA-2883-xcg3-v3hh](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) | Untrusted local config/Compose YAML can cause excessive parsing work; the control deployment API parses JSON | Upgrade the 4.x line to at least `4.3.2` and bound input size/work |
| `tar@7.5.17` | [GHSA-w8wr-v893-vjvp](https://github.com/isaacs/node-tar/security/advisories/GHSA-w8wr-v893-vjvp), [GHSA-23hp-3jrh-7fpw](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw), [GHSA-r292-9mhp-454m](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m) | Version falls in affected ranges; Tug's prescan and entry limits mitigate some paths, and the member-selection recursion path was not established as reachable | Upgrade to a currently patched version, at least `7.5.21` for these advisories; retain and strengthen application bounds |

**Reproduction:** A synthetic multipart file upload through the installed Multer middleware, with the same limits as control, was aborted after opening the destination. The callback completed while the destination stream remained `closed: false`, `destroyed: false` with an open file descriptor. The audit explicitly destroyed the stream afterward. No listening socket or repeated resource exhaustion was required.

**Impact:** Repeated failed deployment uploads can exhaust descriptors and retain disk blocks in the control process. The role/class gates mean this specific Tug upload path requires a `deploy` or admin identity, unlike an unauthenticated generic Multer installation. Other Multer advisories requiring two text fields are not claimed as demonstrated because Tug limits text fields to one. The YAML and tar issues are dependency risks with the narrower reachability stated above.

**Regression coverage:** Aborted and truncated uploads must close destination streams and remove files. Run malformed archive checks in subprocesses so unexpected process termination is observable. Run a complete production and development dependency scan and container OS-package scan in network-enabled CI.

### SEC-09: Builds can hold a global writer indefinitely

**Evidence:** `src/control.ts:758` maintains a process-wide writer queue. Deployment handling enters it at `src/control.ts:2049` and holds it while awaiting build, save, import and resolution work. `src/build.ts:23` starts child processes without a timeout or cancellation signal and accumulates all stdout/stderr in memory. Cancelling the deployment marks its record but does not terminate the running build. Multipart limits apply per file, allowing up to 64 files of 5 GiB each by default before aggregate validation.

**Impact:** One malicious or stalled Dockerfile, such as a build step that never finishes, can block every later deployment, rollback and control backup/restore waiting on that writer. Excessive build output can exhaust control memory. Uploads and queued operations also lack per-principal aggregate storage/concurrency quotas. A denial-of-service load test was deliberately not run on the shared Docker host.

**Remediation:** Apply build and child-process deadlines, bounded output tails, cancellation that terminates the process tree, total upload byte limits and per-principal admission quotas. Perform long-running preparation outside the global writer and hold the publication lock only for the short validated state transition. Preserve project-level exclusion and recheck authorization/leases at publication.

**Regression coverage:** A blocked build in project A must not block an unrelated project's deployment or administrative recovery. Cancellation/timeout must terminate work and release resources. Oversized combined uploads and output must be rejected without unbounded buffering.

### SEC-10: Deploy-role operations expose project secret values

**Evidence:** `/api/v1/live` requires `deploy`. Its `inspect` operation reaches `src/live.ts:234`, which forwards the complete `docker.inspectContainer` result, including resolved `Config.Env`. Exec can also read the environment, and a deployment author can create a workload that sends referenced secrets elsewhere. This contradicts the former access-control statement that a deploy token can never read secret values.

**Reproduction:** The live operation engine forwarded an inspect result containing a dummy `DATABASE_PASSWORD` value. This was a structured forwarding test with a fake Docker API, not a read of real container credentials.

**Impact:** Anyone granted deploy access can read service secrets in that project. This is usually an inherent capability of application deployment and execution; the security defect is granting that capability under a contradictory promise. It remains relevant even after host access in SEC-01 is restricted.

**Remediation:** Treat deployment/execution access as access to the workload's secrets and document that contract. Redact inspect environment values by default to reduce accidental disclosure, while making clear that redaction cannot constrain an actor allowed to deploy or execute arbitrary application code. Separating those privileges requires a constrained deployment model.

**Regression coverage:** Verify the chosen inspect redaction behavior and role policy, and keep the documented secret-access contract consistent with exec, one-off runs, logs and deployment capabilities.

## Reviewed controls that provide useful protection

- The production listener requires CA-validated client certificates with TLS 1.3; identity class, URI and stored public-key hash are checked against current database state. The route class gate runs before body parsing. Real network handshakes could not be rerun in this sandbox, so these are source-reviewed controls rather than a new live-handshake certification.
- Operator roles come from the route table, and the common guard enforces declared roles and project scope. Node-only routes do not accept operator identities. Revocation/disable closes tracked TLS connections, and ongoing requests recheck identity state.
- CSRs are signature-checked, restricted to P-256 and signed with server-assigned identity/usage extensions. Credential and private-key writes use restrictive modes and durable replacement. Client transports pin the supplied CA and verify the public control hostname even when the TCP destination is overridden; redirects are refused.
- Secrets use AES-256-GCM with random nonces. The normal node secret endpoint filters by service placement and referenced secret names; registry credentials are separately scoped by registry host. These controls do not remove the deployment privilege or backup exposure findings above.
- Uploaded source/image archives are prescanned, links and path traversal are rejected, image metadata and tags are checked before import, and agent image downloads verify byte count and SHA-256. Build context and Dockerfile resolution reject paths outside the uploaded root.
- SQL values generally use bound parameters. Process execution generally uses argv rather than a shell; SSH command interpolation uses shell quoting, and rendered control Compose scalar values are quoted. No literal production private keys or common provider-token patterns were found in the reviewed repository scan; this was not a full Git-history or entropy scan.

## Validation and limits

The final full test run under Node `v26.13.0` reported 417 tests: 305 passed and 112 failed. Of the failure entries, 108 explicitly reported listener `EPERM`; three others failed CLI/config assertions or credential fixtures, and the Docker API test file also failed after its listener errors. An earlier run reported 420 tests with 297 passing: the in-progress working tree changed during review. A targeted run of 92 existing tests covering builds, archive validation, registry handling, encryption, Compose/container rendering, ingress, mesh, backup scheduling, restore and agent jobs passed. `npm run build` passed.

The final `npm run typecheck` passed after concurrent working-tree updates. `npm run lint` failed on an unused assignment in `src/cli.ts:303`, with three unused-variable/function warnings. Formatting checks passed for the audit documentation and changeset. These are release readiness observations, not additional proven vulnerabilities. The live mTLS suite, WebSocket transport tests, Docker-backed integration tests, actual Caddy configuration loading, WireGuard packet revocation, container image/OS scanning and real-host filesystem access were not validated here: local TCP listeners are denied and the Docker socket is inaccessible. npm advisory access from the shell also failed. Repository branch protections, deployed firewall rules, cloud IAM, backup-bucket policies and running host/image patch levels were not inspected.

The README and several operational documents still describe pre-mTLS bearer-token installation and authentication. Finish that documentation update with the mTLS work before release; the current code requires credential files and direct mTLS or TLS passthrough. A conventional TLS-terminating proxy cannot substitute for the end-to-end client certificate check implemented here.

## Remediation order

1. Establish the deployment trust model and stop presenting scoped deploy access as host or secret isolation (SEC-01 and SEC-10). Prevent credentials from entering build inputs (SEC-06).
2. Validate node reports, bind backup side effects to command ownership, and withdraw disabled nodes from peers and ingress (SEC-02, SEC-03 and SEC-04).
3. Protect backup directory/archive modes, reserve ingress hosts and update vulnerable dependencies (SEC-05, SEC-07 and SEC-08).
4. Bound builds, uploads, process output and queue occupancy; finish mTLS documentation and run the full suite in an environment that supports its network and Docker requirements (SEC-09).
