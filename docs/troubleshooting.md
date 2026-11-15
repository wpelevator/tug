# Troubleshooting

Run these commands from your project directory. Tug looks for `tug.yml` only in the current directory and defaults to the `site` project unless you select another with a flag, environment variable or config. Secrets, deployment, backup and restore operations use that resolved project; `tug status` and node operations are control-wide. See [configuration precedence](cli.md#arguments-options-and-configuration).

```sh
tug status
tug events
tug doctor --nodes
```

Status reports the last observation from each node, which may be stale; it is not a live probe. `doctor --nodes` waits for host diagnostics from connected agents. The commands and JSON options are in the [CLI reference](cli.md).

## Find your symptom

| You see | Likely cause | Go to |
| --- | --- | --- |
| `tug deploy` fails or `tug status` shows a service unhealthy | Image, environment, secret name, startup or health-check port and path | [Deploy fails](#deploy-fails-or-a-service-is-unhealthy) |
| A deploy or rollback stays queued | Control runs one writer at a time and is busy building | [Deploy fails](#deploy-fails-or-a-service-is-unhealthy) |
| The container runs but the site does not load | DNS, ingress, ports 80 and 443, host binding or firewall | [Site unreachable](#the-service-is-running-but-the-site-is-unreachable) |
| A node shows a stale last contact | Control unreachable from the node, or private network routes | [Stale node](#a-node-is-stale-or-cannot-reach-a-service) |
| `tug backup list --check` reports a failed target | Destination, storage credentials, backup command or placement | [Backup failed](#a-backup-failed-or-a-restore-was-interrupted) |
| A restore stopped halfway and writers stay stopped | Interrupted restore holding the project lock | [Backup failed](#a-backup-failed-or-a-restore-was-interrupted) |
| `tug status` cannot connect | Wrong control URL, TCP 8443 blocked or a bad credential | [Control unreachable](#control-is-unreachable-or-lost) |
| `The control did not present a certificate signed by this credential's CA` | The credential file and the deployed control disagree about the CA | [Mismatches](#cli-control-version-or-credentialca-mismatches) |
| A message naming `tug control upgrade` or `npm i -g @wpelevator/tug@<version>` | CLI and control run different versions | [Mismatches](#cli-control-version-or-credentialca-mismatches) |
| `tug lint` prints `... is not supported` | A Compose key or `x-tug` setting Tug does not accept | [What Tug accepts](compose.md#not-supported) |

## Deploy fails or a service is unhealthy

Read the error from `tug deploy`, then check `tug status`, `tug events` and `tug logs <service>`. If there is more than one eligible node, use `tug logs <service> --node <name>`. Check image availability, environment variables, secret names, container startup logs and health-check port and path. Check that the service can reach its dependencies and that the probe allows enough startup time. See [Health checks](healthchecks.md).

A deploy, rollback or control backup that sits queued for a long time is usually waiting behind another build: control runs one writer at a time, and a stuck build is killed after 30 minutes. `tug status` shows the deployment that is still building; `tug deploy cancel` marks it cancelled, but the build process itself ends only at that deadline. Plan for a rollback to wait that long in the worst case.

A project with multiple registered nodes needs placement for every service. A stateful service moved to another node may require an explicit `--move` acknowledgement and a restore; do not release held writers until you understand whether the new volume contains the correct data. See [Service placement](service-placement.md) and [Move the database](migration.md#move-the-database).

## The service is running but the site is unreachable

Check that DNS points to the ingress VPS, ingress is enabled on the node, ports 80 and 443 are reachable for automatic HTTPS, and `x-tug.ingress` names a published service port. Run `tug doctor --nodes` and inspect ingress warnings in `tug status`. For a directly published port, check the actual node address, host binding and provider firewall. Tug may bind an unqualified published port to a private address or loopback. A public binding or node address can expose the service, depending on your firewall. See [Ingress](networking.md#layer-b-ingress-and-tls) and [published ports](networking.md#published-ports-private-by-default).

## A node is stale or cannot reach a service

Check `tug node list`, the node's last contact in `tug status`, and control reachability from the node. Agent-to-control mTLS is separate from application traffic: a node behind NAT can report to control while workload traffic between nodes still fails. Verify the private node addresses, routes, firewall rules and the target's published host port. Cross-node names are not load-balanced DNS and changes can recreate client containers. See [Networking](networking.md#layer-a-cross-node-service-names) and [node certificate recovery](nodes.md#certificates-renewal-and-recovery).

## A backup failed or a restore was interrupted

Run `tug backup list --check` and `tug events`, and verify the project's destination, target placement, storage credentials and repository password. Confirm the service backup command works inside its running container and that its output includes any configured verification text. Inspect `tug restore run <target>` without `--confirm` before changing data. An interrupted restore can leave writers stopped and the project locked: inspect `tug restore list`, correct the problem and use `tug restore resume <id>`. `tug restore release <id>` releases writers even if data is incomplete. See [Backups and recovery](backups.md#restore).

## Control is unreachable or lost

Verify the configured control URL, network path, TCP 8443 and the operator credential with `tug doctor`. If control has been re-addressed, see [Moving the control plane](control-plane.md#moving-the-control-plane). If the host is lost, recover the off-host control archive before restoring workload data; see [Recover control on another host](control-plane.md#recover-control-on-another-host). If a credential or node identity is compromised, see [Lost or compromised something](control-plane.md#lost-or-compromised-something).

## CLI, control version or credential/CA mismatches

`exec`, `run`, `logs` and `ps` first list services through control, so a version or credential problem hits them first while `tug status` and `tug doctor` keep working. Work through the steps and stop at the first match.

1. **Run `tug doctor`.** It compares the credential's CA with the server certificate control presents and prints both fingerprints under `control_server_cert`. If that check fails, go to step 3.
2. **Read the version message.** The refusal names the fix:

| You see | It means | Do |
| --- | --- | --- |
| `tug control upgrade <control host> --yes` | Control is older than this CLI (control may say this itself when the CLI declares a newer version) | Upgrade control with that command |
| A warning naming `npm i -g @wpelevator/tug@<version>` | The CLI is older than control | Pin or upgrade the CLI |
| No version stamp in control's responses | An older control | Upgrade it with the same command |

   After any control upgrade, run `tug doctor` right away. An upgrade must preserve `/data/pki`, and `control upgrade` compares the CA before and after and fails if it changed. See [Upgrade control and nodes](upgrading.md).

3. **"The control did not present a certificate signed by this credential's CA".** The credential file and the deployed control disagree, so establish which side is canonical. Control's PKI lives at `/data/pki` in its container (the `tug-control` volume), and its compose files at `/opt/tug-control`. `tug init` names credential files by CA fingerprint and never overwrites a file cast for another CA, so the previously working credential remains under `~/.config/tug/credentials/`. Flipping back to it is the least destructive fix: point `tug.local.yml` at it, or re-run `tug init <file>`. Never regenerate one side to "fix" the other before checking which CA `cat /data/pki/ca.crt` on the control host reports.
4. **Verify after any control redeploy.** `tug status` should still list every project. Run `tug ps` and `tug exec <service> -- sh -c 'echo ok'` as an end-to-end check. `tug control upgrade` tags the previous control image `tug:rollback` itself, so `tug control upgrade --rollback` stays available.
