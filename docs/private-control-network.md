# Private control network

Status: proposed, 22 November 2026, against `31c0a6c`. Nothing below is built except what [What works today](#what-works-today) describes, and each step in [The setup, end to end](#the-setup-end-to-end) says whether it runs today. The Tailscale and Headscale claims were tested on two QEMU VMs on 22 November 2026 ([Validation](#validation)). Claims still marked "verify" were not covered by that run.

Can control's mutual TLS port be kept off the public internet by putting control, nodes, operators and CI on a private network: a tailnet such as Tailscale or a self-hosted Headscale, or plain WireGuard? Yes. Most of it works with today's flags, because clients verify control by a name derived from its CA instead of the address they dial. This record proposes the pieces that close the rest: publishing the control port on chosen addresses only, taking a node's address from its tailnet interface, ordering Docker after the tailnet daemon, a cloud-init preset that joins new nodes to the tailnet, a `tug doctor` check and an operator guide.

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
| Control host | Yes | Nothing new. Agents and clients dial it | Nothing. Port 8443 is bound to loopback and reached through a `tailscale serve` forward, or bound to the WireGuard address on plain WireGuard |
| Nodes | Yes | Control's tailnet address. Other nodes' tailnet addresses for cross-node services | Ingress nodes keep 80 and 443 |
| Operator machines | Yes | Control's tailnet address, and hosts over SSH | Not applicable |
| CI runners | Yes, per job | Control's tailnet address only | Not applicable |
| Visitors | No | Ingress nodes on 80 and 443 | Not applicable |

Workload traffic between nodes rides the tailnet too once node addresses are tailnet IPs, which gives the node-to-node encryption that [Networking](networking.md#bring-your-own-network) says tug does not provide itself.

## Supported networks

tug needs one thing from the network: every host that dials control, and every node that serves another, can route to the right private IP. Anything that provides that works. The proposal names three levels of support.

| Network | Support | What tug adds | What the operator adds on top of a tailnet |
| --- | --- | --- | --- |
| Tailscale | Preset: `--tailnet tailscale` | Installs the client, joins with the key, takes the address from `tailscale0`, orders Docker after `tailscaled` | Nothing beyond the [who does what](#who-does-what) table |
| Headscale | Preset: `--tailnet tailscale --tailnet-login-server <url>` | The same as Tailscale. The client is the official Tailscale client pointed at the operator's server | Runs the Headscale server, keeps it reachable from every host (it and its DERP relay are public-facing services the operator secures), and writes access rules in Headscale's policy file. Headscale implements a subset of the Tailscale coordination features, so check each feature the guide relies on against the Headscale version in use |
| Plain WireGuard (`wg-quick`) | Generic: `--pre-script`, `--address-interface wg0`, `--docker-after wg-quick@wg0.service` | Runs the operator's script before Docker, takes the address from `wg0`, orders Docker after the interface | Everything a coordination server would do. See [Plain WireGuard](#plain-wireguard) |
| NetBird, ZeroTier, Nebula and others | Generic, as for plain WireGuard | As for plain WireGuard | Their own client install and join in `--pre-script`. tug adds a preset only when operators ask |

### Plain WireGuard

Plain WireGuard works with the same tug pieces, because to tug `wg0` is one more interface with a private address. Each `wg-quick@` unit configures the interface and its address before it reports started, which suits `--docker-after` better than a daemon that brings its interface up later (verify). What a coordination server does, the operator does by hand:

| Concern | With a tailnet | With plain WireGuard |
| --- | --- | --- |
| Keys | The client generates and registers its key | The operator generates a key pair per host and adds its public key to every peer that must reach it |
| Topology | Full mesh, set up by the coordination server | The operator chooses. A hub on the control host is simplest: nodes list only the hub, and the hub lists every node. Cross-node workload traffic then passes through the hub, or the operator maintains a full mesh |
| Addresses | Assigned by the coordination server | The operator allocates them, for example from `10.88.0.0/24` |
| Reachability | NAT traversal, with relays as fallback | At least one peer, the hub, needs a reachable UDP port. WireGuard sends nothing back to packets that do not carry a valid peer key, so that port does not reveal a service to scanners the way an open TCP port does |
| Access rules | A policy in the coordination server | `AllowedIPs` per peer, plus host firewall rules |
| New nodes | A join key and an auth key in user-data | The operator adds the node's peer to the hub before the node boots, and puts the node's private key and the hub's public key in user-data. Nothing on the node can register itself, so autoscaling needs the operator's own automation |
| Key rotation and removal | Through the coordination server | Edit every affected peer's config and reload |

tug does not generate WireGuard keys, allocate addresses or distribute peer lists. That is the tug-owned mesh cancelled with [M12](roadmap.md#m12--container-networking-over-the-mesh-cancelled), and a tailnet or Headscale covers it for operators who do not want to do it by hand.

## Who does what

| Concern | tug does | The operator does |
| --- | --- | --- |
| The tailnet itself | Nothing. tug works the same on any routed private network | Runs the tailnet account or a Headscale server, and keeps it up |
| Access rules | The guide ships a reference policy: a tag for nodes, a tag for CI, and which ports each may reach | Writes and maintains the policy in the tailnet admin |
| Auth keys | The enrollment preset copies a key file into the generated user-data as a `0600` file and removes it after joining. Control never sees or stores it | Creates tagged, pre-authorized, single-use or short-lived keys, and treats saved user-data as a secret, as it already must for the join key |
| Joining hosts | `node enroll --tailnet tailscale` installs the client and joins before Docker starts | Joins the control host, SSH-installed nodes, operator machines and CI runners |
| Control port exposure | `control setup --bind` publishes only on the given addresses, and `tug doctor` reports a port bound to every interface | Closes 8443 at the provider firewall for installs made before `--bind`, or rebinds them |
| Boot order | `--docker-after <unit>` installs a systemd drop-in so Docker starts after the tailnet daemon and waits for the addresses tug binds. The agent recreates a container whose start failed on a missing address | Adds the drop-in by hand on hosts set up without the flag |
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
| 2. Install control on the tailnet | Operator joins, tug installs | Partly. `--bind` is proposed. The `tailscale serve` forward runs today |
| 3. Join the operator machine | Operator | Yes, outside tug |
| 4a. Add nodes over SSH | Operator joins, tug installs | Yes, with the tailnet IP typed by hand. `--docker-after` is proposed |
| 4b. Add nodes with cloud-init | tug does both | No. The preset and `--address-interface` are proposed |
| 5. Deploy from CI | Operator | Yes |
| 6. Close the public port | tug and operator | Partly. The doctor check is proposed |
| 7. Move an existing install | Operator, with tug commands | Yes, except rebinding without rerunning setup |

**1. Prepare the tailnet (operator).** Create two tags, for example `tag:tug-node` and `tag:tug-ci`. Allow operator devices, `tag:tug-node` and `tag:tug-ci` to reach the control host on TCP 8443. Allow `tag:tug-node` to reach other nodes on the published ports your services use, and ingress nodes to reach their upstreams. Create a reusable or single-use auth key tagged `tag:tug-node` for enrollment, and an ephemeral key tagged `tag:tug-ci` for CI. Ephemeral devices are removed when they go offline, so use them only for CI, never for servers.

**2. Install control on the tailnet.** Join the control host to the tailnet yourself, then:

```sh
tug control setup root@control.example.com --bind 127.0.0.1 --control-url https://control.tail1234.ts.net:8443
```

Then, on the control host, forward the tailnet address to it:

```sh
tailscale serve --bg --tcp 8443 tcp://127.0.0.1:8443
```

Control binds only loopback, which always exists, so neither a boot race nor a coordination outage can leave its port unbound, and the forward resumes by itself when the tailnet comes back. The forward is raw TCP, so mutual TLS passes through untouched, and its configuration survives a reboot. The same loopback binding serves break-glass access over an SSH tunnel. On plain WireGuard there is no forwarder, so bind the WireGuard address as well: `--bind 10.88.0.1 --bind 127.0.0.1 --docker-after wg-quick@wg0.service`. `--control-url` is written into every credential, and any address works there because clients verify the CA-derived name. SSH itself may go over the public address or the tailnet.

**3. Join the operator machine (operator).** The CLI dials `--control-url`, so the machine running `tug` must be on the tailnet.

**4a. Add nodes over SSH.** Join the host to the tailnet yourself, then:

```sh
tug node add root@app1.example.com --name app1 --address 100.101.102.103 --agent-control-url https://control.tail1234.ts.net:8443 --docker-after tailscaled.service
```

The address picker already lists the tailnet IP as private, so in a terminal you can pick it instead of typing it. Workload ports bind to that address and cannot sit behind a forwarder, so nodes rely on `--docker-after` and the agent repair in [Boot order](#2---docker-after-unit-for-boot-order).

**4b. Add nodes with cloud-init.** Save the output as the instance's user-data:

```sh
tug node enroll --name app2 --install-docker --tailnet tailscale --tailnet-auth-key-file ./tug-node.key --agent-control-url https://control.tail1234.ts.net:8443
```

The generated cloud-init installs Tailscale, joins with the key, installs the Docker ordering drop-in, installs Docker and starts the agent with its address taken from `tailscale0`. For Headscale, add `--tailnet-login-server https://headscale.example.com` and mint the auth key on the Headscale server. For plain WireGuard, write a script that installs `wireguard-tools`, writes `/etc/wireguard/wg0.conf` with the node's key and the hub as its peer, and enables `wg-quick@wg0`, after adding the node's peer to the hub:

```sh
tug node enroll --name app2 --install-docker --pre-script ./wg-app2.sh --address-interface wg0 --docker-after wg-quick@wg0.service --agent-control-url https://10.88.0.1:8443
```

The script holds the node's WireGuard private key, so treat it and the generated user-data as secrets.

**5. Deploy from CI (operator).** Add a tailnet step before `tug deploy`, with the `tag:tug-ci` key as a repository secret. The deploy itself is unchanged ([Deploying from GitHub Actions](access-control.md#deploying-from-github-actions)).

```yaml
- uses: tailscale/github-action@<commit-sha> # v4.4.0 when checked
  with:
    oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
    oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
    tags: tag:tug-ci
    ping: control.tail1234.ts.net
- run: npx --yes @wpelevator/tug@<version> deploy
  env:
    TUG_CREDENTIAL: ${{ secrets.TUG_CREDENTIAL }}
```

The action takes an `authkey`, an OAuth client (`oauth-client-id` and `oauth-secret`), or `oauth-client-id` with `audience` for workload identity federation. `tags` is a comma-separated list, required with OAuth and federation, and the OAuth client needs the writable `auth_keys` scope. Devices it creates through OAuth are ephemeral. `ping` waits up to three minutes for the named peer, so the deploy does not start before the runner can reach control. With Headscale, use `authkey` with a key minted on the Headscale server, because OAuth clients are a Tailscale service feature.

**6. Close the public port.** With `--bind 127.0.0.1`, or `--bind` with private addresses only, Docker no longer publishes 8443 on the public interface. Keep a provider firewall rule denying it anyway, because a later `control setup` run without `--bind` reopens it. `tug doctor` reports any control binding on every interface.

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

Agents share the host's network namespace (`--network host`), so with Tailscale in its default kernel mode they reach `100.x` addresses through `tailscale0` like any host process. Tailscale in userspace-networking mode creates no `tailscale0` interface, and neither a host process nor a `--network host` container can reach a peer's address. It offers a SOCKS or HTTP proxy only when started with `--socks5-server` or `--outbound-http-proxy-listen`, and the agent and CLI use neither, so they need kernel mode. Inbound connections still reach the userspace host's local listeners, so a control host could run in userspace mode, but its nodes cannot. Control itself runs on Docker's default bridge and only accepts connections, so it needs nothing beyond the published port.

## The gaps

| Gap | Detail |
| --- | --- |
| Setup always publishes on every interface | `control setup` builds its binding as `{ port }` with no host IP, so Docker publishes `0.0.0.0:8443` and `[::]:8443`. The binding type already carries a `hostIp`, and upgrade keeps one, but nothing sets it |
| Docker can start before the tailnet | A container published on a tailnet address fails to start if Docker comes up before `tailscale0` exists. This hits control with `--bind`, and every node whose address is a tailnet IP, since published workload ports bind to the node address |
| Enrollment needs the address up front | `node enroll --address` bakes `TUG_NODE_ADDRESS` into the snippet, but a tailnet IP exists only after the host joins |
| Enrolled hosts cannot join a tailnet first | The generated cloud-init runs the Docker bootstrap and the agent, with no stage before Docker for the operator's network |
| A failed start is not repaired | When a bound container fails to start because its address is missing, the agent later calls `docker start` on it, which leaves it running with no published port |
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

Docker cannot publish on an address that is not yet assigned. The QEMU run showed what happens when Docker starts before the tailnet address exists:

| Finding | Detail |
| --- | --- |
| The race is real and intermittent | `tailscaled` is `Type=notify`, but systemd logs it started 0.6 to 3 seconds before `tailscale0` has its address. Containers bound to the address failed in 3 of 3 plain boots on one VM pair and 1 of 3 on another |
| Docker does not retry | The container stays `exited` with `failed to bind host port 100.64.0.1:8443/tcp: cannot assign requested address` and a restart count of 0, even after the address appears |
| A later start does not repair it | After the failed start the container has no network attached. `docker start` brings it up as running with no published port and no error. Recreating it, or `docker network connect bridge <container>`, repairs it |
| `After=` alone is not enough | A drop-in with only `After=` and `Wants=` failed in 2 of 4 boots across the runs |
| `After=` plus a wait works | The drop-in below brought the container up in 3 of 3 boots, including one with `tailscaled` delayed by 40 seconds |

This was seen on Ubuntu's `docker.io` 29.1.3. Recheck on Docker CE, which `--install-docker` installs (verify).

`--docker-after <unit>` on `control setup`, `node add` and `node enroll` writes `/etc/systemd/system/docker.service.d/tug-after.conf` and reloads systemd. The wait checks for the addresses tug binds on that host (the `--bind` addresses on control, the node address on a node), so it needs no interface flag. Control's loopback binding needs no wait:

```ini
[Unit]
After=tailscaled.service
Wants=tailscaled.service
[Service]
ExecStartPre=/bin/sh -c 'for i in $$(seq 1 60); do ip -o addr show | grep -q " 100.101.102.103/" && exit 0; sleep 1; done; exit 0'
```

`$$` is systemd's escape for `$`. The wait gives up after 60 seconds and lets Docker start anyway, so a tailnet that never comes up delays the host's containers by a minute instead of blocking them. The `--tailnet tailscale` preset implies `--docker-after tailscaled.service`. The agent itself needs no ordering, because it binds nothing and retries its connection to control.

The QEMU run used an interface-wide wait (`ip -4 -o addr show dev tailscale0`). The address-specific form above is the same check narrowed to one address, and has not been run (verify).

**The agent repairs a failed start.** If the tailnet is down for the whole boot, for example during a coordination outage, the wait times out and bound containers fail as above. The agent's reconciler then calls `docker start` on an exited container whose hash matches (`ensureContainer` in `src/agent/reconciler.ts`), which by the finding above leaves it running with no published port. So the agent must recreate a container instead of starting it when it exited with a bind error, or when it runs with fewer published ports than its spec. That fixes nodes whose address appears late for any reason, tailnet or not. This follows from the code path and the QEMU finding, and has not been run against the agent (verify).

**Control leads with loopback and a forward.** On Tailscale and Headscale, control binds `127.0.0.1` and `tailscale serve --bg --tcp 8443 tcp://127.0.0.1:8443` forwards the tailnet address to it, as in [step 2](#the-setup-end-to-end). The run confirmed the syntax (`--bg` keeps it from running in the foreground), that it works against Headscale and that it survives a reboot. Loopback cannot fail to bind, so control needs neither the drop-in nor the repair, and a reboot during a coordination outage leaves control reachable again as soon as the tailnet returns. Control sees every forwarded client as `172.17.0.1`, the bridge gateway behind `docker-proxy`. Plain WireGuard has no forwarder, so there control binds the WireGuard address with `--docker-after wg-quick@wg0.service`.

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
| `--tailnet tailscale` | Preset. Installs Tailscale from pkgs.tailscale.com, joins, and implies `--address-interface tailscale0` and `--docker-after tailscaled.service`. The repository serves Debian 12 and 13, Ubuntu 22.04 and 24.04, Fedora, RHEL 9 and 10 and CentOS Stream 9 and 10. Tailscale does not name Rocky Linux or AlmaLinux, which would use the RHEL repositories (verify) |
| `--tailnet-auth-key-file <file>` | Required with the preset. The key is written to a `0600` file, passed as `tailscale up --auth-key=file:<path>` and deleted after joining, since `tailscale up` leaves the file in place |
| `--tailnet-login-server <url>` | Optional. Points the client at a Headscale or other compatible coordination server. Headscale 0.29 refuses clients older than 1.80, so the preset installs the current client |

The node's tag comes from the auth key, so tug needs no tag flag and the operator's access rules stay the single source of truth. On Tailscale, "the tagged device's key expiry is disabled by default" ([Tags](https://tailscale.com/kb/1068/tags)), which suits servers. Headscale 0.29 sets no key expiry on any node, tagged or not, and applies the tag a pre-auth key carries (`headscale preauthkeys create --tags tag:tug-node`). Like the join key, the auth key is readable by anything that can read the user-data, including the provider's metadata service on some clouds, so prefer single-use or short-lived keys. Headscale uses the same preset with `--tailnet-login-server`. Plain WireGuard and other networks use `--pre-script` with `--address-interface` and `--docker-after`, as in [Supported networks](#supported-networks). tug does not add presets for them until operators ask.

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
| Coordination server unreachable (Tailscale or Headscale) | Nothing, at first | Peers whose tailnet daemon keeps running keep reaching each other. On Headscale this held for at least four minutes in the QEMU run. Tailscale's hosted service was not tested | Restore the coordination server. New devices, including new enrollments, cannot join until then. For Headscale this is the operator's own server |
| A host restarts its tailnet daemon or reboots while coordination is down | That node goes stale, or every node if it is the control host | Its public ports. Its tailnet address, peers and cross-node traffic are gone until coordination returns, then recover by themselves | Restore coordination. Containers bound to the tailnet address need the agent repair in [Boot order](#2---docker-after-unit-for-boot-order). Control behind a loopback forward needs nothing |
| WireGuard hub down (plain WireGuard) | Every node goes stale, as with control down, because the hub is the control host | Running containers. Cross-node traffic stops if it routes through the hub | Bring the hub back. A full mesh keeps node-to-node traffic up |
| Access rule removed | The same symptoms as the daemon being down, for the affected peers | As above | Restore the rule. tug cannot see tailnet policy |
| Auth key expired or used up | Enrollment never completes, and the cloud-init log shows the tailnet stage failing | Existing nodes | Mint a new key and a new join key |
| Host re-registered with a new IP | Cross-node clients and ingress upstreams fail to reach the node | The node's own public ports | `tug node address <node> <new-ip>` |

## Validation

`tools/scripts/qemu-tailnet.js` reruns the core checks on two Ubuntu 24.04 arm64 VMs (kernel 6.8, Ubuntu `docker.io` 29.1.3, Tailscale 1.104.7, Headscale 0.29.7). VM `a` runs Headscale and is also a peer. The VMs share a point-to-point link through QEMU's `-netdev socket`, so no root is needed, and peers talk directly with DERP off. Requirements are those of the [first-boot harness](development.md#first-boot-with-qemu).

```sh
node tools/scripts/qemu-tailnet.js all --work ~/tug-tailnet --image ~/images/ubuntu-24.04-server-cloudimg-arm64.img
```

| Claim | Result |
| --- | --- |
| Docker retries a container whose address appears late | No. See [Boot order](#2---docker-after-unit-for-boot-order) |
| `After=tailscaled.service` is enough | No. `After=` plus a wait for the address is |
| `tailscale up --auth-key=file:<path>` | Works |
| Userspace mode blocks agents | Yes. No `tailscale0`, and host-network containers and host processes time out reaching peers |
| `tailscale serve` forwards raw TCP and persists | Yes, as `tailscale serve --bg --tcp 8443 tcp://127.0.0.1:8443`, against Headscale, across a reboot |
| Source address through the forward | `172.17.0.1`, the bridge gateway. Publishing directly on the tailnet address showed the real peer address in some runs and `172.17.0.1` in others, so control cannot rely on the client address either way |
| Coordination server down | Running peers keep talking. New devices cannot join. A restarted daemon loses the tailnet until coordination returns |
| Headscale tags from a pre-auth key | Applied. No key expiry on any node |
| tug over the tailnet | `node add --address <tailnet ip> --agent-control-url https://<control tailnet ip>:8443` came online with control hand-bound to its tailnet address and loopback. `node upgrade` skipped a node on the same image until `--force`, which repointed it. `tug --control-url https://127.0.0.1:18443 status` through an SSH tunnel to the loopback binding worked |

Not covered: Tailscale's hosted coordination server and its DERP relays, Headscale access policies, Docker CE, plain WireGuard, `tug node address` and `tug doctor`, and the proposed flags themselves.

## Not proposed

| Idea | Why not |
| --- | --- |
| tug joins the tailnet itself | There is no embedded Tailscale library for Node.js (`tsnet` is Go only), and running `tailscaled` inside control or the agent means owning auth keys, state and upgrades for a third-party daemon. It would also tie tug to one vendor where today any routed network works |
| Tailnet setup over SSH in `control setup` and `node add` | The operator is already on the host and joins it in one command. The enrollment preset exists because nobody is on an enrolled host to do it |
| Storing tailnet auth keys in control | Control would hold a credential that admits devices to the operator's network, for no gain over the operator's own secret store |
| A Tailscale sidecar container sharing control's network namespace | Removes the host port entirely, but adds a second container that setup, upgrade, backup and recovery must all know about. Worth a documented recipe if operators ask, not a built-in |
| Dropping mutual TLS on a private network | The network boundary and the certificate boundary protect against different things: a compromised tailnet device, a misconfigured access rule or a shared tailnet. Both stay |
| tug-managed WireGuard: generating keys, allocating addresses or distributing peer lists | Built once and cancelled with [M12](roadmap.md#m12--container-networking-over-the-mesh-cancelled). Operators who want that managed for them use Headscale |

## Open questions

- Does Docker CE behave like Ubuntu's `docker.io` in the boot race, including leaving the container with no network after a failed start?
- Does `wg-quick@wg0.service` have its address before it reports started, so plain WireGuard needs only `After=`?
- Should `control setup` offer `--bind` interactively when it finds a `100.64.0.0/10` address on the host, the way `node add` offers private addresses?
- Does anything in control key off the client IP? Behind the forward every client is `172.17.0.1`, and a direct binding did not reliably preserve the address either, so audit records should rely on the certificate identity, not the address.
