---
'@wpelevator/tug': major
---

Tug 1.0.0. The CLI, the `x-tug` Compose extension (with its published schema), the wire protocol under `/api/v1` and `/agent/v1`, the credential and backup formats and the image and package names are now public contracts that change compatibly within a major version (see Releases in the docs). Control and agent databases carry a schema version and upgrade in place through migrations: a database that holds data is copied to `<file>.pre-v<N>.bak` before the first migration, a database from a newer Tug is refused untouched (including as a restore snapshot), and databases from every release since 0.2 upgrade. Control, CLI and agents now follow semver for version skew: a client is refused only when it is on a newer major, so from 1.0 a newer minor works with an older control, and a command that needs a newer control reports the missing route with the control's version.
