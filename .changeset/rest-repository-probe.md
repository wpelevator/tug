---
'@wpelevator/tug': patch
---

Decide whether a backup repository is missing from restic's exit code 10 instead of its message, in control and on nodes. Control's own backup now creates the `_control` repository on a REST server, and a mistyped S3 bucket fails instead of being created. `backup.check` no longer initializes a repository. A wrong repository password and a restic older than 0.17 are named in the error. `sftp:` and `rclone:` destinations are rejected with the reason. `tug backup password` and the repository password endpoint work before a project is deployed and say whether it has been, and `tug backup run` explains that a project that was never deployed has no backup targets yet.
