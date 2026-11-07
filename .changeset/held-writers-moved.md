---
'@wpelevator/tug': patch
---

`tug deploy --move` now holds a writer that moved together with its database. A project such as WordPress with its own volume has to acknowledge both services, and that used to exempt the writer from the hold, so it started against the empty database and served a fresh installer until the restore. The hold is placed on every writer of a moved service, and the replacement-node procedure says to deploy with `--move`.
