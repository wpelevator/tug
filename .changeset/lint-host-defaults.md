---
'@wpelevator/tug': patch
---

`tug lint` no longer rejects `x-tug.ingress.host: ${APP_HOST:-app.example.com}`: it checks the default as the hostname, and skips the check when the host depends on a value that has no default.
