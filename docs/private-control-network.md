# Private control network

Status: proposed, 22 November 2026. Nothing below is built except what [What works today](#what-works-today) describes. Tailscale behavior comes from its documentation and general knowledge as of that date, and the claims marked "verify" need a real-host run before anything ships.

Can control's mutual TLS port be kept off the public internet by putting control, nodes, operators and CI on a tailnet (Tailscale, Headscale, NetBird or a plain WireGuard network)? The short answer: yes, and most of it works with today's flags, because clients verify control by a name derived from its CA instead of the address they dial. What is missing is a way for `tug control setup` to publish the control port on one address instead of every interface, a `tug doctor` warning when it is published on all of them, and an operator guide. tug should not join, configure or depend on any tailnet itself: the cancelled tug-owned mesh ([M12 in the roadmap](roadmap.md#m12--container-networking-over-the-mesh-cancelled)) showed the cost of owning a tunnel, and a tailnet is just another routed private network to tug.

## Why

Control is the one host every credential trusts. Its port accepts only clients with a certificate from control's CA, rejects anything else during the TLS handshake and has no unauthenticated route ([Authentication and PKI](control-plane.md#authentication-and-pki)). Exposing it still has costs that mutual TLS does not remove:

| Exposure | Effect |
| --- | --- |
| Scanning and handshake load | Anyone can open TCP connections and start TLS handshakes, so a TLS or Node.js bug reachable before certificate validation is reachable from the internet |
| A leaked credential works from anywhere | A stolen CI or operator credential can be used from any network until it is revoked |
| Operator firewalling is manual | `control setup` publishes the port on every interface, and Docker's iptables rules bypass host firewalls such as ufw, so the only boundary is a provider firewall the operator must remember |

A private network makes a leaked credential useless without network access as well, and takes the pre-authentication surface off the internet. It is defense in depth: mutual TLS stays mandatory on every connection.

## What works today

| Piece | How |
| --- | --- |
| Clients reach control at a tailnet address | `tug control setup <ssh-target> --control-url https://control.tail1234.ts.net:8443` writes that URL into every credential. Any address works, because the CLI and agent verify the derived `control-<hash>.tug` name, not the URL host |
| Agents dial control over the tailnet | `--agent-control-url https://100.64.0.10:8443` on `node add`, `replace`, `repair`, `migrate`, `upgrade` and `enroll`. Agents only dial out, so nodes need no inbound port |
| Workload traffic over the tailnet | `tug node add --address 100.101.102.103`, or `tug node address <node> <ip>`. The address picker already lists `100.64.0.0/10` as private, since it is the carrier-grade NAT range tailnets use. This also gives node-to-node encryption, which [Networking](networking.md#bring-your-own-network) says tug does not provide itself |
| Moving an existing control onto the tailnet | Point clients at the new address with `--control-url` and nodes with `node upgrade --agent-control-url`. No credential is invalidated |
| Keeping a narrow binding | `tug control upgrade` replays the existing published bindings including their host IPs ([SEC-16](security-audit.md)), so a hand-made binding survives upgrades |

Agents run on Docker's default bridge network. With Tailscale in its default kernel mode, the host routes the container's masqueraded traffic to `100.x` addresses through `tailscale0`. Tailscale in userspace-networking mode does not route container traffic, so it does not work for agents without extra setup (verify).

## The gaps

| Gap | Detail |
| --- | --- |
| Setup always publishes on every interface | `control setup` builds its binding as `{ port }` with no host IP, so Docker publishes `0.0.0.0:8443` and `[::]:8443`. The binding type already carries a `hostIp`, and upgrade keeps one, but nothing sets it |
| Nothing warns about a public control port | `tug doctor` warns about workload containers listening on all interfaces (`ports.public`) but says nothing about control's own port |
| No operator guide | The flags above are documented one by one, and nothing shows the full setup, the CI step or the boot-order caveat |

## Proposal

### 1. `control setup --bind <ip>`

Publish the control port on one host address instead of every interface. Repeatable, like `--extra-san`, so a host can bind its tailnet address and loopback.

```sh
tug control setup root@control.example.com --bind 100.64.0.10 --control-url https://control.tail1234.ts.net:8443
```

| Rule | Behavior |
| --- | --- |
| Values | IPv4 or IPv6 literals. A hostname is refused, because Docker binds addresses, not names |
| Preflight | Over SSH, setup checks that each address is on one of the host's interfaces and fails before touching the container when one is not |
| Default URL | When `--bind` is given without `--control-url`, setup still advertises the SSH target's host, and warns when that host is not one of the bound addresses, since clients would then dial an address nothing listens on |
| Running setup again | Like `--port`, a missing `--bind` resets to all interfaces, and the existing note about changed settings names the binding change |
| Upgrade | Unchanged: `control upgrade` already replays bindings with their host IPs |

The same flag gives [M15](roadmap.md#m15--flexible-node-roles) its break-glass port bound to loopback or a private address.

**Boot order.** Docker cannot publish on an address that is not yet assigned, so if Docker starts before `tailscaled` has brought up `tailscale0`, the control container fails to start with a "cannot assign requested address" error. Whether the `unless-stopped` restart policy retries that failure on daemon start needs checking on a real host (verify). Two ways around it, to be chosen after that check:

| Option | How | Trade-off |
| --- | --- | --- |
| A. Order Docker after the tailnet | A systemd drop-in `After=tailscaled.service` and `Wants=tailscaled.service` for `docker.service`, which setup could offer to install | Couples Docker's start to the tailnet daemon. A tailnet outage at boot delays every container on the host |
| B. Bind loopback and forward | `--bind 127.0.0.1`, with `tailscale serve --tcp 8443 tcp://127.0.0.1:8443` forwarding raw TCP from the tailnet address | Loopback always exists, so boot order stops mattering, and TCP passthrough keeps mutual TLS intact. Control then sees every client as `127.0.0.1`, and it depends on a Tailscale-specific feature (verify the flag syntax and that it persists across restarts) |

Recommendation: document both, and make the guide lead with option B on Tailscale hosts and option A for other tailnets.

### 2. A doctor warning for the control port

Control can inspect its own container through the Docker socket it already mounts. Report its published bindings in control's diagnostics, and have `tug doctor` print a `control.port.public` warning when a binding has no host IP or a non-private one. It is a warning, not a failure, because a public control port is a supported setup. The check reports configuration, not reachability, and says so: a provider firewall may already close the port, and tug cannot see that from inside.

### 3. An operator guide

A section "Keep control private" in [Control plane](control-plane.md), linked from the [production checklist](production-checklist.md), covering:

| Step | Content |
| --- | --- |
| Control host | Join the tailnet, then `control setup --bind` with the tailnet address, or loopback plus a forward |
| Nodes | Join the tailnet before `node add`, and pass `--agent-control-url` and `--address` with tailnet addresses. For `node enroll` from cloud-init, join the tailnet earlier in the same cloud-init |
| Operators | The machine running the CLI joins the tailnet. `tug setup` and `node add` use SSH, which can also go over the tailnet |
| CI | A step such as `tailscale/github-action` with an ephemeral, tagged auth key before `tug deploy`, and a tailnet ACL that lets the CI tag reach only control's port |
| What stays public | Ingress nodes keep ports 80 and 443 public. ACME HTTP-01 validation needs them, and so do visitors |
| Access rules | Tailnet ACLs allow nodes, operators and CI to reach control's port, and only the ingress nodes to reach upstream ports |

## Not proposed

| Idea | Why not |
| --- | --- |
| tug joins the tailnet itself | There is no embedded Tailscale library for Node.js (`tsnet` is Go only), and running `tailscaled` inside control or the agent means owning auth keys, state and upgrades for a third-party daemon. It would also tie tug to one vendor where today any routed network works |
| A Tailscale sidecar container sharing control's network namespace | Removes the host port entirely, but adds a second container that setup, upgrade, backup and recovery must all know about. Worth a documented recipe if operators ask, not a built-in |
| Dropping mutual TLS on a private network | The network boundary and the certificate boundary protect against different things: a compromised tailnet device, a misconfigured ACL or a shared tailnet. Both stay |
| tug-managed WireGuard | Built once and cancelled with [M12](roadmap.md#m12--container-networking-over-the-mesh-cancelled) |

## Open questions

- Does Docker retry starting a container whose published address appeared after the daemon started, or does it stay exited until the next restart? This decides how much the boot-order caveat matters.
- Should `control setup` offer `--bind` interactively when it finds a `100.64.0.0/10` address on the host, the way `node add` offers private addresses?
- Should the audit log record that a connection came through a local forward, since option B hides the client's tailnet address?
