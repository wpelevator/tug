---
'@wpelevator/tug': patch
---

`tug node add` checks for a control credential before it probes the host or asks questions, and its plan says when Docker was not checked. When the new node has not reported after the wait, the result says `reporting: false` and the command exits non-zero instead of looking like a success.
