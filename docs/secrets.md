# File-mounted workload secrets (proposal)

Status: proposed; implementation has not started. Written 3 November 2026 and moved here from a working plan on 7 November 2026 against `4721cdd`. It is a possible evolution of [Secrets](architecture.md#secrets) and is listed under [Later](roadmap.md#later--only-if-needed) in the roadmap. It needs a demonstrated need and the storage spike in [Phase 1](#phase-1-prove-the-storage-boundary) before it becomes a milestone. This covers the current standalone-container runtime: the separate [Swarm comparison](swarm-comparison.md) notes that Swarm has native in-memory secret files, so if a Swarm-backed Tug is ever selected first, carry the Compose and file-consumption contract below into that work and skip the agent-managed storage.

## Outcome

Deliver project secrets to a container as read-only files under `/run/secrets/` instead of environment variables, using Tug's existing encrypted project store and its authenticated, placement-scoped delivery. Environment interpolation stays for applications that need it. Tug does not convert files into variables, inject an entrypoint wrapper or require a shell in application images. `_FILE` variables are an image convention, not a Docker feature: the application must support them or read the file itself.

The benefit is less accidental disclosure through `Config.Env`, `docker inspect`, process environments and debugging tools, the gap recorded in [Docker Swarm comparison](swarm-comparison.md#secret-handling-and-certificate-recovery-have-gaps). It does not isolate secrets from root, the Docker socket, trusted deployment authors or application processes granted the files, and tmpfs can be swapped to disk, so never promise that plaintext cannot reach storage. The [access boundaries](access-control.md) are unchanged.

## Options considered

| Option | Evaluation |
| --- | --- |
| Native Docker Engine secrets | Available to Swarm services, not standalone containers. Right for a Swarm proposal, not an incremental change to today's agent. |
| Agent-managed files on host tmpfs, mounted read-only per file | Recommended. Reuses encrypted control storage and scoped delivery, keeps values out of Engine environment configuration and works with read-only roots and arbitrary entrypoints. Needs a daemon-visible path, careful lifecycle management and recovery after reboot. |
| Plaintext files in the persistent agent state directory | Easier to restart while control is down, but leaves decrypted secrets on disk and in host backups. Never a silent fallback. |
| Container tmpfs populated by exec or archive copy | Needs a startup coordination mechanism, and ordinary Docker restart policies bypass Tug. Not selected. |

## Where the code stands

- `src/compose/normalize.ts` runs `docker compose config` and keeps project-secret references as sentinels, so values never reach the operator machine. `src/compose/compose.ts` rejects top-level and service `secrets`.
- `src/control/control.ts` validates sentinel references at deploy time and serves current values and versions through `/agent/v1/secrets`, filtered by requested services and actual node placement. `TUG_REGISTRY_AUTH` is reserved and delivered separately.
- `src/container-spec.ts` hashes definitions plus referenced secret versions and substitutes values into Engine definitions. Recreate and rolling reconciliation both use these hashes, so file references must take part without putting values into definitions.
- `src/agent/agent.ts` fetches secrets before reconciling, and `src/agent/reconciler.ts` creates candidates and removes obsolete containers. Preparation must finish before an existing container is replaced, and cleanup must follow actual container removal.
- Agents run in containers. SSH installation binds `/var/lib/tug` and enrollment uses a named state volume, so a path inside either is not automatically the path the Docker daemon sees.
- `src/agent/live.ts` `startOneOff` clones the selected container's mounts, so `tug run` containers become secret-file consumers that cleanup must retain.
- `tug secret set` reads one stdin chunk and trims it, which breaks PEM files. Secret removal has no reference guard, and deleting and recreating a secret can reset its numeric version.

## Proposed contract

```yaml
services:
  db:
    image: mariadb:11
    environment:
      MARIADB_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password

secrets:
  db_password:
    external: true
    name: DB_PASSWORD
```

This fragment shows delivery only. The project must already contain `DB_PASSWORD`, set with `tug secret set DB_PASSWORD`. In Tug `external: true` means the secret exists in the project's Tug store, not that it was made with `docker secret create`. An omitted `name` uses the declaration key without Compose project prefixing. Local `docker compose up` needs its own secret source or an override.

- Accept short references and long references with `source`, a single filename `target`, numeric `uid` and `gid`, and a read-only `mode`. The default target is the declaration key under `/run/secrets/`, with ownership `0:0` and mode `0444` like Compose's file-consumption convention. Reject writable and executable bits. Each service gets its own files, so differing ownership or modes never touch another consumer. Tug implements this subset itself even when local Compose warns that it ignores ownership and mode outside Swarm.
- Accept only top-level `external: true` with an optional literal `name`. Reject local `file`, `environment`, inline content, drivers, templated source names, unknown fields and use through `build.secrets` (build-time secrets are a separate feature).
- Reject undefined declarations, missing store entries, duplicate target filenames, path traversal, absolute or nested targets, and volume or tmpfs mounts at or above `/run/secrets` or a secret target. Validate raw API submissions as strictly as CLI-normalized input, and keep `TUG_REGISTRY_AUTH` reserved on every reference path.
- Discover references in one place: the union of sentinels and resolved service declarations feeds deploy checks, node authorization, change hashes, status and removal guards. An unused declaration releases no values and restarts nothing.
- Add `tug secret set NAME --file PATH` with exact UTF-8 input that preserves whitespace and newlines, and make piped stdin read to EOF without trimming. `--value` and `--file` are mutually exclusive. The store stays text-only; binary secrets are deferred. Validate names and byte sizes the same way in the API and CLI, starting at 500 KiB per secret, and enforce an aggregate budget before any container changes.

### Rotation, deletion and rollback

Updating a secret still replaces only the services that reference it. Rotation is not atomic across nodes, services or external credential providers, so operators must let old and new credentials overlap, and changing a database password file does not rotate an initialized account.

Keep the latest-value model: rollback restores configuration and images and resolves the currently stored secrets, with no historical recovery or release-pinned secrets. Old running or draining containers keep the files they started with until removed. After a reboot an older version cannot be rebuilt from today's store, so Tug recovers the current desired revision.

Reject deletion of a secret referenced by current desired state, TLS references included, under the project lock so it serializes with deploy and update. A missing value in a reconcile fails before an existing service is stopped and never becomes an empty file. Identify a store generation by secret-row identity plus version, or an opaque non-reusable generation, so deleting and recreating a name cannot alias an older version 1. Keep values and value-derived hashes out of labels, logs, desired state and status. Deleting a secret does not revoke files already delivered.

## Runtime design

### Storage and host integration

Use a dedicated host directory such as `/run/tug-secrets` on the host's existing `/run` tmpfs, mounted at the identical absolute path in the agent. Bootstrap creates it privately and startup verifies Linux tmpfs, refusing to materialize secrets otherwise. Keep it apart from persistent agent state and application volumes, and add only that bind, with no new privileged mode.

Update SSH install, replace and repair, enrollment snippets, cloud-init, development Compose and integration fixtures together. Bare Docker enrollment must also recreate the directory after a host reboot, so test the chosen bootstrap rather than assume systemd. Application binds use typed `HostConfig.Mounts` with `ReadOnly: true` and no source creation, so a missing file is an error and never an empty directory. Verify host and agent path identity with a daemon-side probe before touching workloads.

Initial scope is rootful Linux Docker on the agent's host without user-namespace remapping. Detect and reject other arrangements for secret-using services with an actionable diagnostic. Docker Desktop, nested daemons, rootless Docker and SELinux-enforcing hosts need explicit validation, and the supported matrix is narrowed in the docs if the design does not hold.

### Preparation and reconciliation

Keep `containerSpecs` pure: it emits logical secret mount requirements and a deterministic semantic hash from declaration, target, permissions and secret generation. A separate agent secret-store component resolves those to immutable daemon-visible paths and adds physical `Mounts`. Physical paths and random snapshot IDs never enter the service hash.

Prepare a private per-service snapshot directory, write each file with exclusive no-follow creation, set ownership and mode, then publish atomically. Reject symlinks, non-regular files and unsafe directory ownership, and use opaque identifiers in paths. Never overwrite a published snapshot: a permission change or rotation creates a new one, and a repeat reconcile adopts the verified snapshot without rewriting or restarting.

Prepare every file and check the byte budget before a recreate can stop a healthy container, and have both create paths take prepared specs. Rolling candidates get new files while active and draining revisions keep theirs. Dry-run and apply-disabled paths materialize nothing, and restore-held services stay held when a secret changes or preparation fails.

### Restart and reboot

- **Agent restart:** the tmpfs and existing files survive and applications keep running, including while control is down. Rebuild snapshot usage from Docker inventory without rewriting mounted files, and never empty the shared directory when an agent is replaced.
- **Docker restart without a host reboot:** source files remain, so restart policies can remount them without Tug.
- **Host reboot:** the tmpfs is empty, so secret-using containers may fail to start until the agent reconnects to control and prepares current values. Reconcile must detect missing or invalid mounts and recreate those containers even when the hash matches, onto fresh paths, respecting holds and readiness.
- **Control unavailable after a reboot:** secret-using workloads stay down until control returns. Do not fall back to plaintext on disk. Show this tradeoff in doctor, status and recovery docs. An encrypted offline cache could close it later but needs its own key storage and revocation design.

### Cleanup and other consumers

Garbage collection runs after reconciliation and on agent start, under the lock used to acquire snapshots. It inspects every container state, including stopped containers that may restart, candidate and draining revisions and `tug run` helpers, plus in-flight leases. It removes only owned snapshots with no container reference and no lease, never the whole root, and skips cleanup with a report when inventory fails.

One-off creation and snapshot acquisition are synchronized, helpers carry ownership metadata, and the lease is released only once Docker owns the container reference or creation fails. Command backup and restore run in existing workload containers and keep their secret access, while volume backup helpers get none. Secret files stay out of application-volume backups and control artifacts, and control backups keep the encrypted store under the existing control-backup trust contract.

## Implementation checklist

### Phase 1: prove the storage boundary

- [ ] Using Node.js test drivers and disposable Linux or nested-daemon fixtures, prove the identical host and agent tmpfs path, read-only file binds, ownership and modes, non-root reads, read-only root filesystems and shell-free images. Include the minimum Engine API version Tug supports, or revise that requirement from the evidence.
- [ ] Prove agent replacement, Docker restart, and host reboot with control available and unavailable, plus missing-source recovery, through the real SSH and bare enrollment paths. Do not reboot a developer or production host.
- [ ] Validate target distributions and SELinux, and fail closed on rootless, user namespaces, non-tmpfs and remote-path mismatch.

Exit: the host-path and reboot behavior is demonstrated with real Docker. If the tmpfs and bootstrap boundary fails, revise this proposal before building the lifecycle around it.

### Phase 2: input, references and store integrity

- [ ] Typed declarations and strict validation in `src/protocol.ts`, `src/compose/compose.ts` and normalization, with octal-string and numeric modes handled unambiguously, and one place that discovers references.
- [ ] Deploy admission and `/agent/v1/secrets` in `src/control/control.ts` carry file references and non-reusable generations, keeping placement filtering, the registry reservation and latest-value rollback.
- [ ] Locked, reference-aware deletion and fail-closed handling of missing secrets, TLS references and direct API submissions included.
- [ ] Exact `--file` and stdin input with consistent names and limits in `src/cli/commands/secret.ts`, with tests for multiline values, trailing newlines, empty text and oversize input.
- [ ] Tests in `src/compose/compose.test.ts`, `src/compose/normalize.test.ts`, `src/control/secrets-scope.test.ts`, `src/container-spec.test.ts` and the CLI for aliases, defaults, unsupported sources, path conflicts, ownership, reserved names, recreated generations, unrelated services and unused declarations.

### Phase 3: mount lifecycle and bootstrap

- [ ] An agent secret-store component with atomic immutable snapshots, safe paths and permissions, byte budgets, injectable filesystem dependencies and inventory-based garbage collection.
- [ ] Pure specs and Engine types extended, with preparation and mount validation in recreate and rolling reconciliation that fails before stopping healthy containers and recovers hash-matching containers with broken mounts.
- [ ] Every installer, enrollment snippet and development fixture gets the shared host bind, with doctor and status diagnostics that never show values.
- [ ] One-off acquisition and stopped-container retention tied into cleanup, covering interrupted writes, create failures, inventory failures, crash leftovers, racing one-offs, project removal, placement changes, failed candidates and drain completion.

### Phase 4: verification and delivery

- [ ] Extend `tests/integration/agent.secret-restart.test.ts` and the rollout, live and backup fixtures: exact file contents, rejected writes, only referencing services rotate, old and new bytes coexist through drain, files persist while a one-off uses them.
- [ ] Prove file-only values are absent from `Config.Env`, labels, status, events, desired-state JSON and Tug-generated logs and errors. Secrets an application emits itself are outside this guarantee.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, packaging checks and the affected real-Docker suites, and report any check the environment blocked.
- [ ] Fold the result into [Secrets](architecture.md#secrets), [Compose extensions](compose.md), [Nodes](nodes.md), [Configuration](configuration.md), [Access control](access-control.md), [Backups](backups.md), [Testing](testing.md) and the [CLI](cli.md), and update security claims only where behavior changed. Adapt examples to `_FILE`, with the database-initialization and rotation caveats.
- [ ] Add a `minor` changeset for the feature, and delete this proposal's status banner once it ships.

## Non-goals

- Isolating secrets from root, the Docker socket, deployment authors or the application itself.
- Native Docker Engine secrets or Swarm.
- Build-time secrets, binary secrets and historical or release-pinned secret values.
- An offline encrypted cache for reboots with control down, or an external secret provider such as Infisical or Vault. Both are separate proposals.

## References

Checked 3 November 2026: [Compose secret delivery and `_FILE` conventions](https://docs.docker.com/compose/how-tos/use-secrets/), [service secret syntax](https://docs.docker.com/reference/compose-file/services/#secrets), [bind-mount behavior and missing-source errors](https://docs.docker.com/engine/storage/bind-mounts/), [tmpfs lifetime and swap caveat](https://docs.docker.com/engine/storage/tmpfs/) and [Swarm secrets](https://docs.docker.com/engine/swarm/secrets/). They establish available primitives. The storage, lifecycle and support policy above still need the tests listed. A Compose v5.6.1 config-only probe showed it accepts external names and preserves long-form ownership and mode, with warnings that it ignores uid, gid and mode outside Swarm.
