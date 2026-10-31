---
"@wpelevator/tug": minor
---

Add opt-in zero-downtime rolling rollouts: a service with `x-tug.rollout: { strategy: rolling, drain: 30s }`, an ingress and a health check starts each new revision next to the old one on its own host port (`TUG_ROLLOUT_PORTS` on the agent), switches the Caddy ingress once it is healthy and removes the old revision after the drain. A revision that fails its health check is removed and the old one keeps serving. `recreate` stays the default and behaves as before.

Add `x-tug: { rollback: auto }` at the top level of a Compose file to roll a failed deployment back automatically to the previous succeeded one (recorded as a `deployment.auto_rollback` event, never applied to rollback deployments). Deployment versions starting with `rollback-` are now reserved.
