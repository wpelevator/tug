---
'@wpelevator/tug': minor
---

`x-tug.ingress.host` accepts a list of hostnames as well as one: every name shares the route's upstreams and TLS mode (with `tls: custom` one certificate must cover them all), the first is the primary, and each name is checked for uniqueness and cross-project ownership like a single host. A single string behaves exactly as before, and domains added with `tug domain add` still join the route beside the declared names, always with automatic HTTPS.
