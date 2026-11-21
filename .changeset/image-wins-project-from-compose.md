---
'@wpelevator/tug': major
---

Three defaults change so an existing Compose file deploys unchanged; see "Upgrading to 4.0" in docs/releases.md.

- A service that names both `build:` and `image:` now deploys its `image:` (pinned to a digest like any published image) and is not built, so one Compose file serves `docker compose up` locally and images built in CI. `tug deploy --build` builds such services for one deploy, and `x-tug.build: true` on a service always builds it. A service with only `build:` builds as before.
- The default project comes from the Compose file instead of `site`: `--project`, `TUG_PROJECT`, `project:` in `tug.yml`, the Compose `name:`, then the directory of the Compose file. `tug init` and `tug control setup --import` write the result to `tug.yml`. Run `tug init` or set `project: site` to keep addressing the old project.
- A bare environment entry (`KEY:` or `- KEY`) is a value from control like `${KEY}`: it is listed in `Values:` and the dry-run table, and the deploy fails when control does not hold it, instead of starting the container with an empty value. Write `KEY: ""` for a literal empty string.
