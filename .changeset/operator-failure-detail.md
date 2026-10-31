---
"@wpelevator/tug": patch
---

Failed deploys now include the node apply error and any rollout error in the message `tug deploy` prints, instead of only "failed health". `tug logs` and `tug restart` name the project when the service is missing. `tug doctor --node` and `--nodes` wait for the agent result.
