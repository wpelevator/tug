---
"@wpelevator/tug": minor
---

Add `tug control stop` and `tug control restart`, which stop or restart the control container over SSH without touching its volume, image or published ports, and make `tug control restore` name `tug control restart` as the next step. Every command that runs SSH now explains `Host key verification failed` and prints the `ssh-keygen -R <host>` remedy instead of reporting a connection failure, and never edits `known_hosts`.
