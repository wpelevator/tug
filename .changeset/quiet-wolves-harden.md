---
'@wpelevator/tug': patch
---

Security fixes with no change to the wire protocol or persisted formats. A malformed WebSocket upgrade target no longer crashes control; an event `limit` is clamped into 1–500 (a missing or non-numeric one is 100); the command of a one-off `tug run` is hidden from `read` credentials in `GET /api/v1/events` and the watch stream (the stored audit record is unchanged, and `deploy` and `admin` still see it); control and agents never route to or allocate Caddy's loopback management ports 2019 and 2021; terminal escape sequences are stripped from human-readable event output; and a hostname conflict no longer names a project outside the caller's scope.
