---
'@wpelevator/tug': patch
---

The `x-tug-client-version` header is now sent only to the control, no longer to the application containers the agent health-checks. A control that refused a newer CLI is judged again on the next request instead of being remembered as agreed. An agent that is newer than its control now logs the control's refusal with the remedy and keeps its containers running, and the docs say to roll agents back together with the control. Version skew now follows semver: the control refuses a client only when it is on a newer compatibility key (the major, or `0.minor` before 1.0), so from 1.0 a client with a newer minor of the same major is served, and a CLI ahead of its control gets a 404 explained by the version stamp. `tug init` no longer fails when the credential it replaces has an unreadable CA, and CA trust errors are recognised only by their exact OpenSSL wording.
