# Troubleshooting

Run these commands from your project directory. Tug looks for `tug.yml` only in the current directory and defaults to the `site` project unless you select another with a flag, environment variable or config. Secrets, deployment, backup and restore operations use that resolved project; `tug status` and node operations are control-wide. See [configuration precedence](cli.md#arguments-options-and-configuration).

```sh
tug status
tug events
tug doctor --nodes
```

Status reports the last observation from each node, which may be stale; it is not a live probe. `doctor --nodes` waits for host diagnostics from connected agents. The commands and JSON options are in the [CLI reference](cli.md).

## Deploy fails or a service is unhealthy

Read the error from `tug deploy`, then check `tug status`, `tug events` and `tug logs <service>`. If there is more than one eligible node, use `tug logs <service> --node <name>`. Check image availability, environment variables, secret names, container startup logs and health-check port and path. Check that the service can reach its dependencies and that the probe allows enough startup time. See [Health checks](healthchecks.md).

A project with multiple registered nodes needs placement for every service. A stateful service moved to another node may require an explicit `--move` acknowledgement and a restore; do not release held writers until you understand whether the new volume contains the correct data. See [Service placement](service-placement.md) and [Move the database](migration.md#move-the-database).

## The service is running but the site is unreachable

Check that DNS points to the ingress VPS, ingress is enabled on the node, ports 80 and 443 are reachable for automatic HTTPS, and `x-tug.ingress` names a published service port. Run `tug doctor --nodes` and inspect ingress warnings in `tug status`. For a directly published port, check the actual node address, host binding and provider firewall. Tug may bind an unqualified published port to a private address or loopback. A public binding or node address can expose the service, depending on your firewall. See [Ingress](networking.md#layer-b-ingress-and-tls) and [published ports](networking.md#published-ports-private-by-default).

## A node is stale or cannot reach a service

Check `tug node list`, the node's last contact in `tug status`, and control reachability from the node. Agent-to-control mTLS is separate from application traffic: a node behind NAT can report to control while workload traffic between nodes still fails. Verify the private node addresses, routes, firewall rules and the target's published host port. Cross-node names are not load-balanced DNS and changes can recreate client containers. See [Networking](networking.md#layer-a-cross-node-service-names) and [node certificate recovery](nodes.md#certificates-renewal-and-recovery).

## A backup failed or a restore was interrupted

Run `tug backup list --check` and `tug events`, and verify the project's destination, target placement, storage credentials and repository password. Confirm the service backup command works inside its running container and that its output includes any configured verification text. Inspect `tug restore run <target>` without `--confirm` before changing data. An interrupted restore can leave writers stopped and the project locked: inspect `tug restore list`, correct the problem and use `tug restore resume <id>`. `tug restore release <id>` releases writers even if data is incomplete. See [Backups and recovery](backups.md#restore).

## Control is unreachable or lost

Verify the configured control URL, network path, TCP 8443 and the operator credential with `tug doctor`. If control has been re-addressed, see [Moving the control plane](control-plane.md#moving-the-control-plane). If the host is lost, recover the off-host control archive before restoring workload data; see [Recover control on another host](control-plane.md#recover-control-on-another-host). If a credential or node identity is compromised, see [Lost or compromised something](control-plane.md#lost-or-compromised-something).
