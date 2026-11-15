# Nodes

Add a Docker host to tug, keep its certificate healthy, and replace or retire it.

```sh
tug node add root@app1.example.com --name app1 --address 10.0.0.11 --install-docker
tug node list
```

A node is a registered Docker host on which tug places services. The agent is the container on it that fetches work from control and manages the node's containers through the Docker Engine API. Nodes need Docker Engine only, with no Compose plugin, and so does the control host. Add a node by pushing an install over SSH, or let a fresh host enroll itself. Options for every `node` command are in the [CLI reference](cli.md#nodes).

| I want to | Command | Section |
| --- | --- | --- |
| Install an agent over SSH | `tug node add` | [Add a node](#add-a-node-over-ssh-node-add) |
| Install an agent on a host I cannot SSH to | `tug node enroll` | [Self-service enrollment](#self-service-enrollment-node-enroll) |
| Fix an expired or lost certificate | `tug node replace`, `tug node repair` | [Certificates](#certificates-renewal-and-recovery) |
| Cut a node off at once | `tug node disable` | [Certificates](#certificates-renewal-and-recovery) |
| Record my servers in the repo | `tug.yml` `nodes:` | [Declaring nodes](#declaring-nodes-in-the-config-file) |
| Upgrade an agent | `tug node upgrade` | [Image and upgrades](#image) |
| Change a node's address | `tug node address` | [Declaring nodes](#declaring-nodes-in-the-config-file) |
| Retire a node | `tug node remove` | [Migrating](migration.md#retire-a-host) |

## Node names and IDs

| | Name | ID |
| --- | --- | --- |
| Chosen by | You | Control, as `node_` followed by random hex |
| Used in | `x-tug.placement.nodes`, the CLI and the config file | The node's certificate (`tug:node:<id>`) and every control record: status, commands, backup schedules and volumes |
| Changes | Can be freed by `node remove` and reused | Never. Not derived from the name, unchanged when the identity is replaced, never reused |

A node created later with a freed name gets a new ID, so certificates issued for the removed node can never authenticate it, even with the same key, and leftover records of the removed node do not attach to it. `tug status` and `tug events` show IDs next to names where a record carries one.

## Add a node over SSH (`node add`)

```sh
tug node add root@app1.example.com --name app1 --address 10.0.0.11 --install-docker
```

The node generates its own key and certificate request. An admin credential authorizes the identity at that moment, and the certificate is installed back over SSH, so no bootstrap secret travels and the private key never leaves the node's state volume. The command runs these steps, and each is safe to repeat:

| Step | What happens |
| --- | --- |
| 1. Preflight | Fails early with a fix hint unless the host has Docker Engine accessible to the SSH user, at least 1024 MB free under Docker's data root (usually `/var/lib/docker`), and can open a TCP connection to the control port. It checks reachability only and copies no credential to the host |
| 2. State check | Refuses a host with unmigrated agent state, see [Moving agent state](#moving-agent-state-into-the-volume-node-migrate) |
| 3. Identity | Runs `agent identity` in a throwaway container that mounts the `tug-agent` volume and prints the CSR for the pending key (`agent-pending.json` in the volume) |
| 4. Authorize | Posts the CSR to `POST /api/v1/nodes/:name/identity` with `mode: create` |
| 5. Install | Pipes the response into `agent install-cert`, which checks that the certificate names this node, chains to the CA in the response and matches the pending key, then writes `agent.json` in the volume |
| 6. Start | Starts the agent container with the volume mounted |
| 7. Wait | Waits for a status report from the new identity. `--no-wait` skips it |

The install writes no file on the host, so a node is Docker plus the `tug-agent` volume. Rerunning after a partial failure reuses the pending key, and `create` with the identical key is an idempotent retry that keeps the first call's metadata. No secret appears in an SSH command line or log.

### The node address

`--address` is the node's only inter-node address. Other nodes and the ingress use it to reach services, service names resolve to it, and published ports bind to it ([Published ports](networking.md#published-ports-private-by-default)). Give a private IP on one of the host's interfaces, reachable from the other nodes that need it. Control rejects an address that is not an IP or a hostname without a port. tug does not create or encrypt this network, see [Bring your own network](networking.md#bring-your-own-network).

### Images and registries

Built application images are downloaded directly from control. Published images are pulled by their stored digest from upstream registries, with private credentials released through control when needed. No node registry login is required.

### Connecting through a tunnel

The global `--control-url` changes only where your CLI connects. When agents must dial a different address, pass `--agent-control-url`, which is written to the agent environment as `TUG_CONTROL_URL`. Both are connect targets only, both must be `https://`, and the server is verified by its generated control name:

```sh
tug --control-url https://127.0.0.1:18082 node add root@app1.example.com --name app1 --agent-control-url https://10.110.0.3:8443
```

### Small hosts

A 1 GB VPS is enough for one site (a database and WordPress together use a few hundred MB) and not for much else. Ubuntu's `unattended-upgrades` and `apt-check` can run for hours on such a host and starve Docker of memory and CPU until commands time out. During testing one pegged a 1 GB node at load 16. tug does not manage host updates, so schedule them for a quiet window or disable the timers (`systemctl disable --now apt-daily.timer apt-daily-upgrade.timer`) and patch deliberately. A control plane and a node on the same host also compete for port 8443 if a service publishes it, which is why the WordPress example is not meant to share a host with control until [M15](roadmap.md#m15--flexible-node-roles).

## Certificates, renewal and recovery

Node certificates last 90 days. The agent renews at two thirds of the lifetime plus up to ten percent random jitter. It sends a CSR for its existing key to `POST /agent/v1/renew`, saves the new certificate durably, then swaps its HTTP client and reconnects the stream. If renewal fails, it keeps working on the old certificate until that expires. Authorization follows the key, so old certificates stay valid until they expire and routine renewal closes no connection. Control enforces a minimum interval between renewals per node (`TUG_RENEW_MIN_INTERVAL_MS`, default one hour).

| Situation | Command |
| --- | --- |
| Cut a node off immediately, without SSH or deleting anything | `tug node disable <node>`. It also removes the node from service endpoints, ingress and label-based scheduling. Explicit `placement.nodes` entries are left alone |
| Certificate expired, key lost or suspected compromised, node disabled, CA lost, or an older backup restored | `tug node replace <node> [ssh-target]` installs a new key (`mode: replace`). The old key's certificates stop working at once and their sockets close |
| `agent.json` or `agent-pending.json` is corrupt | `tug node repair <node> [ssh-target]` moves the corrupt documents aside (never service volumes or agent event state) and replaces the identity |
| Every node after a CA loss or older restore | Recover root on the control host (`control setup --recover-root`), then `tug node replace --all` |
| Suspected key compromise | `node disable`, then `node replace` |

`node add --all` and `node replace --all` walk the SSH targets declared in `tug.yml` one node at a time, continue after failures and print a per-node result. `node remove` deletes the node (its ID is retired for good) and revokes any unconsumed join key. Moving services to new servers and retiring old nodes is in [Migrating to new servers](migration.md).

### Doctor: certificate expiry and clock skew

`tug doctor` reports the control CA and server certificate expiry and each node certificate's expiry.

| Check | Warns | Fails |
| --- | --- | --- |
| CA expiry | Under 90 days | Expired |
| Server certificate expiry | Under 30 days | Expired |
| Node certificate expiry | Under 14 days | Expired |
| Clock skew | 30 seconds or more | 5 minutes or more |

Agents send their clock with every status report and control records the difference. Doctor shows skew only for a node that is online now. A node that is stale, has never reported or is disabled has an unknown clock, not zero skew. The figure includes request latency. Five minutes fails because certificates are back-dated five minutes, and a node that far ahead or behind cannot validate new certificates, so fix time synchronization on the host.

## Declaring nodes in the config file

A repository can record its servers in the [config file](cli.md#config-file) so nobody has to remember `root@203.0.113.7`:

```yaml
# tug.yml
nodeDefaults:
  installDocker: true
nodes:
  app1:
    ssh: root@203.0.113.7
    address: 10.0.0.7
    label: [web, ingress]
```

`tug node add --name app1` (or `tug node replace app1`) then runs as if `root@203.0.113.7 --address 10.0.0.7 --label web --label ingress --install-docker` had been typed. `tug node register app1` and `tug node enroll --name app1` read the same entry.

| Rule | Behavior |
| --- | --- |
| Precedence | Explicit flags, then the node entry, then `nodeDefaults`, then command defaults. This holds for every supported key, including `image`, `agentControlUrl` and `installDocker`, and `false` and empty lists stay explicit values. A `label` list on the command line replaces the file's list |
| SSH target | An `<ssh-target>` argument overrides `ssh`. Without one, a node with no `ssh` in the file is an error that names the missing key. The argument is never guessed to be a node name, because `app1` is also a valid hostname |
| `nodeDefaults` | Apply to every node, declared or not |
| Source of truth | Control. Only `node add`, `replace`, `repair`, `migrate`, `register` and `enroll` read `nodes`, as flag defaults. `status`, `deploy`, `scale`, `ps`, `logs`, `exec`, `node remove` and every other command ask control. Editing the file without re-running anything changes nothing |
| Re-running | `node add` with the same key is an idempotent retry that keeps the first call's metadata. `node replace` installs a new key and keeps the node's ID, metadata and placement, and updates `address` when `--address` is given, with the same validation as registration |

To change a registered node's address, run `tug node address app1 10.0.0.12`. Control wakes the agents so port bindings and service endpoints converge on it. The address must already be on the node and reachable by its peers.

## Self-service enrollment (`node enroll`)

For hosts you cannot SSH to or do not want to touch: cloud-init and user-data provisioning, autoscaling and golden images, hosts behind NAT or on private networks, and onboarding by someone without admin credentials. Mint a join key with an admin credential, then run the printed `docker run` on the fresh host or put it in user-data. The agent dials out to control.

```sh
tug node enroll --name app1 --address 10.0.0.11
```

It prints a command like this one:

```text
docker run -d --name tug-agent --restart unless-stopped \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v tug-agent:/var/lib/tug \
  -e TUG_JOIN_KEY=<key> -e TUG_NODE_ADDRESS=10.0.0.11 \
  ghcr.io/wpelevator/tug:<CLI version> agent
```

Options are in the [CLI reference](cli.md#node-enroll). Without `--address`, set `TUG_NODE_ADDRESS` on the agent before its first enrollment if you need cross-node networking.

To keep the key out of shell history and `docker inspect`, mount it as a `0600` file and set `TUG_JOIN_KEY_FILE=/path/to/key` instead of `TUG_JOIN_KEY`. Without an identity or a join key, the agent refuses to start and points to `tug node add`, `tug node enroll` or `tug node repair`.

### How the join key works

The join key (`TUG_JOIN_KEY`) is base64url-encoded JSON `{ v: 2, credential, name, connectUrl? }`. The credential is a bootstrap certificate with SAN `tug:enroll:<id>` and its private key, and it can reach `POST /agent/v1/enroll` and nothing else. The agent generates its own node key (into `agent-pending.json`), sends a CSR with the bootstrap certificate, installs the returned node certificate exactly as `agent install-cert` does, and from then on ignores the join key. On restart it loads `/var/lib/tug/agent.json` and skips enrollment.

| Property | Behavior |
| --- | --- |
| Single use, name-bound, short-lived | Default one hour. There is no `--uses` and no reusable or unbound key, so golden-image and autoscaling flows mint one key per instance, for example into each instance's cloud-init |
| Name and labels | Come from the control-side row, never from the join key or the request |
| Create-only | An existing name is refused, and a join key can never replace a node |
| Retry | A retry with the same CSR key after a lost response signs another certificate and changes nothing stored |
| Reminting | Minting again for a name revokes its previous unconsumed key, and `node remove` revokes it too |

The join key is an enrollment credential and as sensitive as any bootstrap secret. It contains a private key, a saved user-data document contains a credential, and in cloud user-data it may be readable from the provider's metadata service by processes on the host. Single use, short life, name binding and create-only enrollment limit the damage.

## Bare-host Docker installation

`control setup --install-docker` and `node add --install-docker` run the same Docker bootstrap over SSH before Docker preflight or runtime-image transfer. Without the flag, Docker Engine must already work on the control host and on nodes. The SSH target must be root for installation. tug does not change group membership or configure passwordless sudo.

For a host your cloud provider creates, save `tug node enroll --name app1 --address 10.0.0.11 --install-docker` as user-data. Its stdout starts with `#cloud-config`, includes the bootstrap script and starts the agent only after Docker installation succeeds. The version-matched tug runtime image must be reachable from the host, and an overridden development `tug:local` image must already be loaded there. Treat a saved user-data document as a credential.

Bootstrap requires systemd and supports:

| Family | Releases | Docker repository |
| --- | --- | --- |
| Debian (apt) | 12 `bookworm`, 13 `trixie` | [Debian](https://docs.docker.com/engine/install/debian/) |
| Ubuntu (apt) | 22.04 `jammy`, 24.04 `noble`, 26.04 `resolute`, 26.10 `stonking` | [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) |
| Fedora (dnf) | 42, 43, 44 | [Fedora](https://docs.docker.com/engine/install/fedora/) |
| RHEL (dnf) | 9, 10 | [RHEL](https://docs.docker.com/engine/install/rhel/) |
| Rocky Linux, AlmaLinux, CentOS Stream (dnf) | 9, 10 | [CentOS](https://docs.docker.com/engine/install/centos/) |

It adds Docker's official apt or dnf repository, installs Engine and Buildx, and enables Docker. A working Engine installation is preserved. An inaccessible existing daemon, an unsupported OS or release, or conflicting distribution packages (`docker.io` and `podman-docker` on Debian and Ubuntu, `docker`, `moby-engine` and `podman-docker` on RPM hosts) produce an error for manual resolution. tug removes nothing and leaves Docker daemon trust settings alone. Other distributions such as Alpine or Arch, and hosts without systemd, need Docker installed manually.

**Retries and logs.**

- **Retries.** Downloads and package commands make up to five attempts with a growing pause of 5, 10, 15 and 20 seconds. A step that gives up keeps the failing command's exit status. Running the script by hand with `TUG_BOOTSTRAP_RETRIES` and `TUG_BOOTSTRAP_RETRY_DELAY` set changes the count and base pause, but `node add` and the generated cloud-init do not pass them.
- **Waits.** apt waits up to five minutes for the dpkg lock that unattended upgrades hold on a fresh image, and each download waits at most two minutes.
- **Progress.** Each stage prints a `tug-bootstrap:` line to stderr (in cloud-init, `/var/log/cloud-init-output.log` and the serial console). A failure ends with `tug-bootstrap: failed during: <stage> (exit <code>)`, so a node that never appears can be traced to the step that stopped it. The stages are checking for conflicting packages, adding the Docker apt or dnf repository, installing Docker Engine, starting Docker and verifying Docker.
- **Consoles.** Ubuntu and Fedora images echo this to the serial console. At least the Alpine 3.24 cloud image writes it only to `/var/log/cloud-init-output.log`, so there the console shows nothing and you need SSH to read the log.

## Image

`node add` and `node enroll` default `--image` to `ghcr.io/wpelevator/tug:<version>`, where `<version>` is the installed CLI's own version, so the CLI and the agents it installs stay on one release. Pass `--image <tag>` for another image, for example `ghcr.io/wpelevator/tug:edge` for the latest build of `main`, or a mirror in your own registry.

### Upgrade an agent

```sh
tug node upgrade app1
tug node upgrade --all
```

Run it after a control upgrade. `tug upgrade` does both in order, see [Upgrade control and nodes](upgrades.md).

| Behavior | Detail |
| --- | --- |
| What changes | The install script replaces the `tug-agent` container at the new image and reuses the host's installed key (`agent identity --current <name>`), so control treats it as an idempotent retry. The node record, address, labels and ingress role stay, no key changes, and the connect-only control URL and any custom rollout port range carry over from the running agent |
| Refused | A node control does not know (`node add` enrolls it), and `--to` a version newer than control |
| Skipped | A node already on the target image. `--force` reinstalls |
| `--all` | Walks the nodes declared in `tug.yml` one at a time and continues after failures. This is the usual fleet upgrade |
| Order | Control and its agents exchange version declarations on every request. An agent declaring a version on a newer compatibility key than control (a newer major, or a newer `0.minor` before 1.0) is refused by control itself. Upgrade control first, then the agents, and confirm each node reports `online` in `tug status` |
| `node add` again | `tug node add <ssh-target> --name <name>` does the same replacement without the checks. A host already enrolled as a different node name is refused with a hint, because two nodes must never share a key. A host whose saved identity no longer matches the node in control (the state volume was replaced or reset) is refused with a hint to use `tug node replace`. `node replace` and `node repair` always rotate the key |

`node add --build-local-image` is for development. It builds the image from the current checkout (a tug checkout with the Dockerfile must be in the working directory), copies it to the host with `docker save`, `scp` and `docker load`, and runs it tagged `tug:local` unless `--image` is given, plus the image ID (for example `tug:local-a17ed756592c`), so rebuilding never leaves a running container pointing at a moved tag. The image is built for the target host's architecture, read with `uname -m` over SSH, so an arm64 laptop can install an amd64 VPS. x86_64 and aarch64 hosts are supported. See [Releases](releases.md) for how images are published.

## Moving agent state into the volume (`node migrate`)

A node installed by an earlier release keeps the agent's state in the host directory `/var/lib/tug` and its settings in `/etc/tug/agent.env`. Since then the state lives in the `tug-agent` volume and nothing is written to the host. `node add`, `node replace` and `node repair` refuse such a host with a hint to run `tug node migrate <node>`, because a new install would start the agent on an empty volume and control would refuse a fresh key for a node it already knows.

```sh
tug node migrate app1
tug node migrate --all
```

It reads the target like `node replace` (`<ssh-target>` or `nodes.<name>.ssh`, `--all`, `--select`). Per node it:

1. Stops the old agent, never removing it.
2. Copies the directory into the volume as root, so modes, `agent.json` and the SQLite `-wal` and `-shm` files carry over.
3. Writes a version marker into the volume last.
4. Reinstalls the agent at the CLI's version with the same key, so control sees an ordinary upgrade of the same node, and waits for it to report.

If the copy fails, the old agent starts again. A volume without the marker is cleared and copied again, except one that already holds a different identity, which is never overwritten. A connect-only control URL kept in `/etc/tug/agent.env` is carried over as `TUG_CONTROL_URL` unless `--agent-control-url` is given. Tuning variables you set by hand in `agent.env` are not carried over. Rerunning after a failure is safe. The old `/var/lib/tug` and `/etc/tug` stay on the host as a fallback and are not used again, so remove them once the node reports `online`. `node remove --teardown` removes them too.

## Node labels

`node add`, `node enroll` and `node register` accept a repeatable `--label <label>`, or a comma-separated list, so a label cannot contain a comma. Labels are plain string tags stored on the node and listed by the node list API. Services select nodes that carry all of their `x-tug.placement.labels` ([Compose extensions](compose.md#service-x-tug-keys)). They are set when the node is created (`node add`, `node register --mode create` or the enrollment credential), and `node replace` keeps them. They are unrelated to Docker container labels.

## Agent host networking

The agent always runs with host networking (`--network host`), because it dials container IPs directly for TCP and HTTP health checks, which a bridge-networked agent cannot reach on current Docker (29.x). On Docker Desktop the daemon and container addresses live inside its VM, which is why the agent belongs in a container on that daemon rather than in a plain host process. Host networking needs no added Linux capability. Inter-node workload reachability belongs to your network, see [Networking](networking.md#bring-your-own-network).

## Register a CSR (`node register`)

`tug node register <name> --csr node.csr [--mode create|replace]` is the primitive behind the SSH commands. It posts a CSR you generated on the node (for example with `agent identity`) to the identity endpoint and prints the certificate, CA and public URL. Use it for local development or when you drive the steps yourself, and install the output with `agent install-cert`.

## Status and diagnostics

| State | Meaning |
| --- | --- |
| `online` | The node contacted control within `TUG_STALE_SECONDS` (default `60`) |
| `stale` | No authenticated work fetch, status report or wake wait for `TUG_STALE_SECONDS`. This does not prove the machine is off |

Agents keep an outbound WebSocket open so control can wake them for deployments and commands. If WebSockets are unavailable they use an HTTP long poll, and `TUG_POLL_INTERVAL_MS` stays as the periodic reconciliation fallback. `tug status` lists nodes, deployments and per-node project status. `tug doctor --nodes` (or `--node <name>`) runs Docker Engine checks, host resources (load, memory, free disk, agent and Caddy container CPU and memory), plus Caddy checks on ingress nodes, through each agent and waits up to 60 seconds for the result. Agent environment variables are in [Configuration](configuration.md#agent).
