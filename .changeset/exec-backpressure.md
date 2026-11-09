---
'@wpelevator/tug': major
---

`tug exec` and `tug run` now move large data in both directions. Stdin and stdout/stderr are flow-controlled end to end (CLI, control and agent) with a 512 KiB window per session and direction: a slow reader slows the sender instead of failing the session, so database dumps and site archives can be piped through `tug exec -i` without the earlier `buffer limit exceeded` errors and truncated downloads. The 2.0 CLI, control and agent add new live frames (`live.ack`, `live.stdin-ack` and a `flow` flag on `live.started`), so upgrade all three together; a 1.x agent behind a 2.0 control keeps the old bounded buffer and must be upgraded to get unbounded transfers.
