---
'@wpelevator/tug': minor
---

Remove the `x-tug.type: nfs` volume type and its `x-tug.address` and `x-tug.export` keys. Tug never ran the NFS server, so users prepared the exporter anyway; mount a file server you operate with plain Compose `driver: local` and `driver_opts` instead. Backup validation no longer has an NFS exporter rule.
