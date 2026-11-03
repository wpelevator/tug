---
'@wpelevator/tug': minor
---

Add `tug node remove <node> --teardown` to clean a retired host over SSH (volumes are kept unless `--delete-data`), make `tug restore` find writers on other nodes from host names in environment variables, and make `tug deploy` refuse to start a service with data empty on another node unless you pass `--move <service>`, which holds the services that write to it until the restore or `tug hold release`.
