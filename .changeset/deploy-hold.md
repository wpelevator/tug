---
'@wpelevator/tug': minor
---

New `tug deploy --hold <service>` publishes a deployment with the named services stopped, so an app does not start against an empty database before the data is imported. The hold is recorded as `deploy hold`, persists across later deploys, and a credential that may deploy can release it with `tug hold release`, while holds placed for any other reason (a `--move`) still need an admin. The migration guide now deploys with the app held, imports the data and then releases it. A service without `x-tug.health` is not probed, and a test now pins that.
