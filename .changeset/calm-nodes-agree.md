---
'@wpelevator/tug': patch
---

`tug node replace` and `tug node repair` accept `-y` like `tug node add`. A control or agent that finds a database from a newer Tug prints one `error:` line with the remedy instead of a stack trace. `--build-local-image` runs the image under `<tag>-<image id>` on the host, so rebuilding `tug:local` no longer leaves the running control or agent container showing an image ID.
