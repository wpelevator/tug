---
"@wpelevator/tug": minor
---

Add named, scoped API tokens for CI and teammates: `token-create`, `token-list` and `token-revoke` manage `read`, `deploy` and `admin` tokens, optionally limited to projects and with an optional expiry. Tokens are stored hashed, shown once, revocable immediately and included in control backups; the operator token keeps full access. Deployments and control events (deploy, rollback, cancel, restart, secret and token changes) now record the acting token, shown by `tug events` (use `--all` for events outside the current project). Includes a documented GitHub Actions deploy workflow in the new access-control guide.
