# Service placement and scaling

Run a service on a second server, keep a database on the server that holds its data, and spread replicas by label.

```sh
tug node add root@198.51.100.7 --name app2 --address 10.0.0.7
tug deploy
tug status
```

With one registered node, a service with no placement runs there. Once several nodes are registered, each service must select explicit nodes, labels or `global: true`. Adding a node does not move a deployed service, copy its data or provide failover. Placement is resolved at deploy or scale time and is not rescheduled when a node fails.

| Mode | Set with | Result |
| --- | --- | --- |
| Explicit nodes | `placement.nodes: [app1, app2]` | One copy on each listed node. Scaling stays within the named nodes |
| Labels and replicas | `placement.labels: [web]` and `replicas: 2` | Up to two matching, recently seen nodes when placement is resolved. A node must carry all listed labels, and nodes created without the label do not match. See [node labels](nodes.md#node-labels) |
| Global | `global: true` | One copy on each matching node, or each node if no labels are given |

`tug scale web 2` changes the current desired placement within its allowed set, and the next deploy re-resolves it from the Compose file. No mode puts several copies on one node or replaces a failed host automatically. Check placement with `tug status`. The complete rules are in [Compose extensions](compose.md#service-x-tug-keys).

## Spread the first service across two nodes

This continues from [Deploy your first service](getting-started.md). The nginx service is stateless, so both VPSes can run an independent copy. The example keeps the tutorial's public port, so restrict TCP 8080 to your computer on both VPSes with provider firewalls. For a public site use [ingress and HTTPS](ingress.md#set-up-ingress) instead.

1. **Give the new VPS an address** on your private network and make sure it can reach control on TCP 8443. To call services across nodes, or route ingress from one node to services on the other, both hosts need mutually reachable private addresses and matching firewall rules. Tug does not create or encrypt this network, see [Networking](networking.md#bring-your-own-network).
2. **Add the agent**, replacing the SSH address and private address with yours. In a terminal, Tug offers Docker installation and shows the plan first.

```sh
tug node add root@198.51.100.7 --name app2 --address 10.0.0.7
tug node list
```

3. **Add placement** to `web` in your existing `compose.yaml`, keeping its image, port and health check:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "0.0.0.0:8080:80"
    x-tug:
      placement:
        nodes: [app1, app2]
      health:
        type: http
        port: 80
        path: /
```

4. **Redeploy and check both nodes.** Replace the example IPs with your VPS addresses. Each should return the nginx welcome page.

```sh
tug deploy
tug status
curl http://203.0.113.5:8080/
curl http://198.51.100.7:8080/
```

This places one container on each named node and does not load-balance the two public addresses. Managed ingress can route to healthy services on several nodes when their workload network is reachable, and its hostname needs DNS pointing at an ingress node, see [Ingress and TLS](ingress.md#set-up-ingress).

## Keep state on its server

A named local volume belongs to one node. For an app with a database, pin the database service and its volume to the node holding the data, and choose placement for every other service. Add these blocks to your existing database service and volume definitions:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  db:
    x-tug:
      placement:
        nodes: [app1]
volumes:
  db-data:
    x-tug:
      placement:
        nodes: [app1]
```

This is a placement fragment, not a complete Compose file. If a web service on `app2` connects to the database on `app1`:

- The database must publish a port on its private node address.
- The client must use the published host port.
- The network and firewall must allow the connection.
- The app needs connection retries.

Same-node services use Docker's project network. Cross-node service names are hosts-file entries and do not encrypt traffic, see [Cross-node service names](networking.md#cross-node-service-names).

To move a stateful service, back up and restore its data. Tug requires an explicit `tug deploy --move <service>` for guarded moves and holds detected writers until restore or release, see [Move the database](migration.md#move-the-database). Test recovery before moving data.
