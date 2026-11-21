---
'@wpelevator/tug': minor
---

Add `tug deploy --retry`. After a deployment fails its health check, fix the cause (an empty database, a config value) and run `tug deploy --retry` to try again without a new deployment: control publishes the same desired state under a new revision id, agents forget the rejected revision and pull and health-check it again, and the deployment goes back to `rolling_out` and records a `deployment.retry` event. `tug restart` does not do this: it restarts the running container and leaves a rejected rolling revision rejected. Adds `POST /api/v1/deployments/retry` (role `deploy`).
