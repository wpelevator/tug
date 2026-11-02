---
'@wpelevator/tug': minor
---

`controlUrl` is the one name for where the control plane is. `--advertise-url` and `TUG_ADVERTISE_URL` are removed: `tug control-install` advertises `--control-url`, `TUG_CONTROL_URL`, then the config file's `controlUrl` (else the SSH target's host and `--port`) and prints which it used, and the control container reads its own address from `TUG_CONTROL_URL`. Other commands still treat the same setting as the connect target, falling back to the URL in the credential. Clients verify a name generated from the CA, so the value is only an address.
