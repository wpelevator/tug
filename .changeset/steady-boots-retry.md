---
'@wpelevator/tug': patch
---

Retry network steps in the Docker bootstrap and name the stage that failed, so an unattended cloud-init install survives a briefly unreachable mirror or a first-boot package lock and a failed one shows where it stopped.
