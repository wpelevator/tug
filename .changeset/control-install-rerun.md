---
"@wpelevator/tug": patch
---

`control-install` can be run again over a running control to upgrade it. Its port preflight no longer fails when the port is held by the existing `tug-control-control-1` container; any other listener still fails it.
