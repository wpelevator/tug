# Compose extensions

Launchpad deploys standard Docker Compose files with an `x-launchpad` extension on services and volumes for placement and health checks. Control generates a per-node Compose file containing only the services and volumes placed on that node, with `x-launchpad`, `build`, `deploy` and `container_name` removed (and `extra_hosts` added for services on other nodes) and `image` set to the built or declared image.

## Services

```yaml
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8088:80"
    environment:
      SAMPLE_SECRET: ${SAMPLE_SECRET:-not-set}
    x-launchpad:
      placement:
        nodes: [vps-a]
      health:
        type: http
        port: 80
        path: /
```

- `placement.nodes`: node names that run the service. Required on every service when more than one node is registered. With a single node, services without placement go to that node.
- `replicas`: optional; in this version it must equal the number of placement nodes (one container per node).
- `ingress`: publishes the service on a hostname through the managed Caddy edge (see [Networking](networking.md#layer-c-ingress-and-tls)). `host` is a fully qualified hostname, unique across the file; `port` is the service's container port or published host port and must appear in `ports`; `tls` is `auto` (default, ACME), `custom` or `off`. `tls: custom` also needs `cert` and `key`, the names of project secrets holding the PEM certificate chain and private key, which must exist before you deploy.
- `health`: checked by the agent after `docker compose up -d`; the service is `serving` only once it passes.
  - `type: docker` waits for the container to be running and, if it defines a Docker `HEALTHCHECK`, healthy.
  - `type: tcp` connects to `port` on the container IP.
  - `type: http` requests `http://<container-ip>:<port><path>` (defaults `80` and `/`) and expects a 2xx response after following redirects.
  - `interval` (default `2s`), `timeout` (default `2s`) and `retries` (default `10`) accept numbers in milliseconds or `ms`/`s`/`m` suffixes.

```yaml
    x-launchpad:
      placement:
        nodes: [app1]
      ingress:
        host: app.example.com
        port: 80
        tls: auto            # auto | custom | off
```

Services that run on a different node than a given service are reachable from it by name (`db` or `db.<project>.launchpad`) when the mesh and service DNS are on, as long as the target publishes its port. Control injects these names into the per-node Compose file as `extra_hosts`; see [Networking](networking.md#layer-b-service-dns).

Services with `build:` are built by control from the uploaded source tarball and tagged `<registry>/<project>/<service>:<version>`.

## Volumes

```yaml
volumes:
  cache-data:
    x-launchpad:
      type: local
      persistent: true
      placement:
        nodes: [vps-c]
```

Control records volumes per project. A volume is included in a node's Compose file only when a service on that node uses it and, if the volume has `placement.nodes`, the node is listed. `launchpad volume:rm` refuses to remove a persistent volume without `--delete-data`, and refuses any volume still referenced by a service in the current deployment. `--delete-data` queues a `docker volume rm` on the volume's placement node.

## Secrets in services

Reference secrets through `environment`, either as keys (`DB_PASSWORD:` or `- DB_PASSWORD=...`) or as `${NAME}` / `${NAME:-default}` substitutions. Only referenced secrets are released to a node. Set them with `launchpad secret:set NAME`.

## Not supported

- `container_name` (Compose project names isolate containers per project).
- `deploy` (Swarm semantics).
