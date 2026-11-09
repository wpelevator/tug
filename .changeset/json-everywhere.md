---
'@wpelevator/tug': minor
---

Every command that produces a result now takes `--json`. Commands that already printed JSON accept the flag and print the same thing, so a script can pass it everywhere (`tug secret list --json` used to fail with an unknown option). The commands that printed a human summary gain a JSON form: `init`, `backup run`, `backup list`, `restore run` and `restore list`. `exec`, `run` and `logs` write container output unchanged and still take no `--json`.
