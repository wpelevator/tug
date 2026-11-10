---
'@wpelevator/tug': minor
---

Add `tug control upgrade`, `tug node upgrade` and `tug upgrade`. `control upgrade` replaces the control container over SSH with another image and keeps the port, advertised URL and extra names it runs with (read from the container, so nothing is passed again), tags the previous image as `tug:rollback` (`--rollback` goes back), verifies the CA did not change and waits for control to answer. `node upgrade` replaces an enrolled agent in place with its key, address, labels and connect-only URL, skips nodes already on the image and refuses `--to` a version newer than control. `tug upgrade` runs both in the right order using the new `controlSsh` config key. Version-skew errors now name `tug control upgrade`, and `control setup` over an existing control notes which of its settings the run changes.
