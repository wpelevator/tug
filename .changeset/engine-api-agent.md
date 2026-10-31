---
"@wpelevator/tug": minor
---

The agent reconciles containers through the Docker Engine API instead of the `docker compose` CLI (M14). `tug deploy` normalizes the Compose file with `docker compose config` on the operator machine (control secrets travel as sentinels), control validates a supported-key allowlist, nodes no longer need the Compose plugin, secrets are no longer written to `.env`, and `exec -t` gets a real PTY with resize. Tug now names its own network, volumes and containers (`tug_<project>`), so volumes created by earlier versions are not reused.
