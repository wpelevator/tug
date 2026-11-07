---
'@wpelevator/tug': patch
---

Re-running `tug node add` on a host that is already enrolled now upgrades its agent in place, as the documentation says: the agent's installed key is reused, so control treats the request as an idempotent retry instead of refusing it with `409 node already exists`. A host enrolled under a different node name is refused with a hint, and `tug node replace` and `tug node repair` still rotate the key.
