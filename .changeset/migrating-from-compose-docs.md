---
'@wpelevator/tug': patch
---

Document moving a Docker Compose app to tug (docs/migrating-from-compose.md), the health check opening (a check is not required for every service; `host` and `expect`), and the CI steps (`--raw` into `gh secret set`, and the `@wpelevator/tug` package name, since the unscoped `tug` on npm is another project).
