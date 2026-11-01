---
'@wpelevator/tug': patch
---

`tug control-install` no longer requires `--advertise-url`: it defaults to the SSH target's host and the published port (`https://<host>:8443`) and prints the choice. Pass the flag to advertise a different address.
