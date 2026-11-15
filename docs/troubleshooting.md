# Troubleshooting

Start with three commands, from the directory that holds your `tug.yml`.

```sh
tug status
tug events
tug doctor --nodes
```

`status` shows the last report from each node, which can be stale, so it is not a live probe. `events` shows who did what and what failed, newest first. `doctor --nodes` runs host diagnostics through every connected agent and waits for the result. Tug reads `tug.yml` only from the current directory and defaults to the `site` project unless you pass `--project`, set `TUG_PROJECT` or configure one, see [configuration precedence](cli.md#arguments-options-and-configuration).

## Find the message

| You see | What it means | Do |
| --- | --- | --- |
| `<service>: x-tug.<key> is not supported (supported: ...)` from `tug lint` or `tug deploy` | A misspelled or misplaced `x-tug` key. `rollback: auto` goes at the top level of `x-tug`, not under a service | Fix the key. See [Compose extensions](compose.md#supported-keys) |
| `no nodes match placement labels` | No node carries every label the service lists, or the matching nodes are stale | `tug node list`, then add the label with `tug node add --label` or fix `placement.labels` |
| `<service>: placement node <name> is not an enabled node` | The Compose file names a node that is missing or disabled | `tug node list`. Re-enable with `tug node replace <name>` or fix `placement.nodes` |
| `cannot resolve image <image>; check registry availability and project TUG_REGISTRY_AUTH credentials` | Control could not read the image's manifest | Check the tag exists. For a private registry, set `TUG_REGISTRY_AUTH`, see [private registries](control-plane.md#published-images-and-private-registries) |
| `<service> would start empty on a different node: its data does not move` | You moved a stateful service | Back it up, then deploy with `--move <service>` and restore. See [Move the database](migration.md#move-the-database) |
| `variable <NAME> is no longer set in project <project>; set it with tug var set and deploy again` | A rollback or deploy needs a variable that was removed | `tug var set <NAME> --value ...`, then deploy again |
| `custom TLS secret <name> not found in project <project>; set it with tug secret set first` | `tls: custom` names a secret that does not exist | `tug secret set <name> --from-file ...` |
| `timed out waiting for deployment <id>; it is still rolling out` | The wait ended, and the rollout continues on the nodes | `tug status`, or stop it with `tug deploy cancel <id>` |
| `<image> is not published yet` from `tug setup` or `tug node add` | A release publishes the npm package a few minutes before its image | Retry shortly, or pass `--image ghcr.io/wpelevator/tug:latest` |
| `operation requires --node because placement is ambiguous` | The service runs on several nodes | Add `--node <name>` |
| `The control did not present a certificate signed by this credential's CA` | The credential file and the deployed control disagree about the CA | [Mismatches](#cli-control-version-or-credentialca-mismatches) |
| A message naming `tug control upgrade` or `npm i -g @wpelevator/tug@<version>` | CLI and control run different versions | [Mismatches](#cli-control-version-or-credentialca-mismatches) |

## Deploy fails or a service is unhealthy

```sh
tug status
tug events
tug logs web
```

Read the error `tug deploy` printed first. Then work down this list:

1. `tug logs <service>` shows why the container died or never became healthy. With several eligible nodes, add `--node <name>`.
2. A health check that never passes usually has the wrong `port` or `path`, or too few `retries` for a slow start. The defaults are 10 attempts, 2 seconds apart. Raise `x-tug.health.retries` or `interval`, see [Health checks](healthchecks.md).
3. A missing variable or secret fails the deploy with the names and the command that sets them. `tug deploy --dry-run` lists every `${NAME}` and where its value comes from.
4. A service that cannot reach its dependency usually needs a `depends_on` with `condition: service_healthy`, or connection retries in the app.

**A deploy, rollback or control backup that sits queued** is waiting behind another build. Control runs one writer at a time, and a stuck build is killed after 30 minutes. `tug status` shows the deployment still building. `tug deploy cancel` marks it cancelled, but the build process itself ends only at that deadline, so a rollback can wait that long in the worst case.

**Several nodes registered:** every service needs placement. Moving a stateful service needs `--move` and a restore. Do not release held writers until you know the new volume holds the right data. See [Placement](placement.md) and [Move the database](migration.md#move-the-database).

## The service is running but the site is unreachable

```sh
tug doctor --nodes
tug node list
tug status
```

Check these in order:

1. **DNS** points at the ingress node's public IP.
2. **Ingress** is enabled: `tug node ingress <node>`. `tug doctor` flags an ingress node that is not `serving`, and `tug status` shows ingress warnings.
3. **Ports 80 and 443** are reachable from the internet, in the host firewall and the provider firewall. Without them automatic HTTPS cannot issue a certificate.
4. **`x-tug.ingress.port`** is a published port of the service.
5. **A direct port** such as `8080` binds to the node's private address or loopback unless you wrote a host IP. Check the node address and the firewall. See [Ingress](ingress.md#set-up-ingress) and [published ports](networking.md#published-ports-private-by-default).

## A node is stale or cannot reach a service

```sh
tug node list
tug status
tug doctor --node app2
```

A node is `stale` after 60 seconds (`TUG_STALE_SECONDS`) without contacting control. That does not prove the machine is off.

- **From the node to control:** confirm it can open a connection to control on TCP 8443.
- **Between nodes:** agent-to-control mTLS is separate from application traffic. A node behind NAT can report to control while traffic between nodes still fails. Check the private node addresses, routes, firewall rules and the target's published host port.
- **Certificates:** if the node's certificate expired or its key is lost, see [Certificates](nodes.md#certificates-renewal-and-recovery).
- **Names:** cross-node names are not load-balanced DNS, and a change can recreate client containers. See [Networking](networking.md#cross-node-service-names).

## A backup failed or a restore was interrupted

```sh
tug backup list --check
tug events
tug restore list
```

For a failed backup, check the destination (`tug backup destination show`), the storage credentials, the target's placement and the repository password (`tug backup password`). Confirm the backup command works inside the running container and prints the `verify` text.

For an interrupted restore, the writers stay stopped and the project stays locked on purpose. Fix the cause, then run `tug restore resume <id>`. `tug restore release <id>` starts the writers anyway, even if the data is incomplete. Preview with `tug restore run <target>` (no `--confirm`) before you change data. See [Restore](backups.md#restore).

## Control is unreachable or lost

```sh
tug doctor
```

`doctor` checks the control URL, the network path to TCP 8443 and your operator credential. Then:

- **Re-addressed control:** [Moving the control plane](control-plane.md#moving-the-control-plane).
- **Lost host:** recover the off-host control archive before restoring workload data, see [Recover control on another host](control-plane.md#recover-control-on-another-host).
- **Compromised credential or node:** [Lost or compromised something](control-plane.md#lost-or-compromised-something).

## CLI, control version or credential/CA mismatches

`exec`, `run`, `logs` and `ps` first list services through control, so a version or credential problem hits them first while `tug status` and `tug doctor` keep working. Work through the steps and stop at the first match.

1. **Run `tug doctor`.** It compares the credential's CA with the server certificate control presents and prints both fingerprints under `control_server_cert`. If that check fails, go to step 3.
2. **Read the version message.** The refusal names the fix:

| You see | It means | Do |
| --- | --- | --- |
| `tug control upgrade <control host> --yes` | Control is older than this CLI (control may say this itself when the CLI declares a newer version) | Upgrade control with that command |
| A warning naming `npm i -g @wpelevator/tug@<version>` | The CLI is older than control | Pin or upgrade the CLI |
| No version stamp in control's responses | An older control | Upgrade it with the same command |

   After any control upgrade, run `tug doctor` right away. An upgrade must preserve `/data/pki`, and `control upgrade` compares the CA before and after and fails if it changed. See [Upgrade control and nodes](upgrades.md).

3. **"The control did not present a certificate signed by this credential's CA".** The credential file and the deployed control disagree, so establish which side is canonical. Control's PKI lives at `/data/pki` inside its container (the `tug-control` volume), not on the host. `tug init` names credential files by CA fingerprint and never overwrites a file cast for another CA, so the previously working credential remains under `~/.config/tug/credentials/`. Flipping back to it is the least destructive fix: point `tug.local.yml` at it, or re-run `tug init <file>`. Never regenerate one side to "fix" the other before checking which CA control holds. On the control host, run `docker exec tug-control-control-1 cat /data/pki/ca.crt`.
4. **Verify after any control redeploy.** `tug status` should still list every project. Run `tug ps` and `tug exec <service> -- sh -c 'echo ok'` as an end-to-end check. `tug control upgrade` tags the previous control image `tug:rollback` itself, so `tug control upgrade --rollback` stays available.
