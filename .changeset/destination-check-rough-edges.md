---
'@wpelevator/tug': patch
---

`tug backup destination set` no longer has its check refused with "control is backing itself up" when control's own backup is still writing to the previous destination: replacing or removing the destination now cancels that backup. A destination check against an unreachable store fails after 45 seconds with restic's own error (such as `dial tcp …: i/o timeout`) instead of "restic did not finish within 120s".
