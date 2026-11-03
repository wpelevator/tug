# Health checks and safer deployments

A health check tells Tug when a service is ready to serve. During a deployment, the agent checks the container and reports failures to control. Ingress uses serving endpoints, and a rolling deployment waits for a healthy replacement before switching traffic. If you omit `x-tug.health`, Tug does not run a Tug readiness probe for that service; a running container alone does not prove the application is ready.

## Choose a check

| Type | What it tests | Useful for |
| --- | --- | --- |
| `docker` | The container is running and, if present, its Docker `HEALTHCHECK` reports healthy. Without a Docker health check it only verifies the container is running. | Images that already define a meaningful health check. |
| `tcp` | The agent can connect to a port on the container IP. | A database or protocol server when a port-open check is sufficient. It does not prove a query will succeed. |
| `http` | An HTTP request to the container IP returns 2xx after redirects. | A web app with a dedicated readiness endpoint. |

For example, add a TCP check to a database and an HTTP check to your web service:

```yaml
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

Set `DB_ROOT_PASSWORD` with `tug secret set DB_ROOT_PASSWORD` before deploying. This example illustrates health checks and dependency ordering, not a complete application using the database. See the [WordPress example](../examples/wordpress/README.md) for a working app and database.

Checks default to 10 attempts, a two-second interval and a two-second timeout. Increase the interval or retries for a slow-starting application. HTTP checks use the container IP and port, not the public hostname or ingress; select an endpoint that returns 2xx without relying on public redirects. A process-only endpoint can pass while a database or migration is broken; decide which dependencies must be ready before traffic is sent. Conversely, a check that depends on a service stopped during restore can make its own service unhealthy during that restore. Field details are in the [Compose reference](compose.md#services).

## Dependencies and failures

`depends_on` orders services on the same node; `condition: service_healthy` waits for the dependency's `x-tug.health`, or its Docker health check if there is no Tug check. Without either, the fallback checks only that the dependency container is running. Dependency order is not a replacement for connection retries, particularly across nodes or when a dependency later restarts. Rolling services have additional ordering limitations described in [Rolling rollouts](compose.md#rolling-rollouts).

If a check fails, `tug deploy` reports the error and `tug status`, `tug events` and `tug logs <service>` help diagnose it. Check the container port and path, the application's startup time and the service logs. A successful TCP check does not verify credentials or application data. See [Troubleshooting](troubleshooting.md).

## Roll forward safely

The default rollout recreates a changed service, which can interrupt traffic. A stateless service behind managed ingress can opt into `x-tug.rollout.strategy: rolling`; Tug starts and checks the new revision before ingress switches to it, then drains the old one. Rolling requires ingress, an explicit Tug health check and exactly one published port. It is not a database failover mechanism, and overlapping revisions can share mounted volumes. Review [rolling requirements and limits](compose.md#rolling-rollouts) before enabling it.

`tug rollback` returns a project to a previous deployment; top-level `x-tug: { rollback: auto }` opts into automatic rollback for eligible failures. It cannot undo database writes or schema changes. See [automatic rollback](compose.md#automatic-rollback) and plan compatible migrations separately.
