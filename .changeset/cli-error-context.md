---
'@wpelevator/tug': patch
---

CLI failures say more: a network error names its cause instead of only `fetch failed`, a deploy whose wait is interrupted names the deployment and `tug deploy cancel <id>` (as does the refusal when another deploy is still rolling out), and `tug setup` and `tug node add` stop before touching the host when the release image for this CLI version is not published yet.
