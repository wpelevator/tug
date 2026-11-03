---
'@wpelevator/tug': minor
---

`tug status` now prints a readable summary by default and `--json` prints the raw JSON (`--human` is removed). `tug deploy` prompts to generate or enter Compose variables that no secret, environment or `.env` provides, and fails with a clear error in CI or without a terminal.
