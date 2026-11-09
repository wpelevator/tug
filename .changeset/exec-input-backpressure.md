---
'@wpelevator/tug': patch
---

`tug exec -i` no longer fails by itself once more than 1 MiB of input is piped in: the CLI now stops reading its input while a bounded amount is waiting to be sent, instead of queueing all of it and then failing with `stdin exceeded the live session buffer limit`. Large input still does not get through end to end: control and the agent each keep their own buffer limit and fail with `agent buffer limit exceeded` when the command consumes input slower than it arrives. Acknowledging consumed input across those hops is the remaining work.
