---
'@wpelevator/tug': minor
---

Flags that take several values now also accept a comma-separated list, alongside repeating the flag, and the two mix: `tug deploy --move db,web`, `tug restore run db --writers web,worker`, `tug credential create ci --role deploy --project site,blog`, `--label gpu,eu` on the node commands, `--extra-san` on `control setup` and `--env` on `backup destination set`. Spaces around items are ignored. The values are names, so a node label can no longer contain a comma on the command line. The config file keeps taking YAML lists.
