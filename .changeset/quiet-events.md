---
"@wpelevator/tug": patch
---

Agents now report a service's lifecycle events only when something changes (a new revision, changed secrets or configuration), plus one event when an apply fails and one when it recovers, instead of four events per service on every poll. Control deletes events older than 30 days and keeps at most 100,000 (`TUG_EVENT_RETENTION_DAYS`, `TUG_EVENT_MAX_ROWS`), so `tug events` shows deployments, rollbacks and failures again.
