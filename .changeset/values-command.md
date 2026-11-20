---
'@wpelevator/tug': minor
---

Add `tug values`: one table of every `${NAME}` and bare `environment` key a Compose file references, with whether control holds it as a secret or a variable, falls back to the file's default, or is missing (the command then exits 1, so a script can gate on it). Secret values are never shown.
