---
'@wpelevator/tug': patch
---

The published `ghcr.io/wpelevator/tug` image is now based on Alpine instead of Debian, roughly halving its size (about 87 MB compressed instead of 159 MB). It ships only the Docker CLI rather than the full Docker Engine package.
