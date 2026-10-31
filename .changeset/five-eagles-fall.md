---
'@wpelevator/tug': patch
---

Use Node's built-in SQLite for control and agent state, removing SQLite native-addon installation and its Docker build toolchain. Node >= 22.18 remains supported. Snapshot creation and restore integrity checks run synchronously; large databases can briefly pause control traffic.
