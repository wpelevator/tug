# Private control network

Status: proposed, 22 November 2026, against `31c0a6c`. Nothing below is built except what [What works today](#what-works-today) describes, and each step in [The setup, end to end](#the-setup-end-to-end) says whether it runs today. Claims marked "verify" need a real-host run. Tailscale details come from its documentation and general knowledge on that date.

Can control's mutual TLS port be kept off the public internet by putting control, nodes, operators and CI on a tailnet (Tailscale, Headscale, NetBird or a plain WireGuard network)? Yes. Most of it works with today's flags, because clients verify control by a name derived from its CA instead of the address they dial. This record proposes the pieces that close the rest: publishing the control port on chosen addresses only, taking a node's address from its tailnet interface, ordering Docker after the tailnet daemon, a cloud-init preset that joins new nodes to the tailnet, a `tug doctor` check and an operator guide.

The split is deliberate. **tug** handles everything that touches its own containers, addresses and credentials, and for enrolled hosts it runs the tailnet install as part of the bootstrap it already generates. **The operator** owns the tailnet: the account or coordination server, access rules, auth keys, joining hosts tug does not provision, and repairing the tailnet when it fails. tug never stores tailnet secrets in control and never depends on a tailnet being present: the cancelled tug-owned mesh ([M12 in the roadmap](roadmap.md#m12--container-networking-over-the-mesh-cancelled)) showed the cost of owning a tunnel, and to tug a tailnet is one more routed private network.

## Why

Control is the one host every credential trusts. Its port accepts only clients with a certificate from control's CA, rejects anything else during the TLS handshake and has no unauthenticated route ([Authentication and PKI](control-plane.md#authentication-and-pki)). Exposing it still has costs that mutual TLS does not remove:

| Exposure | Effect |
| --- | --- |
| Scanning and handshake load | Anyone can open TCP connections and start TLS handshakes, so a TLS or Node.js bug reachable before certificate validation is reachable from the internet |
| A leaked credential works from anywhere | A stolen CI or operator credential can be used from any network until it is revoked |
| Operator firewalling is manual | `control setup` publishes the port on every interface, and Docker's iptables rules bypass host firewalls such as ufw, so the only boundary is a provider firewall the operator must remember |

A private network makes a leaked credential useless without network access as well, and takes the pre-authentication surface off the internet. It is defense in depth: mutual TLS stays mandatory on every connection.

## The target setup

| Who | Joins the tailnet | Reaches | Stays public |
| --- | --- | --- | --- |
| Control host | Yes | Nothing new. Agents and clients dial it | Nothing. Port 8443 is bound to the tailnet address and loopback |
| Nodes | Yes | Control's tailnet address. Other nodes' tailnet addresses for cross-node services | Ingress nodes keep 80 and 443 |
| Operator machines | Yes | Control's tailnet address, and hosts over SSH | Not applicable |
| CI runners | Yes, per job | Control's tailnet address only | Not applicable |
| Visitors | No | Ingress nodes on 80 and 443 | Not applicable |

Workload traffic between nodes rides the tailnet too once node addresses are tailnet IPs, which gives the node-to-node encryption that [Networking](networking.md#bring-your-own-network) says tug does not provide itself.

## Who does what

| Concern | tug does | The operator does |
| --- | --- | --- |
| The tailnet itself | Nothing. tug works the same on any routed private network | Runs the tailnet account or a Headscale server, and keeps it up |
| Access rules | The guide ships a reference policy: a tag for nodes, a tag for CI, and which ports each may reach | Writes and maintains the policy in the tailnet admin |
| Auth keys | The enrollment preset copies a key file into the generated user-data as a `0600` file and removes it after joining. Control never sees or stores it | Creates tagged, pre-authorized, single-use or short-lived keys, and treats saved user-data as a secret, as it already must for the join key |
| Joining hosts | `node enroll --tailnet tailscale` installs the client and joins before Docker starts | Joins the control host, SSH-installed nodes, operator machines and CI runners |
| Control port exposure | `control setup --bind` publishes only on the given addresses, and `tug doctor` reports a port bound to every interface | Closes 8443 at the provider firewall for installs made before `--bind`, or rebinds them |
| Boot order | `--docker-after <unit>` installs a systemd drop-in so Docker starts after the tailnet daemon | Adds the drop-in by hand on hosts set up without the flag |
| Node addresses | Records each node's address, taken from a named interface at enrollment, and binds published ports to it | Runs `tug node address` if a host is re-registered with the tailnet and gets a new IP |
| Agent to control | Mutual TLS, retries and address-independent verification, as today | Makes sure nodes route to control's tailnet address. Kernel-mode Tailscale does, userspace mode does not |
| CI | Scoped deploy credentials, as today | Adds the tailnet step to the workflow, pins it by commit SHA and scopes its tag in the access rules |
| Ingress | Caddy and ACME on public 80 and 443, as today | Public DNS, and keeps 80 and 443 open on ingress nodes |
| Tailnet outages | Agents keep retrying, running containers keep serving, and `tug status` shows nodes going stale | Notices and repairs the tailnet. tug cannot fix a network it does not own |
| Break-glass access | Accepts any connect target, so an SSH tunnel to a loopback binding works with `--control-url` | Keeps SSH access that does not depend on the tailnet, such as the provider console or key-only public SSH |

## The setup, end to end

Each step says whether it runs today or depends on this proposal.

| Step | Who | Today |
| --- | --- | --- |
| 1. Prepare the tailnet | Operator | Yes, outside tug |
| 2. Install control on the tailnet | Operator joins, tug installs | Partly. `--bind` and `--docker-after` are proposed |
| 3. Join the operator machine | Operator | Yes, outside tug |
| 4a. Add nodes over SSH | Operator joins, tug installs | Yes, with the tailnet IP typed by hand. `--docker-after` is proposed |
| 4b. Add nodes with cloud-init | tug does both | No. The preset and `--address-interface` are proposed |
| 5. Deploy from CI | Operator | Yes |
| 6. Close the public port | tug and operator | Partly. The doctor check is proposed |
| 7. Move an existing install | Operator, with tug commands | Yes, except rebinding without rerunning setup |

**1. Prepare the tailnet (operator).** Create two tags, for example `tag:tug-node` and `tag:tug-ci`. Allow operator devices, `tag:tug-node` and `tag:tug-ci` to reach the control host on TCP 8443. Allow `tag:tug-node` to reach other nodes on the published ports your services use, and ingress nodes to reach their upstreams. Create a reusable or single-use auth key tagged `tag:tug-node` for enrollment, and an ephemeral key tagged `tag:tug-ci` for CI. Ephemeral devices are removed when they go offline, so use them only for CI, never for servers.

**2. Install control on the tailnet.** Join the control host to the tailnet yourself, then:

```sh
tug control setup root@control.example.com --bind 100.64.0.10 --bind 127.0.0.1 --docker-after tailscaled.service --control-url https://control.tail1234.ts.net:8443
```

`--bind 127.0.0.1` keeps a loopback binding for break-glass access over an SSH tunnel. `--control-url` is written into every credential, and any address works there because clients verify the CA-derived name. SSH itself may go over the public address or the tailnet.

**3. Join the operator machine (operator).** The CLI dials `--control-url`, so the machine running `tug` must be on the tailnet.

**4a. Add nodes over SSH.** Join the host to the tailnet yourself, then:

```sh
tug node add root@app1.example.com --name app1 --address 100.101.102.103 --agent-control-url https://control.tail1234.ts.net:8443 --docker-after tailscaled.service
```

The address picker already lists the tailnet IP as private, so in a terminal you can pick it instead of typing it.

**4b. Add nodes with cloud-init.** Save the output as the instance's user-data:

```sh
tug node enroll --name app2 --install-docker --tailnet tailscale --tailnet-auth-key-file ./tug-node.key --agent-control-url https://control.tail1234.ts.net:8443
```

The generated cloud-init installs Tailscale, joins with the key, installs the Docker ordering drop-in, installs Docker and starts the agent with its address taken from `tailscale0`. Add `--tailnet-login-server https://headscale.example.com` for Headscale. For another tailnet, use the generic pieces in [Enrollment](#4-enrollment-joins-the-tailnet-before-docker).

**5. Deploy from CI (operator).** Add a tailnet step before `tug deploy`, with the `tag:tug-ci` key as a repository secret. The deploy itself is unchanged ([Deploying from GitHub Actions](access-control.md#deploying-from-github-actions)).

```yaml
- uses: tailscale/github-action@<commit-sha>
  with:
    authkey: ${{ secrets.TAILSCALE_AUTHKEY }}
- run: npx --yes @wpelevator/tug@<version> deploy
  env:
    TUG_CREDENTIAL: ${{ secrets.TUG_CREDENTIAL }}
```

The action's inputs, including whether it takes an auth key or OAuth client and how tags are passed, must be checked against its current README (verify).

**6. Close the public port.** With `--bind`, Docker no longer publishes 8443 on the public interface. Keep a provider firewall rule denying it anyway, because a later `control setup` run without `--bind` reopens it. `tug doctor` reports any control binding on every interface.

**7. Move an existing install.** Join every host to the tailnet first, so nothing loses control while you switch. Then point the CLI at the new address with `--control-url` or the config file's `controlUrl`, and repoint agents with `tug node upgrade --force --all --agent-control-url https://control.tail1234.ts.net:8443`. Without `--force`, a node already on the target image is skipped and keeps its old URL. Change node addresses with `tug node address <node> <tailnet-ip>`, which moves published-port bindings and cross-node names to the new address. No credential is invalidated. Finally rebind control by rerunning `control setup` with `--bind` and every other original flag (`--port`, `--extra-san`, `--control-url`), and close the public port.

## What works today

| Piece | How |
| --- | --- |
| Clients reach control at a tailnet address | `tug control setup <ssh-target> --control-url https://control.tail1234.ts.net:8443` writes that URL into every credential. Any address works, because the CLI and agent verify the derived `control-<hash>.tug` name, not the URL host |
| Agents dial control over the tailnet | `--agent-control-url https://100.64.0.10:8443` on `node add`, `replace`, `repair`, `migrate`, `upgrade` and `enroll`. Agents only dial out, so nodes need no inbound port |
| Workload traffic over the tailnet | `tug node add --address 100.101.102.103`, or `tug node address <node> <ip>`. The address picker lists `100.64.0.0/10` as private, since it is the carrier-grade NAT range tailnets use |
| Re-pointing existing agents | `tug node upgrade --force --all --agent-control-url <url>`. No credential is invalidated |
| Keeping a narrow binding | `tug control upgrade` replays the existing published bindings including their host IPs ([SEC-16](security-audit.md)), so a hand-made binding survives upgrades |
| Break-glass through SSH | `tug --control-url https://127.0.0.1:18443 ...` through `ssh -L 18443:127.0.0.1:8443 root@control.example.com`, because the connect target never affects verification |

Agents share the host's network namespace (`--network host`), so with Tailscale in its default kernel mode they reach `100.x` addresses through `tailscale0` like any host process. Tailscale in userspace-networking mode creates no `tailscale0` interface and offers only a SOCKS or HTTP proxy, which the agent does not use, so agents need kernel mode (verify). Control itself runs on Docker's default bridge and only accepts connections, so it needs nothing beyond the published port.

## The gaps

| Gap | Detail |
| --- | --- |
| Setup always publishes on every interface | `control setup` builds its binding as `{ port }` with no host IP, so Docker publishes `0.0.0.0:8443` and `[::]:8443`. The binding type already carries a `hostIp`, and upgrade keeps one, but nothing sets it |
| Docker can start before the tailnet | A container published on a tailnet address fails to start if Docker comes up before `tailscale0` exists. This hits control with `--bind`, and every node whose address is a tailnet IP, since published workload ports bind to the node address |
| Enrollment needs the address up front | `node enroll --address` bakes `TUG_NODE_ADDRESS` into the snippet, but a tailnet IP exists only after the host joins |
| Enrolled hosts cannot join a tailnet first | The generated cloud-init runs the Docker bootstrap and the agent, with no stage before Docker for the operator's network |
| Nothing reports a public control port | `tug doctor` reports workload containers listening on all interfaces (`ports.public`) but says nothing about control's own port |
| No operator guide | The flags above are documented one by one, and nothing shows the full setup, the CI step or the boot-order caveat |

## Proposal

### 1. `control setup --bind <ip>`

Publish the control port on one host address instead of every interface. Repeatable, like `--extra-san`, so a host can bind its tailnet address and loopback.

| Rule | Behavior |
| --- | --- |
| Values | IPv4 or IPv6 literals. A hostname is refused, because Docker binds addresses, not names |
| Preflight | Over SSH, setup checks that each address is on one of the host's interfaces and fails before touching the container when one is not |
| Default URL | When `--bind` is given without `--control-url`, setup still advertises the SSH target's host, and warns when that host is not one of the bound addresses, since clients would then dial an address nothing listens on. Setup's own readiness check and credential import connect too, so they fail until the operator's machine can reach a bound address. In practice `--bind` needs `--control-url` |
| Running setup again | Like `--port`, a missing `--bind` resets to all interfaces. The note about changed settings compares only the port today, so it must compare host IPs too, and name a rerun that would reopen the port on every interface before it happens |
| Upgrade | `control upgrade` already replays bindings with their host IPs. Adding `--bind` to it would let an existing control narrow its binding without repeating every setup flag, and is a candidate for the same change |

The same flag gives [M15](roadmap.md#m15--flexible-node-roles) its break-glass port bound to loopback or a private address.

### 2. `--docker-after <unit>` for boot order

Docker cannot publish on an address that is not yet assigned, so if Docker starts before the tailnet daemon brings up its interface, containers bound to that address fail with a "cannot assign requested address" error. Whether the `unless-stopped` restart policy retries that failure on daemon start needs checking on a real host (verify).

`--docker-after <unit>` on `control setup`, `node add` and `node enroll` writes `/etc/systemd/system/docker.service.d/tug-after.conf` with `After=<unit>` and `Wants=<unit>`, and reloads systemd. The `--tailnet tailscale` preset implies `--docker-after tailscaled.service`. It couples Docker's start to the tailnet daemon, so a tailnet daemon that fails at boot delays every container on the host. That is the intended trade: a container bound to an absent address cannot serve anyway. The agent itself needs no ordering, because it binds nothing and retries its connection to control.

`After=` orders against the daemon's start, not the interface being up. Whether `tailscaled.service` reports started only once `tailscale0` has its address needs checking (verify). If not, the drop-in needs an `ExecStartPre=` that waits for the address, with a timeout.

For control there is a second option: bind loopback only and forward from the tailnet with `tailscale serve --tcp 8443 tcp://127.0.0.1:8443`. Loopback always exists, so boot order stops mattering, and TCP passthrough keeps mutual TLS intact. The cost is that control no longer sees the client's tailnet address (connections arrive from Docker's proxy or bridge gateway, verify which), the forward is a second persistent component, and it is Tailscale-specific (verify the flag syntax and persistence). Document it as an alternative, and lead with `--docker-after` unless the real-host run shows it is unreliable.

### 3. A node address from an interface

`--address-interface <name>` on `node enroll` sets `TUG_NODE_ADDRESS_INTERFACE` on the agent instead of `TUG_NODE_ADDRESS`. At first enrollment the agent reads that interface's first global IPv4 address, waiting up to a timeout for it to appear, and reports it as the node's address. It fails with a message naming the interface when none appears.

| Rule | Behavior |
| --- | --- |
| When it resolves | Once, at enrollment. Control stores the address, as it does for `TUG_NODE_ADDRESS` |
| Later changes | A host re-registered with the tailnet gets a new IP, and the operator runs `tug node address`, as for any address change. Following the interface continuously is not proposed: an address change moves published ports and what peers resolve, and tug should not do that on its own |
| `node add` | Not needed. Over SSH the picker already lists the host's addresses, including the tailnet IP |
| Vendors | Any interface name works: `tailscale0`, `wg0`, a NetBird interface or a VLAN |

### 4. Enrollment joins the tailnet before Docker

The generated cloud-init gains an optional stage that runs before the Docker bootstrap, with the same retries and `tug-bootstrap:` progress lines the Docker stage prints.

| Flag | Effect |
| --- | --- |
| `--pre-script <file>` | Generic. Writes the file into user-data and runs it before the Docker bootstrap. Its failure stops the bootstrap, so the agent never starts half-configured |
| `--tailnet tailscale` | Preset. Installs Tailscale from its apt or dnf repository on the families the Docker bootstrap supports, joins, and implies `--address-interface tailscale0` and `--docker-after tailscaled.service` |
| `--tailnet-auth-key-file <file>` | Required with the preset. The key is written to a `0600` file, passed to `tailscale up` and deleted after joining (verify the `file:` form `tailscale up` accepts) |
| `--tailnet-login-server <url>` | Optional. Points the client at a Headscale or other compatible coordination server |

The node's tag comes from the auth key, so tug needs no tag flag and the operator's access rules stay the single source of truth. Tagged devices have key expiry disabled by default, which suits servers (verify). Like the join key, the auth key is readable by anything that can read the user-data, including the provider's metadata service on some clouds, so prefer single-use or short-lived keys. Other tailnets use `--pre-script` with `--address-interface` and `--docker-after`. tug does not add presets for them until operators ask.

### 5. A doctor check for the control port

Control can inspect its own container through the Docker socket it already mounts, sharing the binding parser `control upgrade` uses (`parseControlInspect`). Report its published bindings in control's diagnostics, and have `tug doctor` flag a binding with no host IP or a non-private one. Private means `isPrivateIPv4` for IPv4, and `fc00::/7` (which holds Tailscale's `fd7a:115c:a1e0::/48`), `fe80::/10` and `::1` for IPv6. The check reports configuration, not reachability, and says so: a provider firewall may already close the port, and tug cannot see that from inside.

Every install made before `--bind` exists binds all interfaces, and many sit behind a provider firewall, so a warning would be permanent noise for them. Print it as `info` with a pointer to `--bind`, and keep `warn` for a control port bound explicitly to a public address.

### 6. An operator guide

A guide, "Keep control on a private network", with the [setup end to end](#the-setup-end-to-end) and the [who does what](#who-does-what) table as its core, linked from [Control plane](control-plane.md), [Nodes](nodes.md#self-service-enrollment-node-enroll), [Networking](networking.md#bring-your-own-network) and the [production checklist](production-checklist.md). It ships the reference access policy for Tailscale, a Headscale note, the break-glass procedure and a troubleshooting table: an agent that cannot reach control (userspace mode, missing access rule), a container that fails to bind after reboot (boot order), and a node whose address changed after re-registration.

## Failure modes the operator owns

| Failure | What tug shows | What keeps working | Fix |
| --- | --- | --- | --- |
| Tailnet daemon down on a node | The node goes stale in `tug status` | Running containers keep serving their public ports. Cross-node traffic to and from it stops | Restart the daemon. The agent reconnects by itself |
| Tailnet daemon down on control | Every node goes stale, and the CLI cannot connect | Running containers everywhere. No deploys, rollbacks or backups run | Restart the daemon, or use the break-glass SSH tunnel |
| Coordination server unreachable | Nothing, at first | Existing tailnet connections, as far as the vendor's design allows (verify for Tailscale and Headscale) | Restore the coordination server. New devices, including new enrollments, cannot join until then |
| Access rule removed | The same symptoms as the daemon being down, for the affected peers | As above | Restore the rule. tug cannot see tailnet policy |
| Auth key expired or used up | Enrollment never completes, and the cloud-init log shows the tailnet stage failing | Existing nodes | Mint a new key and a new join key |
| Host re-registered with a new IP | Cross-node clients and ingress upstreams fail to reach the node | The node's own public ports | `tug node address <node> <new-ip>` |

## Not proposed

| Idea | Why not |
| --- | --- |
| tug joins the tailnet itself | There is no embedded Tailscale library for Node.js (`tsnet` is Go only), and running `tailscaled` inside control or the agent means owning auth keys, state and upgrades for a third-party daemon. It would also tie tug to one vendor where today any routed network works |
| Tailnet setup over SSH in `control setup` and `node add` | The operator is already on the host and joins it in one command. The enrollment preset exists because nobody is on an enrolled host to do it |
| Storing tailnet auth keys in control | Control would hold a credential that admits devices to the operator's network, for no gain over the operator's own secret store |
| A Tailscale sidecar container sharing control's network namespace | Removes the host port entirely, but adds a second container that setup, upgrade, backup and recovery must all know about. Worth a documented recipe if operators ask, not a built-in |
| Dropping mutual TLS on a private network | The network boundary and the certificate boundary protect against different things: a compromised tailnet device, a misconfigured access rule or a shared tailnet. Both stay |
| tug-managed WireGuard | Built once and cancelled with [M12](roadmap.md#m12--container-networking-over-the-mesh-cancelled) |

## Open questions

- Does Docker retry starting a container whose published address appeared after the daemon started, or does it stay exited until the next restart? This decides how much the boot-order drop-in matters.
- Does `tailscaled.service` report started only once `tailscale0` has its address, or does the drop-in need a wait?
- Should `control setup` offer `--bind` interactively when it finds a `100.64.0.0/10` address on the host, the way `node add` offers private addresses?
- Does anything in control key off the client IP? The `tailscale serve` alternative replaces the client's tailnet address with a local one, so audit records and any address-based logic would lose it.
