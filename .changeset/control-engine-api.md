---
'@wpelevator/tug': patch
---

Control asks the Docker Engine API instead of running the `docker` CLI for the version check, image inspection and image removal. The diagnostics `docker` check now proves the engine socket answers rather than that a `docker` binary is present in the control container; `docker build`, `save`, `load`, `tag`, `manifest inspect` and `builder prune` still use the CLI.
