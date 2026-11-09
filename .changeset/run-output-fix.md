---
'@wpelevator/tug': patch
---

`tug run` no longer loses output. The one-off container's log was attached after it started with the default 100-line tail, so a command that wrote more than about 100 log lines before Tug attached lost the start of its output; and the container was removed 1.5 seconds after it exited even when a slow reader had not received the end yet. Tug now replays the whole log and removes the container only once its output has been read.
