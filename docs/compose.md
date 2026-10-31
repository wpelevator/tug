# Compose extensions

Launchpad deploys standard Docker Compose files with an `x-launchpad` extension on services and volumes for placement and health checks. Control generates a per-node Compose file containing only the services and volumes placed on that node, with `x-launchpad`, `build`, `deploy` and `container_name` removed and `image` set to the built or declared image.

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
- `health`: checked by the agent after `docker compose up -d`; the service is `serving` only once it passes.
  - `type: docker` waits for the container to be running and, if it defines a Docker `HEALTHCHECK`, healthy.
  - `type: tcp` connects to `port` on the container IP.
  - `type: http` requests `http://<container-ip>:<port><path>` (defaults `80` and `/`) and expects a 2xx response after following redirects.
  - `interval` (default `2s`), `timeout` (default `2s`) and `retries` (default `10`) accept numbers in milliseconds or `ms`/`s`/`m` suffixes.

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
