---
'@wpelevator/tug': patch
---

Document what a rolling rollout covers: it switches one service, so a recreated service behind it, such as PHP-FPM behind a rolling nginx, can answer errors while it restarts. Add the one-image recipe for PHP sites, and retitle the rolling milestone in the roadmap.
