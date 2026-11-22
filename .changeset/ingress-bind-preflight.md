---
'@wpelevator/tug': patch
---

`tug node add --ingress` checks ports 80 and 443 before installing and refuses a host where another process holds one. An ingress node whose Caddy exits or restarts in a loop now reports why as its ingress failure.
