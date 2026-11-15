---
"@wpelevator/tug": patch
---

Fix the MariaDB and PostgreSQL restore recipes in the backup docs, which failed `tug deploy` because of an unescaped `$`. Document host firewalls and the Let's Encrypt retry delay for ingress, the control restart after a restore, and add the 3.0.0 real-host results.
