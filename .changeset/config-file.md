---
'@wpelevator/tug': minor
---

Add a committable CLI config file (`tug.yml`, YAML or JSON) that records the control URL, default project, `deploy` defaults and the servers to install, where each key is the camelCase of the flag it defaults and flags always win. `node-install --name app1` reads the SSH target and install flags from `nodes.app1`. The API token is no longer read from the tracked config: it lives in the git-ignored `tug.local.yml` overlay (or `TUG_TOKEN`), `tug init` writes it there, and the config key is renamed from `operatorToken` to `token`. Source uploads now also exclude the overlay and the root config file.
