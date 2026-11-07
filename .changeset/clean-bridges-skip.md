---
'@wpelevator/tug': patch
---

`tug node add` no longer offers the addresses of Docker and CNI bridge interfaces (`docker0`, `br-<id>`, `veth*`, `cni0`) when asking which address other nodes should use. They only reach containers on the host, and on a host that already runs Tug they crowded out the real choices.
