---
'@wpelevator/tug': patch
---

An in-place restore of a volume no longer risks the live data when the repository cannot be read. It restores into a directory inside the volume, verifies every file and only then replaces the content, so a failed restore leaves the volume as it was (it needs free space for a second copy of the snapshot while it runs). A restore that restores nothing for ten minutes now fails as `interrupted` with the reason instead of staying in `restoring` until the job limit, and cancelling a job or reaching its time limit now stops a restic command that never returns. The safety backup taken before an in-place restore no longer applies retention: it used to forget the earlier snapshot of the same day that the restore was about to read, so restoring a backup taken earlier today failed with `snapshot not found` and left the writers stopped.
