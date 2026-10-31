---
"@wpelevator/tug": minor
---

Deploy built applications without provisioning a registry: control stores verified compressed image archives and agents download them with their existing credentials. Add local application builds with `deploy --build-local`, immutable deployment revisions, rollback-safe image retention and image-aware control backups.

Add opt-in Docker Engine/Compose setup with `--install-docker`. Use flat command names such as `control-install`, `node-install` and `secret-set`, stricter argument validation, and shared CLI configuration precedence. Set `--agent-control-url` when agents need a different control address from the operator, such as with an SSH tunnel or private network.

Ship the Docker Compose plugin inside the Tug runtime image so agents installed on real hosts can apply application Compose files without depending on host CLI plugins.
