# Upgrade control and nodes

Move control, then every node, to a new release with one command.

```sh
tug upgrade
```

`tug upgrade` runs `tug control upgrade` on `controlSsh` and then `tug node upgrade --all`, in that order, because control refuses agents that run ahead of it. It stops without touching a node when control fails. It uses this CLI's version, or `--to <version>`, for everything and ignores per-node `image` settings. Install the new CLI first (`npm install -g @wpelevator/tug`). A major release can change how deploys behave, see [Upgrading to 3.0](releases.md#upgrading-to-30-values-come-only-from-control).

## Common tasks

Upgrade one piece at a time, to pin a node to its own version or stage the rollout:

```sh
tug control upgrade --yes
tug node upgrade app1
tug doctor
tug ps
```

Confirm with `tug doctor` and `tug ps` right after the control upgrade. If `tug doctor` reports a CA fingerprint mismatch, follow the [mismatch runbook](troubleshooting.md#cli-control-version-or-credentialca-mismatches).

Roll control back with `tug control upgrade --rollback`, which redeploys the image the upgrade tagged `tug:rollback`. Roll nodes back together with it, see [Rolling back](#rolling-back).

## What `tug control upgrade` does

`tug control upgrade [<ssh-target>] [--to <version>]` is the one step for a new release. The SSH target is `controlSsh` in `tug.yml` when omitted.

| Step | What happens |
| --- | --- |
| 1 | Reads the running container: published mTLS addresses and ports, advertised URL, extra names |
| 2 | Tags the image it replaces as `tug:rollback` |
| 3 | Starts the new image on the same `tug-control` volume |
| 4 | Checks that the CA on the volume did not change |
| 5 | Waits for control to answer with its version |

Upgrade and rollback preserve every supported IPv4 and IPv6 binding for the mTLS port. Installations with extra published container ports must be upgraded manually. Rollback redeploys `tug:rollback`. Across a schema change, the older control refuses the migrated database, see [Rolling back](#rolling-back). After the upgrade, match the agents with `tug node upgrade --all`, see [Upgrade an agent](nodes.md#upgrade-an-agent).

## How version skew is checked

Tug trusts [semver](https://semver.org). The compatibility key of a version is its major, or the whole `0.minor` while the major is 0, because semver promises nothing for 0.x. Control, CLI and agents interoperate when their compatibility keys match. Inside one major a newer minor only adds, and a patch never changes what they say to each other. See [Choosing the bump](releases.md#choosing-the-bump).

Version information rides ordinary traffic as headers, so there is no dedicated round trip:

| Mechanism | Behavior |
| --- | --- |
| Control stamps responses | Every HTTP response carries `x-tug-version`, so clients know what answers them |
| Clients declare their version | Every CLI and agent HTTP request to control carries `x-tug-client-version`. Requests to anything else, such as agent health checks against your containers, never do. WebSocket upgrades carry it but are not gated on it |
| Control refuses newer keys | Control refuses a request declaring a newer compatibility key than its own before running the handler. From 1.0, a client with a newer minor of the same major is served. A CLI ahead of control is stopped by control itself, and an agent is refused rather than allowed to talk down what it assumes |
| Reads | `status` and service listings judge the stamp on their own responses and pay no extra request, because reads are safe to run against an older control |
| Mutations and live commands | `deploy`, `rollback`, `restart`, `backup`, restore, `node add`, and live commands that open the channel without a read first (`exec`, `run`, `logs`, `ps`, `inspect` with an explicit node or non-interactive) first send `GET /api/v1/version`. A mutating request is never already received by an old control when the refusal arrives |

### What you see

| Situation | Result |
| --- | --- |
| Control is older than the CLI | The command is refused with `tug control upgrade <control host> --yes`. A missing stamp on a command's own read reports this too, because that control predates both stamp and probe. The fix redeploys control at the installed CLI's image tag and keeps state and PKI in the `/data` volume |
| CLI is older than control, same key | Works. From 1.0, an older minor needs nothing. Before 1.0 it proceeds with one warning naming `npm i -g @wpelevator/tug@<version>` |
| CLI is older than control, newer major | Control refuses the command with the same pin command, because it no longer supports that CLI |
| CLI is a newer minor than control, same major | Commands work unless one needs a route added in that minor. That fails with control's 404 explained by `the control runs X, this CLI is Y ... tug control upgrade <control host> --yes` |

## Rolling back

Rolling control back below the agents' version is refused the same way. An agent newer than its control gets control's refusal on every poll, logs it with the remedy, and keeps its containers running without reconciling until the versions agree. Roll control back together with the agents (`tug node upgrade --all` with the older CLI, or `--to` control's version), or upgrade control again. Do not leave agents ahead of it.

Control's database upgrades itself when the new control starts. It copies a database that holds data to `tug.db.pre-v<N>.bak` in the data directory, runs the pending schema steps and records the version. From 1.0, an older control refuses a database from a newer one with one `error:` line in its log that names the schema versions, and Docker keeps restarting the container until you act.

To roll back across a schema change you need the pre-upgrade state:

1. Stop control.
2. Put the `.pre-v<N>.bak` copy back as `tug.db`, or restore a control backup taken before the upgrade.
3. Start the older image.

Doing so discards every deployment and other change made since the upgrade. A minor release that changes the schema says so in its changelog.
