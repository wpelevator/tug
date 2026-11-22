---
'@wpelevator/tug': minor
---

`tug restore list` now also lists what restores leave behind: scratch volumes still on their node and safety snapshots still in the repository. New `tug restore remove <id>` removes the scratch volume or the safety snapshot of that restore, and `tug restore remove --expire-safety <age>` forgets the safety snapshots of restores older than the age. Both are admin only and audited, and a safety snapshot is never removed from an append-only destination (the request is refused with the reason). Agents get two new command types, `restore.remove` and `backup.forget`, so upgrade nodes first.
