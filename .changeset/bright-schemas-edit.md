---
'@wpelevator/tug': minor
---

Ship the `x-tug` schema as JSON Schema for editors: `x-tug.schema.json` is published with the package and at `https://unpkg.com/@wpelevator/tug/x-tug.schema.json`, and linking it from a Compose file (`# yaml-language-server: $schema=...` or a JetBrains JSON Schema mapping) gives autocomplete, hover documentation and inline findings for every `x-tug` field in VS Code, JetBrains and any schema-aware YAML language server. The schema is generated (`npm run schema`) from the validator's rule set — `x-tug`, volume `x-tug`, backup keys, retention keys, service and volume key allowlists are tested against the constants `tug lint` and deploy enforce, and a drift test fails when the committed file no longer matches — so an editor squiggle and a `tug lint` line never disagree. `ajv` was added as a development dependency to stand in for the editors the schema targets; it is not bundled.
