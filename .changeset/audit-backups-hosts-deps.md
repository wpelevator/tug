---
'@wpelevator/tug': patch
---

Create control backup directories as `0700` and archives as `0600`, removing staging key material when a backup fails; `control-install` now creates the control data directory as `0700`. Refuse a deploy or rollback that claims an ingress hostname another project already routes. Update `multer`, `js-yaml`, `tar`, `express`'s `qs` and `proxy-addr` to patched versions.
