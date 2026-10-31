# @wpelevator/tug

## 0.2.0

### Minor Changes

- a052d94: Extend `--install-docker` beyond Debian and Ubuntu to Fedora and RHEL-compatible hosts (RHEL, Rocky Linux, AlmaLinux and CentOS Stream 9/10) using Docker's official dnf repository. Unsupported distributions still stop with an instruction to install Docker manually.
- 367a340: Deploy built applications without provisioning a registry: control stores verified compressed image archives and agents download them with their existing credentials. Add local application builds with `deploy --build-local`, immutable deployment revisions, rollback-safe image retention and image-aware control backups.
  
  Add opt-in Docker Engine/Compose setup with `--install-docker`. Use flat command names such as `control-install`, `node-install` and `secret-set`, stricter argument validation, and shared CLI configuration precedence. Set `--agent-control-url` when agents need a different control address from the operator, such as with an SSH tunnel or private network.
  
  Ship the Docker Compose plugin inside the Tug runtime image so agents installed on real hosts can apply application Compose files without depending on host CLI plugins.
- 8c72d59: Add opt-in zero-downtime rolling rollouts: a service with `x-tug.rollout: { strategy: rolling, drain: 30s }`, an ingress and a health check starts each new revision next to the old one on its own host port (`TUG_ROLLOUT_PORTS` on the agent), switches the Caddy ingress once it is healthy and removes the old revision after the drain. A revision that fails its health check is removed and the old one keeps serving. `recreate` stays the default and behaves as before.
  
  Add `x-tug: { rollback: auto }` at the top level of a Compose file to roll a failed deployment back automatically to the previous succeeded one (recorded as a `deployment.auto_rollback` event, never applied to rollback deployments). Deployment versions starting with `rollback-` are now reserved.
- 3a87fef: Add named, scoped API tokens for CI and teammates: `token-create`, `token-list` and `token-revoke` manage `read`, `deploy` and `admin` tokens, optionally limited to projects and with an optional expiry. Tokens are stored hashed, shown once, revocable immediately and included in control backups; the operator token keeps full access. Deployments and control events (deploy, rollback, cancel, restart, secret and token changes) now record the acting token, shown by `tug events` (use `--all` for events outside the current project). Includes a documented GitHub Actions deploy workflow in the new access-control guide.

## 0.1.0

### Minor Changes

- c548ed5: First public release: the `tug` CLI and `tug-node` agent/control entrypoint are published to npm as `@wpelevator/tug`, and the matching Docker image to `ghcr.io/wpelevator/tug`. `control install`, `node install` and `node enroll` now default `--image` to the image for the CLI's own version; `--build-local-image` replaces the old build-and-copy default.
