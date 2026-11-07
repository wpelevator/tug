# Service placement and scaling

With one registered node, a service with no placement runs there. Once multiple nodes are registered, each service must select explicit nodes, labels or `global: true`. Adding a node does not automatically move a deployed service, copy its data or provide failover. Placement is resolved at deploy or scale time, not continuously rescheduled when a node fails.

## Spread the first service across two nodes

This continues from [Deploy your first service](getting-started.md). The nginx service is stateless; both VPSes can run an independent copy. The example keeps the tutorial's public port, so restrict TCP 8080 to your computer on both VPSes with provider firewalls. For a public site, use [ingress and HTTPS](networking.md#layer-b-ingress-and-tls) instead.

1. Give the new VPS a reachable address on your private network. Make sure it can connect to control on TCP 8443. To use services across nodes or ingress on one node for services on the other, both hosts must have mutually reachable private addresses and appropriate firewall rules. Tug does not create or encrypt this network. See [Networking](networking.md#bring-your-own-network).
2. Add the new agent, replacing the SSH address and private address with yours. With an interactive terminal Tug offers Docker installation and shows the plan before acting.

```sh
tug node add root@198.51.100.7 --name app2 --address 10.0.0.7
tug node list
```

3. In your existing `compose.yaml`, add placement to `web`. Keep its image, port and health check:

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

4. Redeploy and check both nodes. Replace the example public IPs with the VPS addresses; the nginx welcome page should respond from each.

```sh
tug deploy
tug status
curl http://203.0.113.5:8080/
curl http://198.51.100.7:8080/
```

This places one container on each named node; it does not load-balance the two public addresses. Managed ingress can route to healthy services on multiple nodes when their workload network is reachable. Its hostname needs DNS pointing to an ingress node; see [Ingress and TLS](networking.md#layer-b-ingress-and-tls).

## Keep state on its server

A named local volume is local to a node. For an application with a database, pin the database service and its volume to the node holding the data, while choosing placement for every other service. For example, add these blocks to your existing database service and volume definitions:

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

This is a placement fragment, not a complete database Compose file. If a web service on `app2` connects to the database on `app1`, the database must publish a port on its private node address, the client must use the published host port, and the network and firewall must allow that connection. Same-node services use Docker's project network. Cross-node service names are hosts-file entries and do not encrypt traffic; see [Cross-node service names](networking.md#layer-a-cross-node-service-names). Use application connection retries.

To move a stateful service, back up and restore its data. Tug requires an explicit `tug deploy --move <service>` for guarded moves and holds detected writers until restore or release; see [Move the database](migration.md#move-the-database). Test recovery before moving data.

## Other placement options

- **Explicit nodes:** `placement.nodes: [app1, app2]` runs one copy on each listed node. Scaling stays within the named nodes.
- **Labels and replicas:** add nodes with `--label web`, then select `placement.labels: [web]` and `replicas: 2`. Tug chooses up to two matching, recently seen nodes when placement is resolved. All listed labels must match. Nodes created without the label do not match; [node labels](nodes.md#node-labels) explains how they are set.
- **Global:** `global: true` runs one copy on each matching node, or each node if no labels are specified.

`tug scale web 2` changes the current desired placement within its allowed set; the next deploy re-resolves it from the Compose file. No mode guarantees multiple copies on one node or automatically replaces a failed host. Check placement with `tug status`. The [placement reference](compose.md#services) lists the complete rules.
