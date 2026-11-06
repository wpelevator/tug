---
'@wpelevator/tug': patch
---

The `x-tug-client-version` header is now sent only to the control, no longer to the application containers the agent health-checks. A control that refused a newer CLI is judged again on the next request instead of being remembered as agreed. An agent that is newer than its control now logs the control's refusal with the remedy and keeps its containers running, and the docs say to roll agents back together with the control. `tug init` no longer fails when the credential it replaces has an unreadable CA, and CA trust errors are recognised only by their exact OpenSSL wording.
