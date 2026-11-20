---
'@wpelevator/tug': patch
---

Polish for first deploys: `tug deploy` no longer warns that a service bind-mounting the Docker socket is tied to one host (every node has it), the ignored `.env` note is one short line with a count and the import command, and the `tug node add` address prompt explains that `none` is right for a single node.
