# Ingress and HTTPS

Serve a hostname over HTTPS from your VPS. One managed Caddy container per ingress node routes the hostname to your service and gets a certificate for it.

```sh
tug node ingress app1
tug deploy
```

`tug node ingress app1` gives `app1` the ingress role, and `tug deploy` applies the `x-tug.ingress` block below. DNS must point at the server, and ports 80 and 443 must be reachable. Node addresses, service names and published ports are in [Networking](networking.md).

## Set up ingress

One managed Caddy container per ingress node, configured by a Caddyfile that control renders.

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    x-tug:
      placement:
        nodes: [app1]
      ingress:
        host: app.example.com
        port: 80
        tls: auto
```

`tug node ingress edge1` marks a node as an ingress node, and `--disable` removes the role. The `ingress` keys are in [Compose extensions](compose.md#ingress).

| Rule | Behavior |
| --- | --- |
| One project per host | A deploy or rollback is refused with `409` if another project's current deployment already routes the host (case-insensitive) |
| Port | May be the container port or the published host port. Control resolves it to the published host port, and deploy rejects an ingress port that is not published, because the edge reaches `<node address>:<published port>` |
| Upstream | Caddy dials where the port is bound: `127.0.0.1` for a service whose ingress port listens on loopback on the ingress node, otherwise the node's `address`, including for services on the ingress node. Remote addresses must be reachable from the ingress node |
| Backend encryption | Caddy's automatic HTTPS protects client to ingress. The connection from Caddy to a service on another node is plain HTTP over your network |
| Reserved ports | Control never routes to Caddy's loopback management ports `2019` and `2021`, and an agent never allocates them to a revision, even inside `TUG_ROLLOUT_PORTS` |

### TLS modes

| `tls` | Behavior |
| --- | --- |
| `auto` (default) | Caddy obtains and renews certificates with ACME. Ports 80 and 443 must be reachable from the internet and the host's DNS record must point at the ingress node. A name such as `app.<ingress-ip>.sslip.io` resolves to that address without a domain you own, but `sslip.io` is shared and Let's Encrypt limits certificates per registered domain, so a burst of new names can be refused |
| `custom` | `cert` and `key` name two project secrets holding the PEM chain and private key: `tug secret set WEB_CERT --project blog --value "$(cat fullchain.pem)"`. Deploy fails if either is missing. Control decrypts them only for the ingress node, which gets them as files in the work response. They never reach the nodes running the service and never appear in the Caddyfile |
| `off` | Plain HTTP on port 80, for development |

### What control renders

Control aggregates the `ingress` blocks of every project's current deployment. For each ingress node it renders:

- one site block per host (all names of a `host` list, and every mapped domain, share their route's block when their TLS mode allows) with `reverse_proxy` to every serving endpoint,
- for a host with no serving upstream, or with `maintenance: true`, a site block that answers `503` with `Retry-After` and a short fixed text instead of proxying (listed in the work response's `ingress.warnings`, which no command shows yet), and only the first project when a host is claimed twice,
- with `TUG_INGRESS_ACCESS_LOG=true`, a JSON access log per site on the container's output (off by default, because URLs and client IPs are personal data), and, whenever there is a route, Caddy's Prometheus metrics labelled per host on `127.0.0.1:2019/metrics` on the ingress node (never a public port),
- with `TUG_ACME_EMAIL`, a global `email` for ACME registration.

### The Caddy container

The agent on an ingress node creates `tug-caddy` with host networking and three named volumes (`/data` for ACME accounts and certificates, `/config`, `/etc/caddy`), so certificates survive recreation and image updates. It uploads config through the Engine API archive endpoint, which works whether the agent runs on the host or in a container, and applies it with `caddy reload`. A reload swaps config without restarting the container or dropping in-flight HTTP requests (WebSockets stay open for a while, see [Edge features](#edge-features)). If Caddy rejects the config, the agent restores the last applied files, reports `failed` with Caddy's error in the node's ingress status and retries on the next poll. `tug doctor` flags ingress nodes that are not `serving`. Removing the ingress role removes the container but keeps the volumes. The image is `caddy:2-alpine`, overridable with `TUG_CADDY_IMAGE` on the agent.

For `rolling` services the upstream port is the one the serving revision reports, not the declared published port.

## Mapped domains and wildcard zones

A WordPress multisite can serve sites on different top-level domains (domain mapping) and on subdomains of a zone you control. Neither needs a wildcard certificate per customer domain, a custom Caddy build or an `ask` endpoint that calls WordPress.

| Kind | Use for | How |
| --- | --- | --- |
| Declared names | Names that belong in the Compose file and its history | `x-tug.ingress.host` takes a list, `host: [network.example.com, example.org, shop.other.net]`. Every name shares the route and its TLS mode, so with `tls: custom` one certificate (SAN or wildcard) must cover them all. Changing the list is a deployment |
| Mapped domains | Names added at runtime (`example.org`, `shop.other.net`) | `tug domain add <host> --service web`, or `POST /api/v1/domains` |
| Zones | `*.network.example.com` | Declare the wildcard as the route's `host`, or add it as a domain, with `tls: auto`. Each name under the zone is issued on demand, see [Edge features](#edge-features). Use `tls: custom` with a wildcard certificate when the network has many subdomains, because Let's Encrypt allows 50 certificates per registered domain per week |

**How a mapped domain behaves.**

- **Route.** Control stores it for the project and renders it as an extra address on the service's ingress route, sharing its upstreams, rollout switching and 503 behavior. No deployment is needed, and a redeploy or rollback keeps the list.
- **Certificate.** The next agent poll reloads Caddy, which requests the certificate in the background. The domain's DNS must already point at the ingress node, and a browser may see a certificate error for a few seconds until it is issued.
- **TLS.** With `tls: custom`, the certificate covers the declared names, so mapped domains (which can be any customer domain) still use automatic HTTPS. With `tls: off` they are served over plain HTTP.
- **Requirements.** A service with no `x-tug.ingress` route cannot take domains. A domain whose service later loses its route is kept but not served, and `ingress.warnings` says so.
- **Validation.** A mapped domain must be a plausible public name. An IP address, a label over 63 characters or a name over 253 is refused. A wildcard zone that is a public suffix such as `*.co.uk` is not detected and is your responsibility.
- **Ownership.** A hostname belongs to one project. Control rejects a domain, declared host or wildcard that overlaps another project's, on `domain add`, `deploy` and `rollback`, which an `ask` endpoint served by project code could not guarantee.
- **Access.** Adding a domain is as privileged as publishing a host through `x-tug.ingress`, so it needs the `deploy` role for the project. Automation (a WordPress hook, a CI job) calls the same API with a `deploy` credential scoped to the project. Events `domain.added` and `domain.removed` record the acting credential.
- **Storage.** Domains live in the control database, not the Compose file, so control backups cover them and a restore brings them back. There is no export, so keep the output of `tug domain list` if you rebuild a project elsewhere.

## Edge features

The generated Caddyfile is small: per host one `reverse_proxy` with `lb_policy round_robin` and the resilience settings below, the TLS mode and the optional ACME email. It has no compression, response headers, timeouts or body limit. The proposals for more are in [Ingress edge features](ingress-design.md).

It needs a current Caddy 2 image. The directives were tested against 2.11.7. A node that cached an older `caddy:2-alpine` is never re-pulled, so Caddy rejects the config, ingress reports `failed` and deployments for routed projects wait for it. Pull a newer image on that node, or set `TUG_CADDY_IMAGE` to a pinned tag, and recreate the container.

Every route with an upstream gets a `reverse_proxy` with:

| Setting | Effect |
| --- | --- |
| `lb_try_duration 5s`, `lb_try_interval 250ms` | A request that finds no usable upstream keeps trying for five seconds instead of failing at once with a 502. It covers the gap between an upstream dying and the next agent poll withdrawing its endpoint, and a `recreate` restart. A refused connection is always retried. After a successful connect only `GET` is retried, so a `POST` is never replayed, but a `GET` that crashes the service is replayed for the whole window. There is deliberately no passive health check (`fail_duration`): after a shared blip it would mark every replica down together and stall requests, and the endpoint list is already health-aware |
| `stream_close_delay 5m` | Caddy closes WebSockets on config reload, and one Caddy serves every project on the node, so a deploy to one site would cut live WebSockets on all of them. Open WebSockets now run for up to five minutes after a reload that replaced their config, then close, and clients are expected to reconnect. Each reload keeps the previous config generation alive while any of its streams is open, so frequent deploys with many open sockets hold memory and file descriptors in proportion |

### Limits

| Limit | Detail |
| --- | --- |
| WebSockets | A WebSocket outlives a reload for five minutes at most, and always ends when its upstream is removed. Plain HTTP requests in flight finish |
| 503 page | Fixed plain text. A branded page would have to be a file the project controls, which is unsafe next to other projects' keys in `/etc/caddy` |
| Retries | Bounded at five seconds. A longer outage, such as a slow `recreate` restart, still returns a 502 |
| ACME for a 503 host | A `tls: auto` host with no serving upstream, or in maintenance, keeps its site block, so Caddy tries ACME for it. A failing first deploy or DNS pointing elsewhere produces failed validations, which Let's Encrypt rate limits per host and registered domain before falling back to ZeroSSL. The benefit is a clear 503 and a certificate ready for the first success. Use `tls: off` while DNS is not ready |
| Admin API | Caddy's admin endpoint on `127.0.0.1:2019`, used by `caddy reload` and the metrics, is unauthenticated and reachable by any process on the node and any container with host networking. It accepts configuration, including one that serves `/etc/caddy`. Run only trusted workloads on an ingress node |
| Access log size | The `max-size 10m`, `max-file 3` log options apply only when the agent creates `tug-caddy`. A node with an existing container keeps Docker's unbounded default until it is recreated (`docker rm -f tug-caddy`, and the next poll recreates it and keeps certificates). Do this before enabling `TUG_INGRESS_ACCESS_LOG` |
| `/etc/caddy` | Shared by every project on the node, including the keys of every `tls: custom` route. That is why ingress options are typed `x-tug.ingress` fields that control validates, not a raw Caddyfile fragment |
| Certificate problems | Caddy retries a failed issuance with backoff. `tug ingress tls` shows which hosts have no certificate and why, and `tug ingress logs` shows Caddy's own attempts (see [Certificate status](#certificate-status)). Adding many domains at once starts that many ACME orders, which Let's Encrypt limits. Point DNS first and add domains in moderate batches |
| Reserved loopback ports | Caddy listens on `127.0.0.1:2019` (admin) and `127.0.0.1:2021` (the ask site, only when a wildcard zone is routed). Control rejects a deployment whose service may land on an ingress node and publishes either host port. A service that already did so before the node became an ingress node, or another process on the host, makes Caddy's reload fail for every site, so free the port |

### Certificate status

`serving` in `tug status` means Caddy accepted the configuration, not that visitors get a certificate. While Caddy cannot issue one, for example because the host firewall blocks port 80, a visit fails with a TLS internal error and every other tug view still reads healthy.

```bash
tug ingress tls
tug ingress logs n2 --tail 100
```

`tug ingress tls` lists one row per host and ingress node. The agent on each ingress node connects to its own Caddy on port 443 with the host as the server name and reads the certificate that comes back, so the state is what a client gets:

| State | Meaning |
| --- | --- |
| `issued` | A certificate that covers the host and has not expired is served. The detail column shows its expiry |
| `pending` | The handshake fails or the certificate does not cover the host, and Caddy has logged no issuance error for the host yet. A new domain stays here until DNS and port 80 are right |
| `failed` | Pending, and the latest issuance error Caddy logged for the host is shown as the reason |
| `unknown` | The node's agent predates this report, or has not reported yet. It never reads as `issued` |

The same state appears elsewhere:

- `tug domain list` adds a `tls` entry per ingress node to each mapped domain.
- `tug status` adds a count to an ingress node with hosts that have no certificate yet, so `serving` is not read as reachable. It is a count because host names span projects, so the names stay behind `tug ingress tls`.
- `tug doctor` fails the `ingress` check for a host that is `failed`, or `pending` for more than ten minutes, and names the host, the node and the reason.

Only names Caddy issues itself are checked: `tls: auto` hosts and mapped domains. Wildcard names are skipped, because a probe would trigger on-demand issuance for a name nobody asked for, and so are `tls: custom` hosts, whose certificate you supply. The reason comes from Caddy's JSON log and is best effort: an unrecognized log format costs the reason, never the state. Probing is throttled to every twenty seconds for a host without a certificate and hourly for one with, so a fix shows within about half a minute.

### Wildcard hosts are issued name by name

A wildcard host such as `*.network.example.com` with `tls: auto` cannot get one wildcard certificate, because that needs the DNS-01 challenge, which stock `caddy:2-alpine` cannot do. Caddy issues a certificate for each name under the zone the first time a client connects (on-demand TLS). It asks a loopback-only endpoint it serves itself (`127.0.0.1:2021`, rendered by control from the wildcard hosts it routes) and approves exactly one label under the zone: `site1.network.example.com` yes, `a.b.network.example.com`, the bare zone and every other domain no. Only names under a zone a project declared can trigger issuance, though control cannot verify who controls the zone's DNS.

The first visit to a new name waits for its certificate. Anyone who can make a name under the zone resolve to the node can trigger issuance, and with a wildcard DNS record that is anyone on the internet. A flood of random labels can use up Let's Encrypt's 50 certificates per registered domain per week and block real new sites. A public subdomain network should therefore use `tls: custom` with a wildcard certificate. Keep on-demand zones for networks where the node is not publicly resolvable, or a CDN or firewall limits who can connect.
