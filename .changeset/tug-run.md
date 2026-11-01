---
'@wpelevator/tug': minor
---

Add `tug run SERVICE -- command`: a one-off container with the service's image, environment, secrets, network and mounts, removed afterwards, returning the command's exit code and recorded as a `job.run` event.
