---
'@wpelevator/tug': patch
---

`tug node list` now shows a node as `stale` when its last contact is outside the stale window, matching `tug status`, instead of showing the status stored the last time `status` was read. `tug node replace` and `tug node repair` accept `-y` like `tug node add`. A control or agent that finds a database from a newer Tug prints one `error:` line with the remedy instead of a stack trace. `--build-local-image` runs the image under `<tag>-<image id>` on the host, so rebuilding `tug:local` no longer leaves the running control or agent container showing an image ID.
