---
'@wpelevator/tug': minor
---

Verify the control plane by a generated name instead of its address. Control's server certificate now carries `control-<hash>.tug`, derived from its CA, and clients recompute it from the CA they pin, so credentials no longer depend on the IP or DNS name control is reached at: bare-IP installs work, and moving control needs no new credentials. `TUG_PUBLIC_URL` and `--public-url` are renamed `TUG_ADVERTISE_URL` and `--advertise-url`; the value is now only the default connect address written into credentials. Adds a Getting started guide.
