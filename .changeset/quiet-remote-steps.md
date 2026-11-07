---
'@wpelevator/tug': minor
---

Quieter, keyboard-driven terminal output. Remote install steps (Docker, preflight, image transfer, control and agent install) no longer stream Docker's per-layer pull lines; they show named stages, a live status line in a terminal and the last output lines only on failure, and the new `--verbose` flag (or `TUG_VERBOSE=1`) streams everything. Selection menus use arrow keys and space to toggle instead of numbers. Errors from a command that already ran no longer end with the usage hint, and a missing credential names a parent directory's config file.
