---
'@wpelevator/tug': patch
---

Close security audit findings: node `address`/`publicAddress` are validated, backup credentials are released only while the project is placed on the node, deployments refuse disabled or unknown placement nodes, wildcard ingress hostnames conflict with other projects' hosts, source uploads exclude the resolved credential file and support `.dockerignore` character classes, `tug inspect` redacts environment values, and child processes have a deadline and bounded output.
