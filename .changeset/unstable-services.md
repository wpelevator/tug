---
'@wpelevator/tug': minor
---

`tug status` and `tug tui` no longer show a crash-looping service as `serving`. After each reconcile the agent reports a service whose container Docker keeps restarting, or that exited with an error and stays down, with a new optional `unstable` field in its service state (additive to the status report), and the services list shows `unstable` with the exit code. The deployment still reads as succeeded.
