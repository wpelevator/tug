# Upgrade control and nodes

Move control, then every node, to a new release with one command.

```sh
tug upgrade
```

`tug upgrade` runs `tug control upgrade` on `controlSsh` and then `tug node upgrade --all`, in that order, because control refuses agents that run ahead of it. It stops without touching a node when control fails. It uses this CLI's version, or `--to <version>`, for everything and ignores per-node `image` settings. Install the new CLI first (`npm install -g @wpelevator/tug`).

## Common tasks

Upgrade one piece at a time. This pins a node to its own version or lets you stage the rollout.

```sh
tug control upgrade --yes
tug node upgrade app1
tug doctor
tug ps
```

Confirm with `tug doctor` and `tug ps` right after the control upgrade. If `tug doctor` reports a CA fingerprint mismatch, follow the [mismatch runbook](troubleshooting.md#cli-control-version-or-credentialca-mismatches).

Roll control back with `tug control upgrade --rollback`, which redeploys the image that the upgrade tagged `tug:rollback`. Roll nodes back together with it, as described under [rolling back](#rolling-back).

## Reference

Tug trusts [semver](https://semver.org). The **compatibility key** of a version is its major, or the whole `0.minor` while the major is 0 (semver promises nothing for 0.x, so any minor may break). Control, CLI and agents interoperate when their compatibility keys match: inside one major a newer minor only adds, and a patch never changes what they say to each other. See [Choosing the bump](releases.md#choosing-the-bump) for how releases keep that promise. The check itself travels with ordinary traffic (the Docker `/_ping` bargain: version information rides headers, not dedicated round trips):

- The control stamps every HTTP response with its version (`x-tug-version`), so clients know what is answering them without a probe.
- Every CLI and agent HTTP request to the control declares the process's own version (`x-tug-client-version`; requests to anything else, such as agent health checks against your containers, never carry it); the WebSocket upgrades carry it too, but upgrade handling does not gate on it. The control refuses any request declaring a version on a newer compatibility key than its own **before running the corresponding handler** (from 1.0, a client with a newer minor of the same major is served), so a CLI ahead of the control is stopped by the surviving side itself, and an agent is refused rather than allowed to talk down what it assumes, matching the upgrade order below.
- A CLI grants itself the read-direction rule: read commands (`status`, service listings) judge the stamp on their own responses; since reads are safe to have run against an older control, they pay no extra request. Commands whose first control request is a mutation (`deploy`, `rollback`, `restart`, `backup`, restore), live commands that open the live channel without a read first (`exec`, `run`, `logs`, `ps`, `inspect` given an explicit node or running non-interactively), and `node add` take a one-request explicit probe (`GET /api/v1/version`) instead, so a mutating request is never already received by an old control when the refusal arrives.

Remediations:

- The control is older than the CLI (a missing stamp on a command's own read reports this too, the control predates both stamp and probe): the command is refused with `tug control upgrade <control host> --yes` as the fix. That redeploys the control container at the installed CLI's image tag and preserves the state and PKI in the `/data` volume.
- The CLI is older than the control: inside the same compatibility key it just works (from 1.0, an older minor needs nothing). Before 1.0 it proceeds with one warning naming `npm i -g @wpelevator/tug@<version>`. A control on a newer **major** than the CLI refuses the command with that same pin command, since the control no longer supports it.
- The CLI is a newer minor than the control inside one major: commands work unless one needs a route added in that minor, which fails with the control's 404 explained by `the control runs X, this CLI is Y … tug control upgrade <control host> --yes`.

### Rolling back

Rolling the control back below the agents' version is refused the same way: an agent newer than its control gets the control's refusal on every poll, logs it with the remedy, and keeps its containers running without reconciling until the versions agree. So roll the control back together with the agents (`tug node upgrade --all` with the older CLI, or `--to` the control's version), or upgrade the control again, rather than leaving agents ahead of it.

The control's database upgrades itself when the new control starts: it copies a database that holds data to `tug.db.pre-v<N>.bak` in the data directory, runs the pending schema steps and records the version. From 1.0 an older control refuses a database from a newer one with one `error:` line in its log that names the schema versions (Docker keeps restarting the container until you act), so a rollback across a later schema change needs the pre-upgrade state: stop the control, put the `.pre-v<N>.bak` copy back as `tug.db` (or restore a control backup taken before the upgrade) and start the older image. Schema 1 is the schema every release from 0.8 to 1.1 shares, so rolling the 1.0 control back to 0.14 opens the same database (verified, see [Real-host evaluation](design/real-host-evaluation.md#rollback-lane)). Schema 2 (the `project_domains` table of `tug domain`) arrived in the release after 1.1.0: once that control has opened a database, 1.1.0 and older refuse it, and rolling back means restoring the `tug.db.pre-v2.bak` copy or an earlier control backup, which discards every deployment and mapped domain made since the upgrade. A minor release that changes the schema says so in its changelog.

### The upgrade command

 `tug control upgrade [<ssh-target>] [--to <version>]` is the one step for a new release: it reads the running container (published mTLS addresses and ports, advertised URL, extra names), tags the image it replaces as `tug:rollback`, starts the new image on the same `tug-control` volume, checks that the CA on the volume did not change and waits for control to answer with its version. The SSH target is `controlSsh` in `tug.yml` when omitted. Upgrade and rollback preserve every supported IPv4 and IPv6 binding for the mTLS port. Installations with extra published container ports must be upgraded manually. Rollback redeploys `tug:rollback`; across a schema change the older control refuses the migrated database, as described above. `tug upgrade` runs it and then `tug node upgrade --all` in the order below.

Confirm the upgrade with `tug doctor` and `tug ps` right after, then match the agents with `tug node upgrade --all` (see [Upgrading an agent](nodes.md#image)); see the [mismatch runbook](troubleshooting.md#cli-control-version-or-credentialca-mismatches) when `tug doctor` reports a CA fingerprint mismatch.

