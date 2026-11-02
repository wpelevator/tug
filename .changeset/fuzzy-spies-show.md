---
"@wpelevator/tug": patch
---

Use `controlUrl` from the YAML or JSON config as the default advertised address for `control-install`, with `--advertise-url` taking precedence. Apply all per-node settings consistently in batch identity commands and preserve explicit flag overrides.
