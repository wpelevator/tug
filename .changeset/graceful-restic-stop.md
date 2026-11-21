---
'@wpelevator/tug': patch
---

A cancelled, timed-out or stalled backup job no longer kills restic outright: tug sends it SIGINT and waits up to 20 seconds so it releases its repository lock before the helper container is removed, and does the same for helpers left over when an agent or control restarts. A `forget --prune` killed while it held the exclusive lock used to leave a stale lock that blocked every later backup. The stall limit for a restic command is now 15 minutes, longer than the 10 minutes restic waits for a lock, so waiting for a lock is not reported as a stall.
