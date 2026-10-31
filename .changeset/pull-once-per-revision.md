---
"@wpelevator/tug": patch
---

Agents pull published `image:` services only when a deployment revision is new to the node, instead of on every poll. Before, a tag that moved upstream (for example `mariadb:11`) was pulled and the container recreated within seconds without a deploy.
