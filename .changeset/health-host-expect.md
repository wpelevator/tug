---
'@wpelevator/tug': minor
---

Add `x-tug.health.host` and `x-tug.health.expect` for HTTP health checks of apps that serve virtual hosts. `host` sends a `Host` header (a WordPress multisite redirects every other name), and `expect` is the list of status codes that pass (default: any 2xx). Redirects are still not followed, but a redirect now fails as `http 301` with advice instead of `fetch failed (unexpected redirect)`, and `expect: [200, 301]` accepts it.
