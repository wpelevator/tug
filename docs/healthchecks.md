# Health checks and safer deployments

A health check tells tug when a service is ready to serve. Add one to every service.

<!-- tug-values: DB_ROOT_PASSWORD -->
```yaml
# yaml-language-server: $schema=https://unpkg.com/@wpelevator/tug/x-tug.schema.json
services:
  db:
    image: mariadb:11.4.8
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    x-tug:
      health:
        type: tcp
        port: 3306
  web:
    image: nginx:1.27-alpine
    depends_on:
      db:
        condition: service_healthy
    x-tug:
      health:
        type: http
        port: 80
        path: /
```

Set `DB_ROOT_PASSWORD` with `tug secret set DB_ROOT_PASSWORD` before deploying. The nginx service here does not use the database, and the [WordPress example](https://github.com/wpelevator/tug/blob/main/examples/wordpress/README.md) shows an app that does.

During a deployment the agent checks the container and reports failures to control. Ingress uses serving endpoints, and a rolling deployment waits for a healthy replacement before switching traffic. Without `x-tug.health`, tug runs no readiness probe for that service, and a running container alone does not prove the app is ready.

## Choose a check

| Type | What it tests | Use it for |
| --- | --- | --- |
| `docker` | The container runs and, if the image defines a Docker `HEALTHCHECK`, that it reports healthy. Without one, only that the container runs | Images that already define a meaningful health check |
| `tcp` | The agent can connect to a port on the container IP. It does not prove a query succeeds | A database or protocol server where an open port is enough |
| `http` | An HTTP request to the container IP returns 2xx after redirects | A web app with a dedicated readiness endpoint |

| Setting | Default |
| --- | --- |
| `retries` | `10` |
| `interval` | `2s` |
| `timeout` | `2s` |

Increase the interval or retries for a slow-starting app. Field details are in [Compose extensions](compose.md#health).

- **HTTP checks** use the container IP and port, not the public hostname or ingress. Pick an endpoint that returns 2xx without relying on public redirects.
- **What to check.** A process-only endpoint can pass while a database or migration is broken, so decide which dependencies must be ready before traffic is sent.
- **During a restore.** A check that depends on a service stopped for a restore makes its own service unhealthy for that time. Use a check that does not depend on the writer.

## Dependencies and failures

`depends_on` orders services on the same node. `condition: service_healthy` waits for the dependency's `x-tug.health`, or its Docker health check if there is no tug check. With neither, it checks only that the dependency container runs. Apps still need connection retries, particularly across nodes or when a dependency restarts later. Rolling services have extra ordering limits, see [Rolling rollouts](compose.md#rolling-rollouts).

If a check fails, `tug deploy` reports the error, and `tug status`, `tug events` and `tug logs <service>` help you diagnose it. Check the container port and path, the app's startup time and the service logs. A passing TCP check does not verify credentials or data. See [Troubleshooting](troubleshooting.md).

## Roll forward safely

The default rollout recreates a changed service, which can interrupt traffic. A stateless service behind managed ingress can opt into `x-tug.rollout.strategy: rolling`. tug then starts and checks the new revision before ingress switches to it, and drains the old one. Rolling needs ingress, an explicit tug health check and exactly one published port. It is not a database failover mechanism, and overlapping revisions can share mounted volumes. Review the [requirements and limits](compose.md#rolling-rollouts) first.

`tug rollback` returns a project to a previous deployment, and top-level `x-tug: { rollback: auto }` rolls back eligible failures on its own. Rollback cannot undo database writes or schema changes, so plan compatible migrations separately. See [Automatic rollback](compose.md#automatic-rollback).
