---
'@wpelevator/tug': major
---

`tug ps`, `tug events` and `tug doctor` print a readable summary by default, like `tug status`, and the JSON they used to print only with `--json`. Scripts that parse their output must add `--json`; the JSON is unchanged. `ps` shows one row per container (service, state, status, image with a shortened digest, published ports, container name), `events` a table of time, level, type, actor and message (plus project with `--all`), and `doctor` one `ok`, `warn` or `FAIL` line per check grouped by this machine, control and each node. `tug doctor` now also exits nonzero when any check fails, with or without `--json`, so it can serve as a readiness probe.
