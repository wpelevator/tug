# Security audit

## 10 November 2026 audit

Reviewed Tug `v2.0.0` (`4923f0332df4a390ea0797a96752d5a1af7ef76b`) and the upgrade branch through `e6f5071004c791e6a0c0d2a0fbd42043ca500132`. The review covered the control listener and API, operator and node credentials, WebSockets, deployment and artifact handling, ingress, secret delivery, backups and restore, CLI bootstrap and upgrades, dependencies, and release workflows. Findings below describe source-reviewed paths and scanner results. Severity reflects the privileges and conditions each finding requires.

Tug assumes trusted deployment authors with administrator-equivalent access to eligible workload hosts. Mutual TLS protects control traffic. Workload traffic, shared backup storage and runtime images have separate trust boundaries.

### Application findings and remediation

The remediation fixes SEC-11, SEC-12, SEC-14, SEC-15 and SEC-17, accepts SEC-13 as a property of trusted nodes, and fixes SEC-16 with the upgrade commands. None of it changes the wire protocol or a persisted format, so it ships as a patch and 2.x control, CLI and agents keep working together.

| ID | Audit severity | Status | Remediation |
| --- | --- | --- | --- |
| SEC-11 | Medium–High | Fixed | WebSocket dispatch matches exact origin-form paths before authentication without parsing request targets as URLs, so a malformed target no longer crashes control. Unrecognized paths are refused with a 404. Reaching the handler needs a certificate the control CA signed, which is why this is not rated Critical. |
| SEC-12 | Low–Medium | Fixed | An event `limit` that is missing or not a number is the default of 100, and any other value is clamped into 1–500 in both pagination modes, so no request can ask for an unbounded page. |
| SEC-13 | Medium | Accepted by design | A node chooses the upstream port it reports. Nodes are trusted: a node already controls its own host and its workloads, so filtering the port it reports against a range on control adds no protection and would silently drop the rolling endpoints of every node with its own `TUG_ROLLOUT_PORTS`. Control and the agent only refuse the two loopback management ports of the managed Caddy (`2019` and `2021`). [Routing](networking.md#rolling-services-and-service-names) |
| SEC-14 | Medium | Fixed | The audit event of a one-off run still records the command, so the trail stays complete. `GET /api/v1/events` and the watch event frames omit the command (from the message and from `metadata.command`) for `read` credentials, the only role that cannot already `exec` into the workload and read its secrets. Pass secrets through stdin or the environment, not as arguments. [Audit trail](access-control.md#audit-trail) |
| SEC-15 | Medium | Fixed | Human event output strips terminal escape sequences and flattens remaining control characters. JSON output retains event data. |
| SEC-16 | Medium | Fixed with the upgrade commands | `tug control upgrade` replays the requested mTLS bindings (every host address, IPv4 and IPv6) and refuses an installation with extra published ports or host networking, instead of publishing the control port on every interface. [Control upgrades](control-plane.md#upgrading-the-control-plane) |
| SEC-17 | Low | Fixed for new conflicts | Deploy, rollback and domain mapping show only the requested hostname when the owner is outside the caller’s scope. Automatic rollback records a generic conflict. |

### Trust boundaries and hardening

- **Control egress and registry credentials.** `src/images/registry.ts` resolves deployer-selected image registries from control’s network. A registry’s Bearer challenge can also select a different HTTPS origin and receive the registry’s configured Basic credentials. Registry redirects are blocked, manifest bodies are bounded, and digests are checked, but token response bodies are read without a byte cap. Treat private registries and their token issuers as explicit trust relationships. Restrict control and build-worker egress to authorized destinations, bind credential forwarding to approved token issuers, and cap token response bodies.
- **Backup recovery remains a shared availability boundary.** A node running a backup receives the shared destination credentials and its project’s repository password. When that storage identity can modify sibling prefixes, a compromised node can destroy other projects’ backups and control backups. Repository passwords protect contents independently. Separate control storage credentials and enforce prefix-specific workload grants and retention at the storage layer. Add an absolute server-side lifetime for agent jobs so heartbeats alone cannot keep an old authorization alive (remaining work from SEC-03). See [Backups](backups.md#automatic-backup-to-the-destination).
- **Build snapshots can contain unrecognized secrets (SEC-06).** Tug excludes known credential files and resolved credential paths, but a secret it cannot identify can still enter a local or remote build snapshot. Review the source context and its ignore rules before building. See [CLI source snapshot rules](cli.md#arguments-options-and-configuration).
- **Upload and build resource limits remain incomplete (SEC-09).** Multipart requests can write up to 64 files at 5 GiB per file by default, subject to disk and request time limits. Disk staging happens before project admission and before the writer queue. Per-file and archive expansion checks help, but there is no deployment-wide byte budget or concurrent upload budget. Build preparation can still delay unrelated writes while holding the global writer. Use a bounded staging volume, enforce aggregate size and concurrency limits, and move preparation out of the global writer. Remote builds execute on the control Docker daemon. An isolated builder reduces the scope of build failures and control-side egress.
- **Install and release provenance.** Publish jobs use npm OIDC and request npm provenance. The workflows use mutable action tags, the runtime base and Caddy image are tag-based, and the installer accepts an already-cached image by tag. Pin privileged release actions by commit, record and verify image digests and attestations at install and upgrade, and refresh helper digests through scanned updates. [GitHub Actions secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)

### Dependency and image checks

The Tug lockfile had zero production advisories from `npm audit --omit=dev`. A full npm audit reported ten moderate package entries, all tracing to one `minimatch` advisory in lint tooling. [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)

Example dependency checks were separate from Tug’s runtime. The Node example had zero production npm advisories. Composer reported seven advisories across four Symfony packages in the Laravel example. OSV flagged the Django example’s direct `Django==5.2.8` pin. Refresh those example dependencies before using them in production. [Django 5.2.19 security release](https://www.djangoproject.com/weblog/2026/nov/03/security-releases/)

Trivy `0.76.2` scanned the published Linux `amd64` and `arm64` image variants. Both architectures had the same counts. Each count is a package-advisory match per architecture, so one CVE can appear for more than one package.

| Image and scanned index digest | High | Critical | Triage |
| --- | ---: | ---: | --- |
| `ghcr.io/wpelevator/tug:2.0.0` · `sha256:48e333e6727d194320c93894e9b7fc1d1f0488671e32c3cc7c1709fc190aaf94` | 6 | 0 | All six high matches were in the base image’s bundled npm dependencies (`brace-expansion` and `undici`). Refresh the base or remove npm and its bundled modules from the final image if the runtime does not use them. |
| `caddy:2-alpine` · `sha256:78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9` | 2 | 0 | Caddy `2.11.9` contained `go-jose/v3` and `golang.org/x/net` findings. Reachability through Tug’s generated Caddy configuration was unverified. Track a scanned replacement digest. |
| `restic/restic:0.19.1` · `sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510` | 36 | 6 | The six critical matches are OpenSSH client packages, including `CVE-2026-60002`, which the upstream report names. Prioritize a scanned helper image with patched OS packages and a rebuilt restic binary, then verify backup and restore. The usual S3 path does not use the SSH client, and package detection alone does not establish a reachable vulnerability. [Restic upstream report](https://github.com/restic/restic/issues/22172) |

### Verification and scope

The remediation adds regression tests for each fix: a raw malformed WebSocket upgrade (`//[`) that crashed control before the fix and now gets a 404 while control keeps serving, the event limit clamp, the role-based redaction of one-off commands over the events API and the watch stream, the loopback management ports in both the agent's allocator and control's endpoint resolution (and that a node's custom range is not filtered), hostname conflicts across scoped credentials, and escape stripping in human output. The full Node test suite (995 tests), type checking, lint and the formatting check passed on the remediation branch. The Docker integration suites were not rerun for this change.

New source findings were assessed by tracing the affected code and existing tests. Gitleaks `8.30.1` reported no matches across 388 commits reachable from local refs. A tracked-file scan for common private-key and provider-token markers also found no matches. Deployed firewall rules, branch protections, cloud IAM and backup-bucket policies, and production host patch levels were outside the available evidence.

## Status of earlier findings

This table summarizes the findings from 1 November 2026. The cleanup reran 101 existing regression tests covering the controls below. The dependency entry uses the resolved package versions and the 10 November audit results.

| ID | Status | Current evidence |
| --- | --- | --- |
| SEC-01 | Accepted by design | Deployment authors are trusted with eligible workload hosts and their secrets. Project scope limits API access. See [the trusted-operator contract](roadmap.md#product-decisions-and-reasoning). |
| SEC-02 | Verified fix | Control rejects malformed status ports and node addresses containing configuration syntax. SEC-13 records why numeric upstream ports are not filtered by range. [Status and ingress tests](../src/control/node-reports.test.ts), [address tests](../src/control/placement.test.ts) |
| SEC-03 | Verified fix for command ownership and credential release | Foreign and completed commands cannot change backup state. Control withholds credentials when the command is ineligible or the node has lost project placement. The remaining job-lifetime gap is listed under hardening. [Report tests](../src/control/node-reports.test.ts), [credential tests](../src/control/backup-destination.test.ts) |
| SEC-04 | Feature removed | Tug no longer distributes WireGuard peer configuration or serves mesh routes. Regression tests also verify API identity revocation, endpoint withdrawal, and rejection of new explicit placement on disabled nodes. [Mesh removal](../src/control/network.test.ts), [mTLS](../src/control/mtls.test.ts), [endpoints](../src/control/node-reports.test.ts), [placement](../src/control/placement.test.ts) |
| SEC-05 | Verified fix | The control backup archive is `0600` and its directory is `0700` even under a permissive umask. Failed backups clean up staging files and partial archives. [Backup tests](../src/control/backup.test.ts) |
| SEC-06 | Partially fixed | Local and remote snapshot tests verify mandatory exclusions for known and explicitly configured Tug credential files. The risk from unrecognized secrets remains under hardening. [CLI tests](../src/cli/cli.test.ts) |
| SEC-07 | Verified fix for hostname ownership | Deploy, rollback and domain mapping enforce exact and wildcard conflicts across projects. Publication rechecks ownership after build preparation. SEC-17 records the separate fix for conflict response details. [Ownership tests](../src/control/ingress-hosts.test.ts), [domain publication tests](../src/control/network.test.ts) |
| SEC-08 | Original advisories patched | The lockfile resolves patched versions of Multer, js-yaml and tar for the original findings. Current dependency and image results are listed above. [Lockfile](../package-lock.json) |
| SEC-09 | Partially fixed | The build command runner enforces a deadline and caps retained output. Writer occupancy and aggregate upload limits remain under hardening. [Build tests](../src/images/build.test.ts) |
| SEC-10 | Verified fix for inspect output | Live inspect keeps environment names and redacts values. The access-control contract treats deployment and exec as access to workload secrets. [Inspect tests](../src/agent/agent.live.test.ts), [access control](access-control.md#limits) |
