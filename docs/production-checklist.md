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
- **HTTPS is on.** Enable [ingress](ingress.md#set-up-ingress), point DNS at the VPS and keep ports 80 and 443 reachable so certificates issue and renew.
- **Every service has a health check.** [Health checks](healthchecks.md) decide when a deployment counts as serving and when `rollback: auto` fires. Use `rollout: { strategy: rolling }` where a restart must not interrupt traffic, and know that [rolling rollouts](compose.md#rolling-rollouts) need ingress, a tug health check and one published port.
- **State is pinned.** Pin each database and its volume to a node with `x-tug.placement`, as in [Service placement](placement.md#keep-state-on-its-server). tug does not copy a volume to another node.
- **Secrets are in tug, not in git.** Keep private values with `tug secret set`, visible ones with `tug var set`, and review the result with `tug deploy --dry-run`. See [Where values come from](compose.md#where-values-come-from).
- **CI has the least role it needs.** Create a `deploy` credential limited to its projects (`tug credential create ci --role deploy --project site`). A `deploy` credential can still read secret values with `exec` or through deployed code. See [Access control](access-control.md).

## After launch

- Look at `tug status`, `tug events` and `tug backup list --check` on a schedule. No backup notification is pushed automatically.
- Watch expiry. Operator credentials last at most 365 days, and `tug doctor` warns before the CA, the server certificate and node certificates expire. Agents renew node certificates themselves.
- Upgrade control and nodes together with [`tug upgrade`](upgrades.md), and run `tug doctor` afterwards.
- Know the limits. `tug rollback` cannot undo database writes or schema changes, and it does not roll back the host. One control plane is one point of failure for operations, though running containers keep serving while it is down. See [Not for you if](https://github.com/wpelevator/tug/blob/main/README.md#not-for-you-if).

## Next steps

When something fails, start with [Troubleshooting](troubleshooting.md).
