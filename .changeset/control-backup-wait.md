---
'@wpelevator/tug': patch
---

`tug control backup` no longer fails with a raw `UND_ERR_HEADERS_TIMEOUT` after 300 seconds when the control repository is locked. The CLI now waits up to 35 minutes for control's answer (control's 30 minute backup limit, which includes the ten minute wait for a repository lock, plus slack; `TUG_CONTROL_BACKUP_WAIT_MS` changes it), and if control still has not answered it says the backup may still be running or waiting for the lock and that `tug backup list` shows the outcome. No change to the API: an older CLI keeps its 300 second wait.
