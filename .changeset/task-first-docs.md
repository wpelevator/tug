---
'@wpelevator/tug': patch
---

Reorganize the documentation by task. New pages: a documentation index, a production checklist and an upgrade guide (`docs/upgrades.md`). Troubleshooting opens with a table from symptom to fix, and the CLI, Compose, backup, networking, node, control plane and access control pages are rewritten as tables. Proposals, audits and evaluations moved from `docs/` to `docs/design/` (with `security.md` renamed `security-audit.md`, `secrets.md` renamed `workload-secrets.md` and `swarm-comparison.md` moved), and `development.md` and `testing.md` to `docs/contributing/`. Renamed pages: `healthchecks.md` is now `health-checks.md` and `service-placement.md` is now `placement.md`.
