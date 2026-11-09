---
'@wpelevator/tug': patch
---

Three fixes found by running control backup on QEMU VMs with real restic. A bucket created while restic was still retrying no longer leaves the first control backup refused: restic's retry notices (which said the bucket did not exist) are history, and only its final message decides whether a repository is missing and should be initialized. A backend that only errors (a missing bucket, a refused login, an unreachable store) no longer makes a control backup, listing or restore-fetch run for up to 30 minutes with progress ticks: after two minutes of nothing but retry notices (`TUG_CONTROL_BACKUP_STALL_MS`) it fails with restic's final message, a retry count and the last cause, and `tug backup list` shows that instead of the whole retry log. Restoring a control backup now also closes the workload backup runs it carried (queued ones are missed, running ones fail) along with the commands it already retired, so a queued run no longer stays queued for ever.
