---
'@wpelevator/tug': patch
---

Config file keys now apply as defaults to every command that has the matching flag, and a flag on the command line always wins: `wait` also covers `backup-run` and the node install commands, `address`, `publicAddress` and `label` reach `node-replace-identity` and `node-repair-identity`, and `mesh`, `installDocker` and `image` from `nodeDefaults` reach `control-install`. A test checks that each key's command list matches the options the commands really have. In batch mode (`--all`) the node commands print only the final per-node results.
