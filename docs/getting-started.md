# Getting started

This walks from nothing to a deployed Compose project: install the control plane, add a node, deploy. You need a machine to run the control plane, at least one more Docker host to run workloads (they can be the same machine for a trial), SSH access as root or a user with Docker rights, and the `tug` CLI on your laptop or CI runner.

```bash
npm install -g @wpelevator/tug   # Node >= 22.18; or use `npx @wpelevator/tug`
```

The CLI installs the matching `ghcr.io/wpelevator/tug:<version>` image on your hosts. Nodes need Docker Engine only. Add `--install-docker` to any install command to have Tug install Docker on a supported Debian, Ubuntu, Fedora or RHEL-compatible host first.

## How access works

Everything that talks to the control plane uses a client certificate: you, CI and every node. There are no API tokens and no passwords.

- Installing the control plane creates a private certificate authority (CA) on that host and issues you a **root credential**, a file containing the CA, a certificate and a private key.
- The CA also gives control a generated **control name** (`control-<hash>.tug`). Clients verify that name, so verification does not depend on the address you dial. You can use a bare IP, change the IP later, or connect through an SSH tunnel without issuing new credentials.
- Control serves mutual TLS directly on one port (default `8443`). Do not put a TLS-terminating proxy in front of it; TCP passthrough is fine.

## 1. Install the control plane

```bash
tug setup root@203.0.113.5
```

`tug setup` is short for `tug control setup`. In a terminal it checks for Docker, offers to install it when missing, prints its plan and asks to confirm; pass `--install-docker` and `-y` to do the same without questions, for example in a script.

Clients need a reachable address for control. `control setup` uses `controlUrl` from the CLI config file, including any overlay override; `--config <file>` selects a file. Without it, the command takes the SSH target and the published port (here `https://203.0.113.5:8443`) and prints that default. Pass `--control-url https://control.example.com:8443` when clients should use a different address, for example a DNS name or an SSH alias that only resolves on your machine. It can be an IP or a DNS name. It is written into each credential as the default connect address and added to the server certificate, but it is not the identity: if the address changes you update the setting and clients can override it (see [Moving the control plane](#moving-the-control-plane)). Add `--extra-san <name-or-ip>` for other addresses clients might use, and `--port` to publish a different port.

The command checks the host (Docker, free disk, free port), starts the control container and imports the root credential: it creates `tug.yml` (commit it; it lists your servers and defaults), copies the credential to a `0600` file under `~/.config/tug/credentials/` and points the git-ignored `tug.local.yml` at it. The credential is full admin access, so keep that file safe. Add `--credential-out <file>` to also save a copy, or `--no-import --credential-out <file>` to only save it (to import it elsewhere with `tug init <file>`). Running the same command later upgrades control in place and does not issue a new root credential.

## 2. Check the connection

```bash
tug status
```

In CI, set `TUG_CREDENTIAL` (the encoded credential) or `TUG_CREDENTIAL_FILE` instead of importing a credential.

## 3. Add a node

If you can SSH to the host:

```bash
tug node add root@198.51.100.7
```

The node name defaults to the first DNS label of the SSH host (`app1` for `root@app1.example.com`); give `--name` when you connect by IP address. In a terminal the command checks for Docker and offers to install it, lists the host's IPv4 addresses (private ones first) to choose the inter-node address from, asks whether the node should handle ingress and shows a plan to confirm before it changes anything. In a script, say it all explicitly: `tug node add root@198.51.100.7 --name app1 --address 10.0.0.7 --install-docker --ingress -y`. List the registered nodes with `tug node list`.

The node generates its own private key, your admin credential authorizes it, and the signed certificate is installed back over SSH. `--address` is the node's private inter-node IP on your existing network; other nodes and ingress upstreams use it, and Tug binds published ports to it. It must be reachable from nodes that need cross-node service traffic. The command waits for the node's first report. It is safe to run again after a failure.

If you cannot SSH to it (cloud-init, autoscaling, a host behind NAT), prepare an enrollment credential and run the printed command on the host:

```bash
tug node enroll --name app1 --address 10.0.0.11                  # prints a docker run
tug node enroll --name app1 --address 10.0.0.11 --install-docker # prints cloud-init user-data
```

The join key inside is single-use, bound to the node name and valid for one hour. Mint one per instance, and treat saved user-data as a secret.

Agents only dial out to control, so the control channel works through NAT. Cross-node workload traffic is separate: service names and remote ingress upstreams require reachable private node `address` values on your network, and Tug does not encrypt that traffic. Check with `tug status`; a node that is reporting shows a recent `last_seen_at`.

## 4. Deploy

Add the node to the service's placement in your Compose file:

```yaml
services:
  web:
    image: nginx:alpine
    x-tug:
      placement:
        nodes: [app1]
```

```bash
tug secret set DB_PASSWORD        # optional: `tug deploy` prompts for missing secrets in a terminal
tug deploy -f docker-compose.yml
```

`deploy` waits until every placed node reports the new revision healthy. Then use `tug status`, `logs`, `exec`, `ps`, `rollback`, `backup run` and `doctor`. See [Compose extensions](compose.md) for placement, health checks, rollouts, ingress and backups.

## 5. Give CI and teammates their own credentials

```bash
tug credential create ci-site --role deploy --project site
```

It prints the credential once and control keeps no copy of the private key. Store it as `TUG_CREDENTIAL` in your CI secrets. Credentials last at most a year. To replace one, create a new name, verify it, update consumers, then `tug credential revoke` the old name. See [Access control](access-control.md).

## Moving the control plane

Because clients verify the generated control name, the address is only a default:

1. Move or re-address the host and set the new `TUG_CONTROL_URL` on control (or rerun `control setup` with the new `--control-url`). Control adds the new address to its certificate on restart.
2. Until credentials are refreshed, point clients at the new address: `tug --control-url https://NEW:8443 ...` or `TUG_CONTROL_URL`, and for an agent set `TUG_CONTROL_URL` in `/etc/tug/agent.env`.
3. Optionally reissue credentials so they carry the new default: `control setup --recover-root` for root, `credential create` for others, `node replace` for nodes.

No credential becomes invalid because the address changed. The control name only changes if the CA itself is replaced, which requires redistributing every credential.

## Lost or compromised something

| Situation | What to do |
| --- | --- |
| Lost the root credential | `tug control setup <ssh-target> --recover-root` |
| A CI credential leaked | `tug credential revoke <name>`; live sessions close within a second |
| A node is suspect | `tug node disable <node>` now, then `tug node replace` |
| A node's identity is corrupt or expired | `tug node repair` or `tug node replace` |
| Restored an older control backup | Recover root if needed, reapply revocations, then `node replace --all` ([Control plane](control-plane.md#backups-and-authorization-history)) |

## Next steps

- [Control plane](control-plane.md): mutual TLS, the CA, backups and restore of control itself.
- [Nodes](nodes.md): certificates, renewal, enrollment and recovery in detail.
- [Networking](networking.md): your private inter-node network, cross-node service names and ingress.
- [Backups](backups.md): scheduled workload backups with restic.
- [CLI reference](cli.md) and [Configuration](configuration.md).
