---
'@wpelevator/tug': patch
---

Correct the 3.0 upgrade steps in `docs/releases.md`. A 2.x CLI refuses to run against a 3.0 control, and `deploy --dry-run` needs a 3.0 control, so the steps now start with `tug upgrade` and end with updating the CLI in CI.
