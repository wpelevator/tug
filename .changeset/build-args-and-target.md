---
'@wpelevator/tug': patch
---

Pass `build.args` and `build.target` to the image build. They were parsed and then dropped, so an image built from a Compose file with build arguments or a multi-stage target differed from the one `docker compose build` makes. A `build:` key Tug does not pass on (such as `cache_from`) now prints a warning at deploy instead of being ignored silently.
