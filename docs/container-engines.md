# Podman and alternative container engines (proposal)

Status: proposed; implementation has not started. Written 7 November 2026 against `552477a`. It is listed under [Later](roadmap.md#later--only-if-needed) in the roadmap and needs a demonstrated need and the spike below before it becomes a milestone.

## Outcome

Run Tug on a node or control host whose engine is Podman (rootful first) through Podman's Docker-compatible API socket, with the engine identified, reported and verified by `tug doctor`. Docker Engine stays the default and the only engine Tug installs. containerd is explicitly out of scope; see [Non-goals](#non-goals).

Tug already speaks the Engine API through the `DockerApi` interface in `src/docker-api.ts`, so this is a compatibility and verification project, not a new backend. Do not add a general engine-abstraction layer: the seam exists, and a second implementation of it is only justified by an engine that lacks the Engine API.

## Findings that shape the plan

- The agent uses about 25 `DockerApi` methods at API `v1.41` over a unix socket (`DOCKER_HOST` or `/var/run/docker.sock`). Podman's compat layer serves this surface, but behavior at the edges differs (see [Risks to verify](#risks-to-verify)).
- Everything outside the agent shells out to the `docker` binary: `build` (`src/build.ts`), `save` and `image inspect` (`src/artifacts.ts`), `load`, `tag` and `image rm` (`src/control.ts`), `manifest inspect` (`src/image.ts`), `compose config` (`src/normalize.ts`) and `version` (`src/control.ts` doctor check). Podman's CLI accepts the same arguments for all but Compose.
- The runtime image ships `docker-cli`, and control and agent containers mount the engine socket. The installer ([Nodes](nodes.md)) installs Docker's repositories and rejects `podman-docker`.
- Archive validation already tolerates the containerd image store's `docker save` output, so image-ID differences between stores are handled; Podman's `podman save` output must be checked against the same validator.

## Decisions

| Concern | Decision |
| --- | --- |
| Supported engines | Docker Engine (default) and rootful Podman 5+ via its compat socket. Docker Desktop, Colima, OrbStack and Rancher Desktop in moby mode are Docker daemons and need no work. |
| Engine identity | Read it from `GET /version` (`Components[].Name`), store it on the node report and show it in `tug nodes` and doctor. Behavior never branches on the engine name except where a verified gap needs a workaround, and each such branch is listed in the docs. |
| CLI dependency | Move `save`, `load`, `tag`, `image inspect` and `image rm` in control onto the Engine API through `DockerApi`, so control needs a CLI only for `build`, `manifest inspect` and Compose. Where a CLI remains, an engine setting (`docker` or `podman`) chooses the binary. |
| Compose | Normalization needs a Compose renderer only. The control host uses whichever of `docker compose`, `podman compose` or `docker-compose` it finds, and doctor reports which. |
| Rootless | Not supported in the first release. Host-side health checks and container-IP reachability assume a routable bridge. Revisit only after the spike shows an acceptable design. |
| Installer | Tug keeps installing Docker only. A pre-installed Podman is accepted when its socket answers and the doctor checks pass; the installer stops rejecting `podman-docker` when Podman is the working engine. No Podman installation path is added. |

## Risks to verify

The spike (step 1) answers each before any code is written.

- **Container IPs from the host.** The reconciler probes health by container IP. Confirm rootful Podman with netavark exposes routable bridge IPs; confirm rootless does not.
- **Restart policy.** Podman needs `podman-restart.service` for `RestartPolicy` to survive a reboot. Doctor must detect and report it.
- **Healthchecks.** `Healthcheck` in the create body runs through systemd timers; confirm status appears in `inspect` as the agent expects.
- **Network aliases and DNS.** Confirm `connectNetwork` aliases and aardvark-dns resolve service names the way the service DNS proposal expects.
- **Volumes.** Confirm `driver: local` with `driver_opts` and the label filters the agent uses behave identically.
- **Image IDs and `pullImage` auth.** Confirm `X-Registry-Auth`, digest pulls and the config-digest versus index-digest identity paths.
- **Socket mounting.** SELinux hosts need the socket mounted with `--security-opt label=disable` (or an equivalent label). Document the supported form of the control and agent setup.
- **API floor.** Confirm `v1.41` is served, and whether `GET /info` reports the fields doctor reads.
- **Privileged ports.** Rootful is unaffected; note the sysctl for the rootless case in the docs only.

## Implementation checklist

1. [ ] Spike: on a rootful Podman 5 host (Fedora or Alma VM), run the existing integration tier by hand against the compat socket, record every failure against [Risks to verify](#risks-to-verify) and update this plan's scope with the results.
2. [ ] Detect and report the engine: parse `/version`, add it to the node report and protocol, show it in `tug nodes` and doctor. A protocol addition is additive; choose the bump by [Releases](releases.md#choosing-the-bump).
3. [ ] Replace the control-side `docker save`, `load`, `tag`, `image inspect` and `image rm` shell-outs with `DockerApi` methods (`saveImage`, `tagImage` and friends), implement them in `DockerEngine` and `FakeDocker`, and keep the artifact validation tests passing.
4. [ ] Add an engine setting that selects the CLI binary for `build`, `manifest inspect` and version checks; default `docker`.
5. [ ] Make Compose rendering discover `docker compose`, `podman compose` or `docker-compose`, with a clear doctor message when none is present.
6. [ ] Extend doctor with Podman-specific checks: restart service enabled, rootless detected (unsupported, clear error), socket mount and SELinux hint.
7. [ ] Apply each workaround the spike requires, each with a test whose assertion message states the expected behavior.
8. [ ] Add a Podman variant of the `tools/docker/fake-vps` integration tier and run it in the same tier as the Docker one; add the fixes for findings it surfaces to [Testing](testing.md)'s regression table.
9. [ ] Update [Nodes](nodes.md) (installer behavior with a pre-installed Podman), [Getting started](getting-started.md), [Troubleshooting](troubleshooting.md), [Security](security.md) (the engine socket is host-administrator power under either engine), [Development](development.md) (runtime image CLI) and the README with an engine compatibility table.
10. [ ] Add a changeset; when it ships, fold this proposal into the compatibility table in the docs and delete it.

## Non-goals

- **containerd as a runtime.** It exposes gRPC, not the Engine API, and has no networks, DNS aliases, healthchecks, restart policy, log or volume API. Supporting it means reimplementing the Docker daemon's behavior inside the agent. If a real need appears, the least-bad option is an opt-in `nerdctl`-driven backend behind `DockerApi`, which needs its own plan and threat model. Docker with the containerd image store is already handled and unaffected.
- **Rootless Podman** in the first release.
- **CRI-O, Incus and Kubernetes runtimes.**
- **Installing Podman** from `tug nodes`.
- **Engine-specific feature surfaces** (pods, quadlets, systemd units). Tug manages containers through the Engine API only.
