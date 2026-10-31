---
"@wpelevator/tug": patch
---

`--build-local-image` now builds for the target host's architecture, read with `uname -m` over SSH, instead of the machine running the CLI. Before, installing an amd64 VPS from an arm64 Mac produced an image that failed with `exec format error`.
