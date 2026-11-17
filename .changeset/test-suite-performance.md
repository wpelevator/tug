---
'@wpelevator/tug': patch
---

Start faster: the CLI loads only the command it runs. The CLI now takes its environment, working directory, streams and signals from one runtime object instead of the process, which lets the test suite run commands in-process and take about half as long.
