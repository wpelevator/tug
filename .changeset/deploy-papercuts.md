---
"@wpelevator/tug": minor
---

Catch deploy problems earlier and report them more clearly. Control refuses a deploy before the build when another project's current deployment publishes the same host port on the same node address, naming the project, node, address and port, and `tug deploy --dry-run` runs the same check through a new route, `POST /api/v1/deployments/check` (a newer CLI against an older control reports the missing route). A missing value that sits in an `x-tug.backup` field now says it may be a container variable that needs `$$` and shows the corrected line. A failed http health check names the full URL the agent requested, with the container address, path and query, and the last status or connection error. The deploy summary and `tug status` show the deployment id when two deployments carry the same version label, which the default `git-<Compose hash>` label does for a changed build context, secret or variable.
