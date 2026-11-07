---
'@wpelevator/tug': patch
---

Control no longer stores a new full image archive for every deploy. A rebuild that produces the image the project already has an archive for reuses that archive, so nodes download nothing and the container is not recreated. After each successful deploy control also prunes archives beyond the newest `TUG_IMAGE_KEEP` (default 5, `0` turns it off) distinct builds per project and caps the Docker build cache at `TUG_BUILD_CACHE_KEEP` (default `10GB`, `0` turns it off), so disk use no longer grows until someone runs `tug image prune`. Nodes now drop the images of pruned archives too, once no container uses them.
