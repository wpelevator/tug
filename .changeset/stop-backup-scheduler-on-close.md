---
'@wpelevator/tug': patch
---

Control's backup scheduler now stops when the server closes and after a control restore closes the database, instead of logging `backup scheduler failed: database is not open` on every tick until restart.
