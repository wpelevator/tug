---
'@wpelevator/tug': minor
---

Make the credential that `tug credential create` prints usable as `TUG_CREDENTIAL` as it is: the JSON output (with its `credential` field) is now accepted next to the bare token, and `tug credential create <name> --raw` prints only the token on standard output, so `tug credential create ci --role deploy --raw | gh secret set TUG_CREDENTIAL` stores it without copying anything.
