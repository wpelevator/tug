# Production checklist

Check these before a site that matters runs on tug. Each item links to the page that explains it.

```sh
tug doctor --nodes
tug status
tug backup list --check
```

`doctor --nodes` waits for host diagnostics from connected agents and reports certificate expiry, node connectivity and clock skew. `status` shows the last observation from each node, which can be stale. `backup list --check` shows whether each target succeeded.

## Before launch

- **Recovery works.** Set a [backup destination](backups.md#set-up-your-first-backup), mark every database and volume with `x-tug.backup`, and run a [restore drill](backups.md#restore-drill) into a scratch target. tug backs up each target separately and workload backups do not include control state.
- **Control survives its host.** Control backs itself up to the same destination every night. Keep a copy off the server with `tug control backup -o <file>`, and keep the control password (`tug backup password --control`) somewhere you can reach if the server is lost. See [Recover control on another host](control-plane.md#recover-control-on-another-host).
- **Only intended ports are public.** tug binds an unqualified published port to the node address or loopback, and a public node address can still make it public. Check [published ports](networking.md#published-ports-private-by-default) and the provider firewall. Control listens on TCP 8443 with mutual TLS and must not sit behind a TLS-terminating proxy.
- **HTTPS is on.** Enable [ingress](ingress.md#set-up-ingress), point DNS at the VPS and keep ports 80 and 443 reachable so certificates issue and renew. Open them in the host firewall before the first deploy, because a failed validation burst delays the next attempt by up to an hour, see [the site is unreachable](troubleshooting.md#the-service-is-running-but-the-site-is-unreachable).
- **Every service has a health check.** [Health checks](healthchecks.md) decide when a deployment counts as serving and when `rollback: auto` fires. Use `rollout: { strategy: rolling }` where a restart must not interrupt traffic, and know that [rolling rollouts](compose.md#rolling-rollouts) need ingress, a tug health check and one published port.
- **State is pinned.** Pin each database and its volume to a node with `x-tug.placement`, as in [Service placement](placement.md#keep-state-on-its-server). tug does not copy a volume to another node.
- **Secrets are in tug, not in git.** Keep private values with `tug secret set`, visible ones with `tug var set`, and review the result with `tug deploy --dry-run`. See [Where values come from](compose.md#where-values-come-from).
- **CI has the least role it needs.** Create a `deploy` credential limited to its projects (`tug credential create ci --role deploy --project site`). A `deploy` credential can still read secret values with `exec` or through deployed code. See [Access control](access-control.md).

## After launch

- Schedule `tug status`, `tug events` and `tug backup list --check`; route nonzero backup-check exits to an operator. Configure [signed notifications](observability.md#alerting) and monitor delivery failures; delivery is best effort, so retain the scheduled backup check.
- Treat workload health and user impact as separate checks. `tug status` reports the last node observation and service health; verify the public ingress URL from outside the node when customer reachability matters. A healthy container does not prove DNS, TLS, ingress routing or an upstream dependency works.
- Keep an operator path to the control host, node access, backup destination credentials and repository passwords. Use the matrix below to decide what to check and what evidence closes an incident.
- Watch expiry. Operator credentials last at most 365 days, and `tug doctor` warns before the CA, the server certificate and node certificates expire. Agents renew node certificates themselves.
- Upgrade control and nodes together with [`tug upgrade`](upgrades.md), and run `tug doctor` afterwards.
- Know the limits. `tug rollback` cannot undo database writes or schema changes, and it does not roll back the host. One control plane is one point of failure for operations, though running containers keep serving while it is down. See [Not for you if](https://github.com/wpelevator/tug/blob/main/README.md#not-for-you-if).

## Failure response and recovery evidence

| Failure | Expected impact and responsibility | Operator action | Evidence to close the incident |
|---|---|---|---|
| Control host or process is unavailable | Existing containers can keep serving, but tug operations, new deployment work, agent coordination and control-hosted recovery material are unavailable. Restore the control host and its state; tug does not provide a second control plane. | Check the host and disk, restore control from an off-host archive using [control recovery](control-plane.md#recover-control-on-another-host), then let agents reconnect. | `tug status` reaches control, expected projects and nodes appear, agents report recently, and an external request to each important ingress host succeeds. |
| Node is permanently lost | Services on that node stop. tug does not reschedule a node-pinned service or copy its local volume to another node. The operator owns host replacement and workload-data recovery. | Replace or repair the node as appropriate, restore workload data from its backup or recover the host, and follow [migrating to a new server](migration.md). | The replacement node reports online, the service and its data are restored, and an external request to the service succeeds. |
| Control-to-node network path is partitioned | The last node report may be stale; workloads already running may still serve, while reconciliation, deploys and node-local backup work cannot complete. The operator owns host and network repair. | Check `tug status`, `tug doctor --nodes`, host reachability and the provider firewall; restore the path and let the agent reconcile. | The node reports again, unchanged desired services are healthy, and an external request to affected services succeeds. |
| Node or control data disk is full | Writes, image transfers, logs or backup jobs may fail; existing workload responses can continue until their own storage is affected. tug does not free operator data or guarantee a safe cleanup. | Check free space with `tug doctor --nodes` and host tools; identify the consuming data before deleting anything. Restore capacity, then retry the failed operation or backup. | Free space is available, the failed operation completes, and `tug backup list --check` passes for protected targets. |
| Backup destination is unavailable | Running workloads are not stopped by a destination outage, but scheduled workload and control backups cannot become recoverable copies. Configured notifications report backup failures and stale protection; a dead control still needs an external monitor. | Alert on scheduled `tug backup list --check` failures; verify destination reachability and credentials, then run `tug backup run` and `tug control backup list`. | New workload snapshots pass `backup list --check`; a control archive is present off-host in `tug control backup list`. A restore drill is separate evidence that contents are usable. |

These checks define observable recovery evidence, not recovery-time or data-loss guarantees. Set such targets only after repeated exercises on representative hosts and data.

## Next steps

When something fails, start with [Troubleshooting](troubleshooting.md).
