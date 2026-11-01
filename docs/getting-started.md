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
tug control-install root@203.0.113.5 --advertise-url https://203.0.113.5:8443 --install-docker
```

`--advertise-url` is the address clients should connect to by default, as an `https://` origin including the port. It can be an IP or a DNS name. It is written into each credential as the default connect address and added to the server certificate, but it is not the identity: if the address changes you update the setting and clients can override it (see [Moving the control plane](#moving-the-control-plane)). Add `--extra-san <name-or-ip>` for other addresses clients might use, and `--port` to publish a different port.

The command checks the host (Docker, free disk, free port), starts the control container and writes the root credential to `tug-root.credential.json` on your machine with mode `0600`. Keep it safe; it is full admin access. Running the same command later upgrades control in place and does not issue a new root credential.

## 2. Import the credential

```bash
tug init tug-root.credential.json
```

This creates `tug.yml` (commit it; it lists your servers and defaults), copies the credential to `~/.config/tug/credentials/` and points the git-ignored `tug.local.yml` at it. Check the connection:

```bash
tug status
```

In CI, set `TUG_CREDENTIAL` (the encoded credential) or `TUG_CREDENTIAL_FILE` instead of running `tug init`.

## 3. Add a node

If you can SSH to the host:

```bash
tug node-install root@198.51.100.7 --name app1 --address 198.51.100.7 --install-docker
```

The node generates its own private key, your admin credential authorizes it, and the signed certificate is installed back over SSH. The command waits for the node's first report. It is safe to run again after a failure.

If you cannot SSH to it (cloud-init, autoscaling, a host behind NAT), prepare an enrollment credential and run the printed command on the host:

```bash
tug node-prepare-enrollment --name app1                  # prints a docker run
tug node-prepare-enrollment --name app1 --install-docker # prints cloud-init user-data
```

The join key inside is single-use, bound to the node name and valid for one hour. Mint one per instance, and treat saved user-data as a secret.

Agents only dial out to control, so nodes behind NAT work. Check with `tug status`; a node that is reporting shows a recent `last_seen_at`.

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
tug secret-set DB_PASSWORD        # only if your services use @@tug:secret:NAME@@
tug deploy -f docker-compose.yml
```

`deploy` waits until every placed node reports the new revision healthy. Then use `tug status`, `logs`, `exec`, `ps`, `rollback`, `backup-run` and `doctor`. See [Compose extensions](compose.md) for placement, health checks, rollouts, ingress and backups.

## 5. Give CI and teammates their own credentials

```bash
tug credential-create ci-site --role deploy --project site
```

It prints the credential once and control keeps no copy of the private key. Store it as `TUG_CREDENTIAL` in your CI secrets. Credentials last at most a year. To replace one, create a new name, verify it, update consumers, then `tug credential-revoke` the old name. See [Access control](access-control.md).

## Moving the control plane

Because clients verify the generated control name, the address is only a default:

1. Move or re-address the host and set the new `TUG_ADVERTISE_URL` on control (or rerun `control-install` with the new `--advertise-url`). Control adds the new address to its certificate on restart.
2. Until credentials are refreshed, point clients at the new address: `tug --control-url https://NEW:8443 ...` or `TUG_CONTROL_URL`, and for an agent set `TUG_CONTROL_URL` in `/etc/tug/agent.env`.
3. Optionally reissue credentials so they carry the new default: `control-install --recover-root` for root, `credential-create` for others, `node-replace-identity` for nodes.

No credential becomes invalid because the address changed. The control name only changes if the CA itself is replaced, which requires redistributing every credential.

## Lost or compromised something

| Situation | What to do |
| --- | --- |
| Lost the root credential | `tug control-install <ssh-target> --advertise-url ... --recover-root` |
| A CI credential leaked | `tug credential-revoke <name>`; live sessions close within a second |
| A node is suspect | `tug node-disable <node>` now, then `tug node-replace-identity` |
| A node's identity is corrupt or expired | `tug node-repair-identity` or `tug node-replace-identity` |
| Restored an older control backup | Recover root if needed, reapply revocations, then `node-replace-identity --all` ([Control plane](control-plane.md#backups-and-authorization-history)) |

## Next steps

- [Control plane](control-plane.md): mutual TLS, the CA, backups and restore of control itself.
- [Nodes](nodes.md): certificates, renewal, enrollment and recovery in detail.
- [Networking](networking.md): the WireGuard mesh, cross-node service names and ingress.
- [Backups](backups.md): scheduled workload backups with restic.
- [CLI reference](cli.md) and [Configuration](configuration.md).
