---
'@wpelevator/tug': major
---

`tug backup list --check` now exits nonzero when nothing is protected: when no backup destination is configured, even if the project has no targets, and when the project has no enabled backup target. Before, a project with no targets and no destination printed a warning and exited `0`, so a cron job or monitor that checks only the exit status stayed green before backups were set up. For a project that holds no data, pass `--allow-empty` to accept it without targets; a destination is still required, because control backs itself up there. The TUI and other summary views are unchanged: a project without targets is not a problem there.
