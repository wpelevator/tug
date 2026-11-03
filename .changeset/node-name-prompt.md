---
'@wpelevator/tug': patch
---

`tug node add` asks for the node name in a terminal when the SSH host is an IP address, suggesting the host's own hostname; `tug node enroll` asks for `--name` too. Without a terminal `--name` is still required.
