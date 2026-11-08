---
'@wpelevator/tug': minor
---

Map extra hostnames onto a service's ingress route without a deployment, for WordPress multisite domain mapping: `tug domain add <host> --service <service>`, `tug domain list` and `tug domain remove <host>`, backed by `GET`/`POST /api/v1/domains` and `DELETE /api/v1/domains/:host` (the `deploy` role, scoped to the project). Mapped domains share the route's upstreams and TLS handling, survive redeploys and rollbacks, and obey the same cross-project ownership rule as declared hosts, which `deploy` and `rollback` now also enforce against mapped domains. Domains are stored in a new control database table (schema version 2); the previous schema is upgraded in place, and the pre-upgrade copy is kept as `<file>.pre-v2.bak`.
